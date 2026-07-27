/**
 * Generic OpenAI-compatible provider adapter.
 *
 * The escape hatch. OpenRouter, Groq, Together, vLLM, LM Studio, LiteLLM, and
 * most self-hosted gateways expose the OpenAI chat-completions shape at a
 * different address, so one adapter covers all of them: the player supplies a
 * base URL and, if the endpoint wants one, a key.
 *
 * Two things are deliberately more permissive than the OpenAI adapter, because
 * assumptions that hold for OpenAI proper do not hold for arbitrary gateways.
 */

import { chatCompletions, fetchModelEntries } from "./openaiWire.js";
import { LLMRequestError } from "../errors.js";

const PROVIDER_ID = "openai-compatible";

/**
 * @description Sends a chat completion request to the configured endpoint.
 *   Message `name` fields are dropped: unlike OpenAI proper, a large share of
 *   compatible gateways reject them with a 400.
 * @param {object} options - Call options, as accepted by `chatCompletions`.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} On invalid input, an unusable reply, or a provider failure.
 */
async function chat(options) {
	return chatCompletions({ ...options, providerId: PROVIDER_ID, includeNames: false });
}

/**
 * @description Lists the models the endpoint advertises.
 *
 *   No name-based filtering is applied. The OpenAI filter encodes OpenAI's
 *   naming conventions, and a gateway may legitimately serve a chat model whose
 *   name contains "tts" or "embedding"; guessing would hide a working model.
 *
 *   A missing endpoint degrades to an empty list rather than an error, because
 *   some minimal servers implement only `/chat/completions`. In that case the
 *   player types the model name themselves, which is a working configuration —
 *   whereas a hard failure here would block setup entirely. An authentication
 *   failure still propagates, since that is something the player can act on.
 * @param {object} options - Call options.
 * @param {object} options.config - Normalized provider configuration.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<Array<{id: string, label: string}>>} Selectable models, or
 *   an empty list when the endpoint does not offer a catalogue.
 * @throws {LLMRequestError} For failures the player can act on, notably auth.
 */
async function listModels({ config, signal, fetchImpl }) {
	let entries;
	try {
		entries = await fetchModelEntries({ providerId: PROVIDER_ID, config, signal, fetchImpl });
	} catch (err) {
		if (err instanceof LLMRequestError && err.kind === "not_found") return [];
		throw err;
	}
	return entries
		.filter(entry => entry?.id)
		.map(entry => ({ id: entry.id, label: entry.name || entry.id }));
}

export const openaiCompatibleProvider = {
	id: PROVIDER_ID,
	label: "Custom (OpenAI-compatible)",
	requiresApiKey: false,
	requiresBaseUrl: true,
	// There is no sensible default address for "somebody else's gateway".
	defaultBaseUrl: null,
	supportsImages: false,
	keyUrl: null,
	chat,
	listModels,
};
