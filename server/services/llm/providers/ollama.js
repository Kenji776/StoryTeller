/**
 * Ollama provider adapter.
 *
 * The local-model case. Ollama runs on the player's own machine or LAN, so
 * there is usually no key and the address matters more than the vendor. It
 * exposes its own API rather than the OpenAI one: `/api/chat` for generation
 * and `/api/tags` for the list of models actually pulled onto the machine.
 *
 * Ollama does offer an OpenAI-compatible surface too, and the generic
 * compatible adapter would partly work against it — but `/api/tags` is the only
 * way to see what is installed locally, which is exactly what a player needs
 * when choosing a model.
 */

import { requestJson } from "../http.js";
import { LLMRequestError } from "../errors.js";

const PROVIDER_ID = "ollama";

/**
 * @description Builds request headers. Ollama is normally unauthenticated, but
 *   an instance published beyond localhost often sits behind an auth proxy, so
 *   an optional key is honoured when one is configured.
 * @param {object} config - Normalized provider configuration.
 * @returns {object} Headers for the request.
 */
function headersFor(config) {
	return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

/**
 * @description Sends a chat request to an Ollama instance.
 * @param {object} options - Call options.
 * @param {Array<object>} options.messages - Conversation in internal format.
 * @param {object} options.config - Normalized provider configuration.
 * @param {string} [options.model] - Model override; defaults to `config.model`.
 * @param {boolean} [options.json=false] - Constrain output to JSON.
 * @param {number|null} [options.temperature=null] - Sampling temperature.
 * @param {number|null} [options.maxTokens=null] - Mapped onto `num_predict`.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} With kind "bad_request" when no messages or no model
 *   were supplied, "bad_response" when the reply carries no content, or a
 *   transport/status-derived kind propagated from the HTTP layer.
 */
async function chat({ messages, config, model, json = false, temperature = null, maxTokens = null, signal, fetchImpl }) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new LLMRequestError("An Ollama request needs at least one message.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const resolvedModel = model || config?.model;
	if (!resolvedModel) {
		throw new LLMRequestError("No Ollama model has been selected.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const body = {
		model: resolvedModel,
		// Ollama streams by default, which arrives as newline-delimited JSON and
		// would not parse as a single object.
		stream: false,
		messages: messages.map(({ role, content }) => ({ role, content: content ?? "" })),
	};
	if (json) body.format = "json";

	// Sampling parameters are nested under `options`, not set at the top level.
	const modelOptions = {};
	if (Number.isFinite(temperature)) modelOptions.temperature = temperature;
	if (Number.isFinite(maxTokens)) modelOptions.num_predict = maxTokens;
	if (Object.keys(modelOptions).length > 0) body.options = modelOptions;

	const response = await requestJson(`${config.baseUrl}/api/chat`, {
		provider: PROVIDER_ID,
		method: "POST",
		headers: headersFor(config),
		body,
		signal,
		fetchImpl,
	});

	const text = response?.message?.content;
	if (typeof text !== "string" || text === "") {
		throw new LLMRequestError("Ollama returned no usable content.", {
			provider: PROVIDER_ID,
			kind: "bad_response",
		});
	}

	const hasUsage = Number.isFinite(response.prompt_eval_count) || Number.isFinite(response.eval_count);
	return {
		text,
		model: resolvedModel,
		finishReason: response.done_reason ?? null,
		usage: hasUsage
			? { inputTokens: response.prompt_eval_count ?? null, outputTokens: response.eval_count ?? null }
			: null,
	};
}

/**
 * @description Lists the models actually installed on the instance. Unlike a
 *   hosted provider this is a list of what has been pulled, so an empty result
 *   is a normal state meaning "nothing downloaded yet" — but an unreachable
 *   instance is reported as a failure, because an empty dropdown and a dead
 *   server are very different problems for the player to solve.
 * @param {object} options - Call options.
 * @param {object} options.config - Normalized provider configuration.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<Array<{id: string, label: string}>>} Installed models.
 * @throws {LLMRequestError} When the instance cannot be reached.
 */
async function listModels({ config, signal, fetchImpl }) {
	const response = await requestJson(`${config.baseUrl}/api/tags`, {
		provider: PROVIDER_ID,
		headers: headersFor(config),
		signal,
		fetchImpl,
	});

	const entries = Array.isArray(response?.models) ? response.models : [];
	return entries
		.map(entry => entry?.model || entry?.name)
		.filter(Boolean)
		.map(id => ({ id, label: id }));
}

export const ollamaProvider = {
	id: PROVIDER_ID,
	label: "Ollama (local)",
	requiresApiKey: false,
	requiresBaseUrl: true,
	defaultBaseUrl: "http://localhost:11434",
	supportsImages: false,
	keyUrl: null,
	chat,
	listModels,
};
