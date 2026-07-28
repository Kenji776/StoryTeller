/**
 * The self-hosted image server on the operator's network.
 *
 * A ComfyUI-backed HTTP service that generates images from a prompt and needs no
 * credential — only an address. That makes it the `local` policy's image
 * counterpart to Ollama for chat and the speech server for narration: free to
 * run, private, and available to every player without anyone supplying a key.
 *
 * **It has no authentication and no moderation.** Its own documentation is
 * explicit that the model does not refuse prompts. Two consequences are load-
 * bearing here rather than incidental:
 *
 * - The address must never leave a private network. It is set by the operator
 *   and passes `services/net/privateUrl.js` at the write boundary, for the same
 *   SSRF reason the speech server does (ADR 0006) and with more at stake, since
 *   this endpoint would accept anything from anyone who could reach it.
 * - Players type the prompt. `client/portraitPrompt.js` hands the player's own
 *   text to whatever provider is configured, so on this one it reaches an
 *   unmoderated model. Whether that is acceptable is the operator's policy call,
 *   and the default model is the general-purpose one rather than the explicit one.
 *
 * Requests are serialised server-side, so firing several in parallel makes
 * nothing faster — `batchSize` is the way to ask for variations.
 */

import { requestJson } from "../../llm/http.js";
import { LLMRequestError } from "../../llm/errors.js";

/** The provider id under which this adapter is registered. */
const PROVIDER_ID = "local-image";

/**
 * Dimension rules the server enforces, checked here first.
 *
 * A round trip to be told a number is off the grid is a round trip we can spend
 * on a clearer message instead, and the failure is the caller's to fix (CQ-6).
 */
const SIZE = Object.freeze({ min: 256, max: 2048, step: 16 });

/**
 * Character portraits default to a portrait aspect.
 *
 * The server's own default is square, which is the wrong shape for the only
 * thing StoryTeller currently generates.
 */
const DEFAULT_SIZE = Object.freeze({ width: 896, height: 1152 });

/** Presets the server understands. Each applies adapters and a prompt suffix. */
const STYLES = Object.freeze(["fantasy-portrait", "fantasy-painterly", "photoreal"]);

/** Chosen when the caller names none: the preset built for character art. */
const DEFAULT_STYLE = "fantasy-portrait";

/** General-purpose model. Deliberately not the explicit-content one. */
const DEFAULT_MODEL = "krea2";

/** Batch bounds the server enforces. */
const BATCH = Object.freeze({ min: 1, max: 8 });

/**
 * @description Validates one dimension against the server's grid and range.
 * @param {*} value - The candidate dimension.
 * @param {string} field - Which dimension, for the message.
 * @returns {number} The validated dimension.
 * @throws {Error} When the value is not a number on the 16-pixel grid within range.
 */
function checkDimension(value, field) {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${field} must be a whole number of pixels, received ${JSON.stringify(value)}.`);
	}
	if (value < SIZE.min || value > SIZE.max) {
		throw new Error(`${field} must be between ${SIZE.min} and ${SIZE.max}, received ${value}.`);
	}
	if (value % SIZE.step !== 0) {
		throw new Error(`${field} must be a multiple of ${SIZE.step}, received ${value}.`);
	}
	return value;
}

/**
 * Validates a requested image size, falling back to a portrait default.
 *
 * @description Exported because the size rules are the most likely thing a caller
 *   gets wrong, and a caller that wants to validate before offering the option to
 *   a player should not have to reimplement them.
 * @param {{width: number, height: number}} [size] - The requested size.
 * @returns {{width: number, height: number}} The validated size.
 * @throws {Error} When either dimension is invalid; the message names the field.
 */
export function normalizeImageSize(size) {
	if (size === null || size === undefined) return { ...DEFAULT_SIZE };
	return {
		width: checkDimension(size.width, "width"),
		height: checkDimension(size.height, "height"),
	};
}

/**
 * @description Reads the server address out of a resolved configuration.
 * @param {object} config - The resolved credential configuration.
 * @returns {string} The base URL, with no trailing slash.
 * @throws {Error} When no address is configured.
 */
function baseUrlOf(config) {
	const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.replace(/\/+$/, "") : "";
	if (!baseUrl) {
		throw new Error("The local image server has no address configured. Set one in the admin console.");
	}
	return baseUrl;
}

export const localImageProvider = {
	id: PROVIDER_ID,
	label: "Local image server",
	requiresApiKey: false,
	requiresBaseUrl: true,
	// No default: a self-hosted server can be on any machine and port, and a guess
	// that silently fails is worse than an address the operator has to supply.
	defaultBaseUrl: null,
	isLocal: true,
	keyUrl: null,
	styles: STYLES,

	/**
	 * Generates one image.
	 *
	 * @description Everything the server documents as "leave alone" is simply not
	 *   sent, rather than sent at its default. `cfg` is the one that matters: the
	 *   model is distilled for the server's value and raising it produces burnt
	 *   output, so the safest way to honour that is to have no code path capable of
	 *   setting it. `steps` and `negative_prompt` follow the same rule — the latter
	 *   has no effect at this cfg, so offering it would be a control that does
	 *   nothing.
	 * @param {object} request - What to draw.
	 * @param {string} request.prompt - The finalised prompt.
	 * @param {object} request.config - Resolved configuration carrying `baseUrl` and `model`.
	 * @param {{width: number, height: number}} [request.size] - Image dimensions.
	 * @param {string} [request.style] - One of `styles`.
	 * @param {number} [request.seed] - Fixed seed, for a reproducible image.
	 * @param {number} [request.batchSize=1] - How many variations to generate.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<{b64: string, model: string, seed: number|null, contentType: string}>}
	 *   The first image and what produced it.
	 * @throws {Error} When the prompt, style, size, batch size, or address is invalid.
	 * @throws {LLMRequestError} When the server refuses, fails, or cannot be reached.
	 */
	async generate({ prompt, config, size, style, seed, batchSize = 1, signal, fetchImpl } = {}) {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new Error("An image prompt must be a non-empty string.");
		}
		const chosenStyle = style ?? DEFAULT_STYLE;
		if (!STYLES.includes(chosenStyle)) {
			throw new Error(`Unknown style "${chosenStyle}". Expected one of: ${STYLES.join(", ")}.`);
		}
		if (!Number.isInteger(batchSize) || batchSize < BATCH.min || batchSize > BATCH.max) {
			throw new Error(`batch size must be a whole number between ${BATCH.min} and ${BATCH.max}, received ${JSON.stringify(batchSize)}.`);
		}

		const baseUrl = baseUrlOf(config);
		const { width, height } = normalizeImageSize(size);

		const body = {
			prompt: prompt.trim(),
			style: chosenStyle,
			model: config?.model || DEFAULT_MODEL,
			width,
			height,
			batch_size: batchSize,
		};
		// Present only when the caller wants reproducibility; otherwise the server
		// picks one and reports it back.
		if (Number.isInteger(seed)) body.seed = seed;

		const response = await requestJson(`${baseUrl}/generate`, {
			provider: PROVIDER_ID,
			method: "POST",
			body,
			fetchImpl,
			signal,
		});

		const b64 = Array.isArray(response?.images) ? response.images[0] : null;
		if (!b64) {
			throw new LLMRequestError("The image server returned no image.", {
				provider: PROVIDER_ID,
				kind: "bad_response",
			});
		}

		return {
			b64,
			model: response.model ?? body.model,
			seed: Number.isInteger(response?.seed) ? response.seed : null,
			contentType: "image/png",
		};
	},

	/**
	 * @description Reports whether the server is up and its backend loaded. Never
	 *   throws: reachability is a fact about the world, and a caller asking
	 *   "is this available" wants an answer rather than an exception to handle.
	 * @param {object} request - The probe request.
	 * @param {object} request.config - Configuration carrying `baseUrl`.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<boolean>} True when the server answered healthily.
	 */
	async probe({ config, signal, fetchImpl } = {}) {
		try {
			const baseUrl = baseUrlOf(config);
			await requestJson(`${baseUrl}/health`, { provider: PROVIDER_ID, fetchImpl, signal });
			return true;
		} catch {
			return false;
		}
	},

	/**
	 * @description Lists the models the server actually has, for the picker.
	 *   Discovery beats a hardcoded list, because which checkpoints are installed
	 *   is the operator's business and changes without this code changing.
	 * @param {object} request - The listing request.
	 * @param {object} request.config - Configuration carrying `baseUrl`.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<Array<{id: string, label: string}>>} Installed models, or
	 *   an empty list when the server offers no discovery endpoint.
	 */
	async listModels({ config, signal, fetchImpl } = {}) {
		let response;
		try {
			response = await requestJson(`${baseUrlOf(config)}/models`, { provider: PROVIDER_ID, fetchImpl, signal });
		} catch {
			// A server without /models is still a usable server; the operator names
			// the model themselves. Degrading beats reporting the whole thing broken.
			return [];
		}

		const models = Array.isArray(response?.models) ? response.models : [];
		return models
			.filter((entry) => entry?.name && entry.installed !== false)
			.map((entry) => ({ id: entry.name, label: entry.label || entry.name }));
	},
};
