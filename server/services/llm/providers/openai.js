/**
 * OpenAI provider adapter.
 *
 * Speaks the chat-completions API directly over HTTP rather than through the
 * vendor SDK, so a per-lobby key can be supplied per request rather than baked
 * into a client at module load (ADR 0002).
 *
 * The wire format itself lives in `openaiWire.js`, shared with the generic
 * compatible adapter. What is specific to OpenAI proper is here: message `name`
 * fields are supported, and the account-wide model list needs filtering.
 */

import { chatCompletions, fetchModelEntries, sanitizeForLLMName, OPENAI_NAME_MAX } from "./openaiWire.js";

const PROVIDER_ID = "openai";

export { sanitizeForLLMName, OPENAI_NAME_MAX };

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
 * @description Sends a chat completion request to OpenAI.
 * @param {object} options - Call options, as accepted by `chatCompletions`.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} On invalid input, an unusable reply, or a provider failure.
 */
async function chat(options) {
	return chatCompletions({ ...options, providerId: PROVIDER_ID, includeNames: true });
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
	const entries = await fetchModelEntries({ providerId: PROVIDER_ID, config, signal, fetchImpl });
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
