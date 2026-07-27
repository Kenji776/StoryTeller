/**
 * The OpenAI chat-completions wire format, shared by every provider that speaks
 * it: OpenAI proper and the generic compatible adapter that fronts OpenRouter,
 * Groq, Together, vLLM, LM Studio, and most self-hosted gateways.
 *
 * The differences between those providers are narrow enough to be parameters
 * rather than separate implementations — whether a key is sent, whether message
 * `name` fields survive, and what to do with the model list once it arrives.
 * Everything else is identical, and duplicating it once per gateway would mean
 * fixing every response-shape bug several times.
 *
 * This module is internal to the adapters; its behaviour is covered through
 * `openai.test.js` and `openaiCompatible.test.js` rather than directly, because
 * the adapters are the contract callers actually depend on (TDD-6).
 */

import { requestJson } from "../http.js";
import { LLMRequestError } from "../errors.js";

/** OpenAI's limit on the `name` field of a message. */
export const OPENAI_NAME_MAX = 64;

/**
 * @description Reduces a display name to the identifier shape OpenAI accepts
 *   for a message `name`: letters, digits, underscore, and hyphen only.
 * @param {string} name - The player's display name.
 * @returns {string} A safe identifier, never empty, at most 64 characters.
 */
export function sanitizeForLLMName(name) {
	if (!name || typeof name !== "string") return "Player";
	// A single pass suffices: replacing everything that is not a letter, digit,
	// underscore, or hyphen already subsumes whitespace, punctuation, quotes,
	// slashes, and control characters.
	let s = name.normalize("NFKC");
	s = s.replace(/[^\p{L}\p{N}_-]/gu, "_");
	s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	if (!s) s = "Player";
	return s.slice(0, OPENAI_NAME_MAX);
}

/**
 * @description Builds authorization headers, omitting them entirely when no key
 *   is configured. Sending an empty bearer token to an unauthenticated local
 *   endpoint is a reliable way to get a confusing 401 from a server that would
 *   otherwise have worked.
 * @param {string|null} apiKey - The configured key, if any.
 * @returns {object} Headers to merge into the request.
 */
function authHeaders(apiKey) {
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * @description Converts internal messages into the wire format.
 * @param {Array<{role: string, content: string, name?: string}>} messages - Internal messages.
 * @param {boolean} includeNames - Whether to carry `name` through. OpenAI proper
 *   accepts it; a large share of compatible gateways reject it with a 400.
 * @returns {Array<object>} Messages ready to send.
 */
function toWireMessages(messages, includeNames) {
	return messages.map(({ role, content, name }) => {
		const wire = { role, content: content ?? "" };
		if (includeNames && name) wire.name = sanitizeForLLMName(String(name));
		return wire;
	});
}

/**
 * @description Issues a chat-completions request and extracts the reply.
 * @param {object} options - Call options.
 * @param {string} options.providerId - Provider id, for error attribution.
 * @param {Array<object>} options.messages - Conversation in internal format.
 * @param {object} options.config - Normalized provider configuration.
 * @param {string} [options.model] - Model override; defaults to `config.model`.
 * @param {boolean} [options.json=false] - Request a strict JSON object response.
 * @param {number|null} [options.temperature=null] - Sampling temperature; omitted when not finite.
 * @param {number|null} [options.maxTokens=null] - Response cap; omitted when not finite.
 * @param {boolean} [options.includeNames=false] - Whether to send message `name` fields.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} With kind "bad_request" when no messages or no model
 *   were supplied, "bad_response" when the reply carries no usable content, or
 *   a transport/status-derived kind propagated from the HTTP layer.
 */
export async function chatCompletions({
	providerId,
	messages,
	config,
	model,
	json = false,
	temperature = null,
	maxTokens = null,
	includeNames = false,
	signal,
	fetchImpl,
}) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new LLMRequestError("A chat request needs at least one message.", {
			provider: providerId,
			kind: "bad_request",
		});
	}

	const resolvedModel = model || config?.model;
	if (!resolvedModel) {
		throw new LLMRequestError("No model has been selected.", {
			provider: providerId,
			kind: "bad_request",
		});
	}

	const body = { model: resolvedModel, messages: toWireMessages(messages, includeNames) };
	if (json) body.response_format = { type: "json_object" };
	if (Number.isFinite(temperature)) body.temperature = temperature;
	if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

	const response = await requestJson(`${config.baseUrl}/chat/completions`, {
		provider: providerId,
		method: "POST",
		headers: authHeaders(config.apiKey),
		body,
		signal,
		fetchImpl,
	});

	const choice = response?.choices?.[0];
	const text = choice?.message?.content;
	if (typeof text !== "string" || text === "") {
		throw new LLMRequestError(
			`No usable content was returned${choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ""}.`,
			{ provider: providerId, kind: "bad_response" }
		);
	}

	return {
		text,
		model: resolvedModel,
		finishReason: choice.finish_reason ?? null,
		usage: response.usage
			? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
			: null,
	};
}

/**
 * @description Fetches the raw entries from a `/models` endpoint. Callers decide
 *   how to filter and label them, because that judgement is provider-specific.
 * @param {object} options - Call options.
 * @param {string} options.providerId - Provider id, for error attribution.
 * @param {object} options.config - Normalized provider configuration.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<Array<object>>} The raw model entries, or an empty array.
 * @throws {LLMRequestError} Propagated from the HTTP layer.
 */
export async function fetchModelEntries({ providerId, config, signal, fetchImpl }) {
	const response = await requestJson(`${config.baseUrl}/models`, {
		provider: providerId,
		headers: authHeaders(config.apiKey),
		signal,
		fetchImpl,
	});
	return Array.isArray(response?.data) ? response.data : [];
}
