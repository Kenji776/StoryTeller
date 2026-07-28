/**
 * OpenAI image generation.
 *
 * Lifted out of `services/llmService.js`, where portrait generation reached for a
 * client constructed at module load from `OPENAI_API_KEY`. The credential now
 * arrives per request, which is what lets a player's own key draw their own
 * character, and the transport is `fetch` rather than the vendor SDK for the
 * reasons in ADR 0002.
 *
 * The model ladder is the interesting part and is preserved verbatim in spirit:
 * a key that can *list* a model cannot always *call* it, because access is granted
 * per organisation and the difference only appears on a real request. So the
 * adapter walks candidates until one answers, and remembers the winner.
 */

import { requestJson } from "../../llm/http.js";
import { LLMRequestError } from "../../llm/errors.js";

/** The provider id under which this adapter is registered. */
const PROVIDER_ID = "openai";

/** Where the API lives when no override is configured. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Image models in descending order of capability.
 *
 * Tried in order because organisation-level access is only discoverable by
 * asking. `dall-e-3` is last and is the reason the list exists at all: it was
 * once hardcoded, and the endpoint began rejecting the `response_format`
 * parameter the old call sent, so every portrait had been failing.
 */
const MODEL_LADDER = Object.freeze(["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "dall-e-3"]);

/**
 * Sizes each family accepts. The two families disagree, and sending one family's
 * size to the other is a 400 rather than a resize.
 */
const SIZES_BY_FAMILY = Object.freeze({
	"gpt-image": ["1024x1024", "1024x1536", "1536x1024"],
	"dall-e": ["1024x1024", "1024x1792", "1792x1024"],
});

/** Portrait, because character art is the only thing this generates today. */
const DEFAULT_ASPECT = 896 / 1152;

/** Statuses that mean the credential is wrong, not the model. Walking on would be pointless. */
const CREDENTIAL_STATUSES = new Set([401, 402]);

/**
 * @description Picks the size family a model belongs to.
 * @param {string} [model] - The model id.
 * @returns {string[]} The sizes that model accepts.
 */
function sizesFor(model) {
	return String(model ?? "").startsWith("dall-e") ? SIZES_BY_FAMILY["dall-e"] : SIZES_BY_FAMILY["gpt-image"];
}

/**
 * Maps a requested size onto the closest one the API will accept.
 *
 * @description The local image server takes any multiple of sixteen; OpenAI takes
 *   three fixed strings per family. Rather than refuse a size that is merely not
 *   on OpenAI's list, the closest aspect ratio is chosen, so a caller can ask for
 *   the same portrait shape from either provider and get a portrait from both.
 * @param {{width: number, height: number}} [size] - The requested size.
 * @param {string} [model] - The model, which decides the candidate list.
 * @returns {string} A size string the API accepts, e.g. "1024x1536".
 */
export function nearestSupportedSize(size, model) {
	const candidates = sizesFor(model);
	const wanted = size && Number(size.width) > 0 && Number(size.height) > 0
		? Number(size.width) / Number(size.height)
		: DEFAULT_ASPECT;

	let best = candidates[0];
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const [w, h] = candidate.split("x").map(Number);
		const distance = Math.abs(w / h - wanted);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * @description Builds the request body for one model. The gpt-image family always
 *   returns base64 and rejects `response_format`; dall-e-3 requires it.
 * @param {string} model - The model id.
 * @param {string} prompt - The finalised prompt.
 * @param {{width: number, height: number}} [size] - The requested size.
 * @returns {object} The request body.
 */
function bodyFor(model, prompt, size) {
	const body = { model, prompt, n: 1, size: nearestSupportedSize(size, model) };
	if (model.startsWith("dall-e")) body.response_format = "b64_json";
	return body;
}

/** Remembered across calls so a working model is not rediscovered every time. */
let preferredModel = null;

export const openaiImageProvider = {
	id: PROVIDER_ID,
	label: "OpenAI",
	requiresApiKey: true,
	requiresBaseUrl: false,
	defaultBaseUrl: DEFAULT_BASE_URL,
	isLocal: false,
	keyUrl: "https://platform.openai.com/api-keys",
	// Style presets are a local-server concept; OpenAI takes direction in the
	// prompt itself, and pretending otherwise would put a dead control in the UI.
	styles: [],

	/**
	 * Generates one image.
	 *
	 * @description When the configuration names a model, that model is used and
	 *   nothing else is tried — an explicit choice is not a suggestion. Otherwise
	 *   the ladder is walked, starting from whichever model last worked.
	 * @param {object} request - What to draw.
	 * @param {string} request.prompt - The finalised prompt.
	 * @param {object} request.config - Resolved configuration carrying `apiKey`,
	 *   and optionally `model` and `baseUrl`.
	 * @param {{width: number, height: number}} [request.size] - Requested size.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<{b64: string, model: string, seed: null, contentType: string}>}
	 *   The image and the model that produced it.
	 * @throws {Error} When the prompt is blank or no key was supplied.
	 * @throws {LLMRequestError} When the credential is rejected, or every
	 *   candidate model refused.
	 */
	async generate({ prompt, config, size, signal, fetchImpl } = {}) {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new Error("An image prompt must be a non-empty string.");
		}
		const apiKey = config?.apiKey;
		if (typeof apiKey !== "string" || !apiKey.trim()) {
			throw new Error("OpenAI image generation requires an API key.");
		}

		const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		const headers = { Authorization: `Bearer ${apiKey}` };

		const candidates = config.model
			? [config.model]
			: preferredModel
				? [preferredModel, ...MODEL_LADDER.filter((m) => m !== preferredModel)]
				: [...MODEL_LADDER];

		const failures = [];
		for (const model of candidates) {
			try {
				const response = await requestJson(`${baseUrl}/images/generations`, {
					provider: PROVIDER_ID,
					method: "POST",
					headers,
					body: bodyFor(model, prompt.trim(), size),
					fetchImpl,
					signal,
				});

				const b64 = response?.data?.[0]?.b64_json;
				if (!b64) {
					throw new LLMRequestError("OpenAI returned no image data.", {
						provider: PROVIDER_ID,
						kind: "bad_response",
					});
				}

				if (!config.model) preferredModel = model;
				return { b64, model, seed: null, contentType: "image/png" };
			} catch (err) {
				// A rejected key or an exhausted account is not fixed by a different
				// model, so it stops here. 403 deliberately does *not*: it is how the
				// API reports a model this organisation may not call, which is exactly
				// what the ladder exists to step over.
				if (CREDENTIAL_STATUSES.has(err?.status)) throw err;
				failures.push(`${model}: ${err?.message ?? err}`);
			}
		}

		throw new LLMRequestError(
			`No image model would answer. Tried ${candidates.length}: ${failures.join(" | ")}`,
			{ provider: PROVIDER_ID, kind: "not_found" },
		);
	},

	/**
	 * @description Reports whether the supplied key can reach the API at all.
	 *   Never throws, for the same reason the local adapter's probe does not.
	 * @param {object} request - The probe request.
	 * @param {object} request.config - Configuration carrying `apiKey`.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<boolean>} True when the API answered.
	 */
	async probe({ config, signal, fetchImpl } = {}) {
		if (!config?.apiKey) return false;
		try {
			const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
			await requestJson(`${baseUrl}/models`, {
				provider: PROVIDER_ID,
				headers: { Authorization: `Bearer ${config.apiKey}` },
				fetchImpl,
				signal,
			});
			return true;
		} catch {
			return false;
		}
	},

	/**
	 * @description Lists the image models this adapter knows how to drive.
	 *
	 *   Deliberately the ladder rather than the account's `/models` response: that
	 *   list is account-wide, mixes in chat, audio and embedding models, and
	 *   reports models that can be listed but not called. Offering it would put
	 *   entries in the picker that fail on use.
	 * @returns {Promise<Array<{id: string, label: string}>>} The supported models.
	 */
	async listModels() {
		return MODEL_LADDER.map((id) => ({ id, label: id }));
	},

	/**
	 * @description Forgets which model last worked, so the ladder is walked afresh.
	 *   Exposed because an operator granted access to a better model should not
	 *   have to restart the server to get it, and because a remembered model
	 *   leaking between tests would make them order-dependent (TDD-8).
	 * @returns {void}
	 */
	resetPreference() {
		preferredModel = null;
	},
};
