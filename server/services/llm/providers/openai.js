/**
 * OpenAI provider adapter.
 *
 * Speaks the chat-completions API directly over HTTP rather than through the
 * vendor SDK, so a per-lobby key can be supplied per request rather than baked
 * into a client at module load (ADR 0002).
 *
 * This adapter also serves as the reference shape for every other provider:
 * a descriptor object carrying its credential requirements plus `chat` and
 * `listModels`.
 */

import { requestJson } from "../http.js";
import { LLMRequestError } from "../errors.js";

const PROVIDER_ID = "openai";

/** OpenAI's limit on the `name` field of a message. */
export const OPENAI_NAME_MAX = 64;

/**
 * Model-id fragments that indicate a model which cannot hold a conversation.
 * The account-wide model list mixes embeddings, audio, and image models in with
 * the chat models; offering those in a DM picker guarantees a confusing failure
 * at the first turn.
 */
const NON_CHAT_FRAGMENTS = [
	"embedding",
	"whisper",
	"tts",
	"dall-e",
	"moderation",
	"audio",
	"realtime",
	"transcribe",
	"image",
	"babbage",
	"davinci",
	"codex",
];

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
 * @description Determines whether a model id looks like a conversational model.
 * @param {string} id - The model identifier from the provider.
 * @returns {boolean} True when the model is plausibly usable as a DM.
 */
function isChatModel(id) {
	const lower = String(id || "").toLowerCase();
	if (!lower) return false;
	return !NON_CHAT_FRAGMENTS.some(fragment => lower.includes(fragment));
}

/**
 * @description Converts internal messages into OpenAI's wire format, dropping
 *   the `name` field where absent and sanitising it where present.
 * @param {Array<{role: string, content: string, name?: string}>} messages - Internal messages.
 * @returns {Array<object>} Messages ready to send.
 */
function toWireMessages(messages) {
	return messages.map(({ role, content, name }) => {
		const wire = { role, content: content ?? "" };
		if (name) wire.name = sanitizeForLLMName(String(name));
		return wire;
	});
}

/**
 * @description Sends a chat completion request to OpenAI.
 * @param {object} options - Call options.
 * @param {Array<object>} options.messages - Conversation in internal format.
 * @param {object} options.config - Normalized provider configuration.
 * @param {string} [options.model] - Model override; defaults to `config.model`.
 * @param {boolean} [options.json=false] - Request a strict JSON object response.
 * @param {number|null} [options.temperature=null] - Sampling temperature; omitted when not finite.
 * @param {number|null} [options.maxTokens=null] - Response cap; omitted when not finite.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} With kind "bad_request" when no messages or no model
 *   were supplied, "bad_response" when the reply carries no usable content, or
 *   a transport/status-derived kind propagated from the HTTP layer.
 */
async function chat({ messages, config, model, json = false, temperature = null, maxTokens = null, signal, fetchImpl }) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new LLMRequestError("An OpenAI request needs at least one message.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const resolvedModel = model || config?.model;
	if (!resolvedModel) {
		throw new LLMRequestError("No OpenAI model has been selected.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const body = { model: resolvedModel, messages: toWireMessages(messages) };
	if (json) body.response_format = { type: "json_object" };
	if (Number.isFinite(temperature)) body.temperature = temperature;
	if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;

	const response = await requestJson(`${config.baseUrl}/chat/completions`, {
		provider: PROVIDER_ID,
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}` },
		body,
		signal,
		fetchImpl,
	});

	const choice = response?.choices?.[0];
	const text = choice?.message?.content;
	if (typeof text !== "string" || text === "") {
		throw new LLMRequestError(
			`OpenAI returned no usable content${choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ""}.`,
			{ provider: PROVIDER_ID, kind: "bad_response" }
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
 * @description Lists the conversational models the supplied key can reach,
 *   newest first.
 * @param {object} options - Call options.
 * @param {object} options.config - Normalized provider configuration.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<Array<{id: string, label: string}>>} Selectable models.
 * @throws {LLMRequestError} Propagated from the HTTP layer when the key is
 *   rejected or the endpoint is unreachable.
 */
async function listModels({ config, signal, fetchImpl }) {
	const response = await requestJson(`${config.baseUrl}/models`, {
		provider: PROVIDER_ID,
		headers: { Authorization: `Bearer ${config.apiKey}` },
		signal,
		fetchImpl,
	});

	const entries = Array.isArray(response?.data) ? response.data : [];
	return entries
		.filter(entry => isChatModel(entry?.id))
		.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
		.map(entry => ({ id: entry.id, label: entry.id }));
}

export const openaiProvider = {
	id: PROVIDER_ID,
	label: "OpenAI",
	requiresApiKey: true,
	requiresBaseUrl: false,
	defaultBaseUrl: "https://api.openai.com/v1",
	supportsImages: true,
	keyUrl: "https://platform.openai.com/api-keys",
	chat,
	listModels,
};
