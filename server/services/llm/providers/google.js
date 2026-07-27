/**
 * Google Gemini provider adapter.
 *
 * Gemini diverges from the other providers more than they diverge from each
 * other, and all of it has to be translated here:
 *
 *   - The model name is part of the URL path, not the request body.
 *   - Messages are `contents` holding `parts`, not strings.
 *   - The assistant role is called `model`.
 *   - The system prompt is a separate `systemInstruction` object.
 *   - Sampling parameters live under `generationConfig`.
 *
 * Gemini also offers an OpenAI-compatible endpoint, which would have avoided
 * most of this. It is used here anyway because the compatibility layer lags the
 * native API and its model listing does not report which models can actually
 * generate content — the one thing the configuration UI needs.
 */

import { requestJson } from "../http.js";
import { LLMRequestError } from "../errors.js";

const PROVIDER_ID = "google";

/** Separator used when joining system prompts. */
const BLOCK_SEPARATOR = "\n\n";

/** Filler used when the conversation contains nothing but system prompts. */
const OPENING_TURN = "(begin)";

/**
 * @description Builds request headers. The key goes in a header rather than the
 *   query string, where it would be captured by access and proxy logs.
 * @param {object} config - Normalized provider configuration.
 * @returns {object} Headers for the request.
 */
function headersFor(config) {
	return { "x-goog-api-key": config.apiKey };
}

/**
 * @description Converts internal messages into Gemini `contents`, dropping
 *   system messages (which are lifted separately) and the `name` field.
 * @param {Array<{role: string, content: string}>} messages - Internal messages.
 * @returns {Array<{role: string, parts: Array<{text: string}>}>} Gemini contents.
 */
function toContents(messages) {
	const contents = messages
		.filter(m => m.role === "user" || m.role === "assistant")
		.map(m => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content ?? "" }],
		}));

	if (contents.length === 0) return [{ role: "user", parts: [{ text: OPENING_TURN }] }];
	return contents;
}

/**
 * @description Sends a generateContent request to Gemini.
 * @param {object} options - Call options.
 * @param {Array<object>} options.messages - Conversation in internal format.
 * @param {object} options.config - Normalized provider configuration.
 * @param {string} [options.model] - Model override; defaults to `config.model`.
 * @param {boolean} [options.json=false] - Constrain the response to JSON.
 * @param {number|null} [options.temperature=null] - Sampling temperature.
 * @param {number|null} [options.maxTokens=null] - Mapped onto `maxOutputTokens`.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: object|null}>}
 *   The assistant reply and call metadata.
 * @throws {LLMRequestError} With kind "bad_request" when no messages or no model
 *   were supplied, "bad_response" when the candidate carries no text (including
 *   a safety block), or a transport/status-derived kind from the HTTP layer.
 */
async function chat({ messages, config, model, json = false, temperature = null, maxTokens = null, signal, fetchImpl }) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new LLMRequestError("A Gemini request needs at least one message.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const resolvedModel = model || config?.model;
	if (!resolvedModel) {
		throw new LLMRequestError("No Gemini model has been selected.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const systemPrompt = messages
		.filter(m => m.role === "system")
		.map(m => m.content)
		.filter(Boolean)
		.join(BLOCK_SEPARATOR);

	const body = { contents: toContents(messages) };
	if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

	const generationConfig = {};
	if (json) generationConfig.responseMimeType = "application/json";
	if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
	if (Number.isFinite(maxTokens)) generationConfig.maxOutputTokens = maxTokens;
	if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

	const response = await requestJson(
		`${config.baseUrl}/models/${encodeURIComponent(resolvedModel)}:generateContent`,
		{
			provider: PROVIDER_ID,
			method: "POST",
			headers: headersFor(config),
			body,
			signal,
			fetchImpl,
		}
	);

	const candidate = response?.candidates?.[0];
	const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
	const text = parts
		.filter(part => typeof part?.text === "string")
		.map(part => part.text)
		.join("");

	if (!text) {
		// A blocked response arrives as a candidate with no parts and a finish
		// reason explaining why, which is worth surfacing verbatim.
		throw new LLMRequestError(
			`Gemini returned no usable content${candidate?.finishReason ? ` (finish reason: ${candidate.finishReason})` : ""}.`,
			{ provider: PROVIDER_ID, kind: "bad_response" }
		);
	}

	const usage = response.usageMetadata;
	return {
		text,
		model: resolvedModel,
		finishReason: candidate.finishReason ?? null,
		usage: usage
			? { inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null }
			: null,
	};
}

/**
 * @description Lists the models that can generate content. Gemini returns ids
 *   as "models/<id>" but `generateContent` wants the bare id, and the bare id is
 *   what gets stored as the lobby's model setting — so the prefix is stripped
 *   here rather than at every use site.
 * @param {object} options - Call options.
 * @param {object} options.config - Normalized provider configuration.
 * @param {AbortSignal} [options.signal] - Cancellation signal.
 * @param {Function} [options.fetchImpl] - Fetch implementation for testing.
 * @returns {Promise<Array<{id: string, label: string}>>} Selectable models.
 * @throws {LLMRequestError} Propagated from the HTTP layer.
 */
async function listModels({ config, signal, fetchImpl }) {
	const response = await requestJson(`${config.baseUrl}/models`, {
		provider: PROVIDER_ID,
		headers: headersFor(config),
		signal,
		fetchImpl,
	});

	const entries = Array.isArray(response?.models) ? response.models : [];
	return entries
		.filter(entry => {
			const methods = entry?.supportedGenerationMethods;
			// Absent metadata should not hide a usable model.
			return !Array.isArray(methods) || methods.includes("generateContent");
		})
		.map(entry => {
			const id = String(entry?.name || "").replace(/^models\//, "");
			return id ? { id, label: entry.displayName || id } : null;
		})
		.filter(Boolean);
}

export const googleProvider = {
	id: PROVIDER_ID,
	label: "Google Gemini",
	requiresApiKey: true,
	requiresBaseUrl: false,
	defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
	supportsImages: false,
	keyUrl: "https://aistudio.google.com/apikey",
	chat,
	listModels,
};
