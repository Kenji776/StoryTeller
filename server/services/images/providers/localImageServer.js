/**
 * The self-hosted image server on the operator's network.
 *
 * A ComfyUI-backed HTTP service that generates images from a prompt. It needs an
 * address and a shared token, both operator configuration — so it remains the
 * `local` policy's image counterpart to Ollama for chat and the speech server
 * for narration: free to run, private, and available to every player without
 * any of them supplying anything.
 *
 * **Characters are the continuity mechanism, and the only one that works.** A
 * character is a stored reference portrait plus a remembered appearance; posing
 * one feeds that portrait back through the model, so the same face comes out in a
 * new scene. Reusing prompts or seeds does *not* achieve this — it produces a
 * different face every session — so `generateForCharacter` sends only what is
 * happening now. Restating appearance inside a scene is the documented cause of
 * drift, and this adapter has no parameter that would let a caller do it.
 *
 * **It has no moderation.** Its documentation is explicit that the model does not
 * refuse prompts. Two consequences are load-bearing here rather than incidental:
 *
 * - The address must never leave a private network. It is set by the operator
 *   and passes `services/net/privateUrl.js` at the write boundary, for the same
 *   SSRF reason the speech server does (ADR 0006). The server now requires a
 *   token, which narrows but does not remove the exposure — a token shared across
 *   a LAN is a lock, not a boundary.
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
 * How far the stored portrait is allowed to pull a new image.
 *
 * Raise toward the top of the range when a face drifts, lower it when the pose
 * comes out stiff. Outside this range the documentation offers no guidance, so a
 * value there is more likely a typo than an intention.
 */
const IDENTITY_STRENGTH = Object.freeze({ min: 0.8, max: 1.2 });

/**
 * @description Builds the auth header. The token goes in a header rather than the
 *   query string the server also accepts: a URL is captured by access logs and
 *   proxy history, and this one is issued once for the whole LAN.
 * @param {object} config - The resolved configuration.
 * @returns {object} Headers, empty when no token is configured.
 */
function authHeaders(config) {
	return config?.apiKey ? { "X-API-Key": config.apiKey } : {};
}

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
	requiresApiKey: true,
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
			headers: authHeaders(config),
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
	 * Registers a character, so every later image of them shows the same face.
	 *
	 * @description Call this once, when the character first exists, and keep the
	 *   returned id on the game's own record — it is the only handle to that
	 *   identity, and losing it means the character can only be recreated looking
	 *   different.
	 *
	 *   `appearance` is what is *always* true of them. Anything about a particular
	 *   moment belongs in a scene, later.
	 * @param {object} request - The character.
	 * @param {string} request.name - Their name.
	 * @param {string} request.appearance - Permanent physical description.
	 * @param {object} request.config - Configuration carrying `baseUrl` and the token.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<{id: string, b64: string|null, name: string}>} The stored
	 *   identity and its reference portrait.
	 * @throws {Error} When the name or appearance is blank.
	 * @throws {LLMRequestError} When the server refuses or cannot be reached.
	 */
	async createCharacter({ name, appearance, config, signal, fetchImpl } = {}) {
		if (typeof name !== "string" || !name.trim()) {
			throw new Error("A character needs a name.");
		}
		if (typeof appearance !== "string" || !appearance.trim()) {
			// Continuity rests entirely on this text; an empty one produces a
			// character the server cannot hold a likeness for.
			throw new Error("A character needs an appearance describing what is always true of them.");
		}

		const response = await requestJson(`${baseUrlOf(config)}/characters`, {
			provider: PROVIDER_ID,
			method: "POST",
			headers: authHeaders(config),
			body: { name: name.trim(), appearance: appearance.trim() },
			fetchImpl,
			signal,
		});

		if (!response?.id) {
			throw new LLMRequestError("The image server did not return a character id.", {
				provider: PROVIDER_ID,
				kind: "bad_response",
			});
		}
		return { id: response.id, b64: response.image ?? null, name: name.trim() };
	},

	/**
	 * Draws a registered character in a new situation.
	 *
	 * @description The scene describes only what is happening now. The stored
	 *   appearance is prepended by the server, and restating any of it here is the
	 *   documented cause of faces drifting between sessions — which is why this
	 *   takes no `prompt` at all rather than trusting a caller not to pass one.
	 * @param {object} request - What is happening.
	 * @param {string} request.characterId - The id from `createCharacter`.
	 * @param {string} request.scene - What they are doing, and where.
	 * @param {object} request.config - Configuration carrying `baseUrl` and the token.
	 * @param {number} [request.identityStrength] - 0.8–1.2. Raise if the face
	 *   drifts, lower if the pose looks stiff.
	 * @param {{width: number, height: number}} [request.size] - Image dimensions.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<{b64: string, model: string, seed: number|null, contentType: string}>}
	 *   The image.
	 * @throws {Error} When the id, scene, or identity strength is invalid.
	 * @throws {LLMRequestError} When the character is unknown, or the server failed.
	 */
	async generateForCharacter({ characterId, scene, config, identityStrength, size, signal, fetchImpl } = {}) {
		if (typeof characterId !== "string" || !characterId.trim()) {
			throw new Error("A character id is required to pose a character.");
		}
		if (typeof scene !== "string" || !scene.trim()) {
			throw new Error("A scene is required: what is happening, not what they look like.");
		}
		if (identityStrength !== undefined && identityStrength !== null) {
			const value = Number(identityStrength);
			if (!Number.isFinite(value) || value < IDENTITY_STRENGTH.min || value > IDENTITY_STRENGTH.max) {
				throw new Error(
					`identity strength must be between ${IDENTITY_STRENGTH.min} and ${IDENTITY_STRENGTH.max}, ` +
					`received ${JSON.stringify(identityStrength)}.`,
				);
			}
		}

		const body = { scene: scene.trim() };
		if (identityStrength !== undefined && identityStrength !== null) body.identity_strength = Number(identityStrength);
		if (size) Object.assign(body, normalizeImageSize(size));

		const response = await requestJson(`${baseUrlOf(config)}/characters/${encodeURIComponent(characterId)}/generate`, {
			provider: PROVIDER_ID,
			method: "POST",
			headers: authHeaders(config),
			body,
			fetchImpl,
			signal,
		});

		const b64 = Array.isArray(response?.images) ? response.images[0] : null;
		if (!b64) {
			throw new LLMRequestError("The image server returned no image for that character.", {
				provider: PROVIDER_ID,
				kind: "bad_response",
			});
		}
		return {
			b64,
			model: response.model ?? null,
			seed: Number.isInteger(response?.seed) ? response.seed : null,
			contentType: "image/png",
		};
	},

	/**
	 * @description Lists the characters the server already holds. Worth calling
	 *   before creating one: a duplicate is a second identity with a different
	 *   face, and nothing downstream would notice.
	 * @param {object} request - The listing request.
	 * @param {object} request.config - Configuration carrying `baseUrl` and the token.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<Array<object>>} The stored characters, or an empty list.
	 * @throws {LLMRequestError} When the server refuses or cannot be reached.
	 */
	async listCharacters({ config, signal, fetchImpl } = {}) {
		const response = await requestJson(`${baseUrlOf(config)}/characters`, {
			provider: PROVIDER_ID,
			headers: authHeaders(config),
			fetchImpl,
			signal,
		});
		const characters = response?.characters ?? response;
		return Array.isArray(characters) ? characters : [];
	},

	/**
	 * @description Forgets a stored character. The game record pointing at it must
	 *   be cleared too, or the next scene will fail with a 404.
	 * @param {object} request - The deletion request.
	 * @param {string} request.characterId - The id to remove.
	 * @param {object} request.config - Configuration carrying `baseUrl` and the token.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<void>} Resolves once removed.
	 * @throws {LLMRequestError} When the server refuses or cannot be reached.
	 */
	async deleteCharacter({ characterId, config, signal, fetchImpl } = {}) {
		await requestJson(`${baseUrlOf(config)}/characters/${encodeURIComponent(characterId)}/delete`, {
			provider: PROVIDER_ID,
			method: "POST",
			headers: authHeaders(config),
			fetchImpl,
			signal,
		});
	},

	/**
	 * @description Reports how far along the current generation is, so a player
	 *   waiting seven to twenty seconds sees something happening. Never throws:
	 *   losing the progress readout must not fail the image it describes.
	 * @param {object} request - The progress request.
	 * @param {object} request.config - Configuration carrying `baseUrl` and the token.
	 * @param {AbortSignal} [request.signal] - Cancellation signal.
	 * @param {Function} [request.fetchImpl] - Injected fetch, for testability.
	 * @returns {Promise<{running: boolean, step: number, steps: number, percent: number}>}
	 *   The current state, reporting idle when unreachable.
	 */
	async progress({ config, signal, fetchImpl } = {}) {
		try {
			const response = await requestJson(`${baseUrlOf(config)}/progress`, {
				provider: PROVIDER_ID,
				headers: authHeaders(config),
				fetchImpl,
				signal,
			});
			return {
				running: Boolean(response?.running),
				step: Number(response?.step) || 0,
				steps: Number(response?.steps) || 0,
				percent: Number(response?.percent) || 0,
			};
		} catch {
			return { running: false, step: 0, steps: 0, percent: 0 };
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
			response = await requestJson(`${baseUrlOf(config)}/models`, { provider: PROVIDER_ID, headers: authHeaders(config), fetchImpl, signal });
		} catch {
			// A server without /models is still a usable server; the operator names
			// the model themselves. Degrading beats reporting the whole thing broken.
			return [];
		}

		// The server keys models by id -- `{krea2: {file, installed}}` -- rather than
		// listing them. An earlier version assumed an array and degraded to an empty
		// list, which reads as a server with no models rather than as a parser that
		// is wrong. The array form is still accepted in case that ever changes.
		const raw = response?.models;
		const entries = Array.isArray(raw)
			? raw.map((entry) => [entry?.name, entry])
			: raw && typeof raw === "object" ? Object.entries(raw) : [];

		return entries
			.filter(([id, entry]) => id && entry?.installed !== false)
			.map(([id, entry]) => ({ id, label: entry?.label || id }));
	},
};
