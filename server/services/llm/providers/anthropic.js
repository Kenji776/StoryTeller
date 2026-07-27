/**
 * Anthropic (Claude) provider adapter.
 *
 * Anthropic's Messages API differs from OpenAI's chat completions in four ways
 * that must be translated rather than hoped for:
 *
 *   - `system` is a top-level parameter, not a message role.
 *   - `max_tokens` is mandatory.
 *   - Messages carry no `name` field.
 *   - The reply is a list of content blocks, not a single string.
 *
 * The conversation also has to alternate user/assistant turns, which StoryTeller
 * cannot guarantee: several players can act before the DM replies, and a lobby
 * resumed from history may open on the DM's last narration. Both are repaired
 * here rather than left to produce a 400 mid-game.
 */

import { requestJson } from "../http.js";
import { LLMRequestError } from "../errors.js";

const PROVIDER_ID = "anthropic";

/** The Messages API version this adapter is written against. */
const API_VERSION = "2023-06-01";

/** Anthropic requires an explicit response cap; this matches the previous behaviour. */
const DEFAULT_MAX_TOKENS = 4096;

/** Separator used when merging turns and joining system prompts. */
const BLOCK_SEPARATOR = "\n\n";

/** Filler used when a conversation would otherwise not start with a user turn. */
const OPENING_TURN = "(begin)";

/**
 * @description Builds the request headers. Anthropic authenticates with
 *   `x-api-key` rather than a bearer token and requires a version header.
 * @param {object} config - Normalized provider configuration.
 * @returns {object} Headers for a Messages API request.
 */
function headersFor(config) {
	return { "x-api-key": config.apiKey, "anthropic-version": API_VERSION };
}

/**
 * @description Converts internal messages into an alternating user/assistant
 *   conversation, dropping system messages and the `name` field.
 * @param {Array<{role: string, content: string}>} messages - Internal messages.
 * @returns {Array<{role: string, content: string}>} A conversation Anthropic will accept.
 */
function toConversation(messages) {
	const turns = messages
		.filter(m => m.role === "user" || m.role === "assistant")
		.map(({ role, content }) => ({ role, content: content ?? "" }));

	// Anthropic requires at least one message, and the first must be the user's.
	if (turns.length === 0) return [{ role: "user", content: OPENING_TURN }];
	if (turns[0].role === "assistant") turns.unshift({ role: "user", content: OPENING_TURN });

	return turns.reduce((merged, turn) => {
		const previous = merged[merged.length - 1];
		if (previous && previous.role === turn.role) {
			previous.content = `${previous.content}${BLOCK_SEPARATOR}${turn.content}`;
			return merged;
		}
		merged.push({ ...turn });
		return merged;
	}, []);
}

/**
 * @description Sends a message-creation request to Anthropic.
 * @param {object} options - Call options.
 * @param {Array<object>} options.messages - Conversation in internal format.
 * @param {object} options.config - Normalized provider configuration.
 * @param {string} [options.model] - Model override; defaults to `config.model`.
 * @param {boolean} [options.json=false] - Accepted for interface parity and
 *   deliberately ignored: Anthropic has no response-format parameter, so JSON
 *   steering lives in the prompt.
 * @param {number|null} [options.temperature=null] - Sampling temperature; omitted when not finite.
 * @param {number} [options.maxTokens=4096] - Mandatory response cap.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} With kind "bad_request" when no messages or no model
 *   were supplied, "bad_response" when the reply carries no text block, or a
 *   transport/status-derived kind propagated from the HTTP layer.
 */
async function chat({ messages, config, model, temperature = null, maxTokens = DEFAULT_MAX_TOKENS, signal, fetchImpl }) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new LLMRequestError("An Anthropic request needs at least one message.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const resolvedModel = model || config?.model;
	if (!resolvedModel) {
		throw new LLMRequestError("No Anthropic model has been selected.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const systemPrompt = messages
		.filter(m => m.role === "system")
		.map(m => m.content)
		.filter(Boolean)
		.join(BLOCK_SEPARATOR);

	const body = {
		model: resolvedModel,
		max_tokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
		messages: toConversation(messages),
	};
	if (systemPrompt) body.system = systemPrompt;
	if (Number.isFinite(temperature)) body.temperature = temperature;

	const response = await requestJson(`${config.baseUrl}/messages`, {
		provider: PROVIDER_ID,
		method: "POST",
		headers: headersFor(config),
		body,
		signal,
		fetchImpl,
	});

	const blocks = Array.isArray(response?.content) ? response.content : [];
	const text = blocks
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("");

	if (!text) {
		throw new LLMRequestError(
			`Anthropic returned no usable content${response?.stop_reason ? ` (stop reason: ${response.stop_reason})` : ""}.`,
			{ provider: PROVIDER_ID, kind: "bad_response" }
		);
	}

	return {
		text,
		model: resolvedModel,
		finishReason: response.stop_reason ?? null,
		usage: response.usage
			? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
			: null,
	};
}

/**
 * @description Lists the models the supplied key can reach.
 * @param {object} options - Call options.
 * @param {object} options.config - Normalized provider configuration.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<Array<{id: string, label: string}>>} Selectable models,
 *   in the order Anthropic returns them (already newest-first).
 * @throws {LLMRequestError} Propagated from the HTTP layer when the key is
 *   rejected or the endpoint is unreachable.
 */
async function listModels({ config, signal, fetchImpl }) {
	const response = await requestJson(`${config.baseUrl}/models`, {
		provider: PROVIDER_ID,
		headers: headersFor(config),
		signal,
		fetchImpl,
	});

	const entries = Array.isArray(response?.data) ? response.data : [];
	return entries
		.filter(entry => entry?.id)
		.map(entry => ({ id: entry.id, label: entry.display_name || entry.id }));
}

export const anthropicProvider = {
	id: PROVIDER_ID,
	label: "Anthropic",
	requiresApiKey: true,
	requiresBaseUrl: false,
	defaultBaseUrl: "https://api.anthropic.com/v1",
	supportsImages: false,
	keyUrl: "https://console.anthropic.com/settings/keys",
	chat,
	listModels,
};
