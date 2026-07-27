/**
 * Canned-response test provider.
 *
 * Backs dev-mode Quick Start: returns pre-written DM responses so the whole
 * game loop — JSON parsing, HP and inventory application, music and SFX cues —
 * can be exercised without spending anyone's tokens. It makes no network
 * request, and is only offered in the UI when the server is in dev mode.
 *
 * Randomness and the response file are both injected rather than reached for,
 * which is what makes the selection logic testable (CQ-5, TDD-8).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { LLMRequestError } from "../errors.js";

const PROVIDER_ID = "test";

/** The single model this provider offers. */
const STUB_MODEL = "test-stub";

/** Placeholder in the canned text, replaced with the acting player's name. */
const PLAYER_PLACEHOLDER = /__ACTIVE_PLAYER__/g;

/** Used when a canned action response has no player to attribute it to. */
const FALLBACK_PLAYER = "Adventurer";

/** Phrases that identify a prompt asking for an adventure title. */
const TITLE_PROMPTS = ["adventure title", "naming a Dungeons"];

/** Phrases that identify a prompt asking for an opening scene. */
const SETUP_PROMPTS = ["opening", "introducing a new", "opening scene"];

/** Canned adventure names, used for title prompts. */
const ADVENTURE_NAMES = [
	"Shadows of the Forgotten Keep",
	"The Ember Crown Prophecy",
	"Blood Beneath the Mountain",
	"Whispers in the Pale Wood",
	"The Last Light of Valdris",
];

const RESPONSES_FILE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..", "..", "..", "data", "testLLMResponses.json"
);

/** Lazily loaded canned responses, so importing this module does no I/O. */
let cachedResponses = null;

/**
 * @description Loads the canned response file, caching it after the first read.
 * @returns {{setup: Array<object>, action: Array<object>}} The response pools.
 * @throws {LLMRequestError} When the file is missing or unparseable.
 */
function loadResponses() {
	if (cachedResponses) return cachedResponses;
	try {
		cachedResponses = JSON.parse(fs.readFileSync(RESPONSES_FILE, "utf-8"));
	} catch (err) {
		throw new LLMRequestError(`Could not load canned test responses: ${err.message}`, {
			provider: PROVIDER_ID,
			kind: "bad_response",
			cause: err,
		});
	}
	return cachedResponses;
}

/**
 * @description Picks one element of a pool using an injected random source.
 * @param {Array<*>} pool - The candidates.
 * @param {Function} random - A `Math.random`-compatible function.
 * @returns {*} The selected element.
 * @throws {LLMRequestError} When the pool is empty, which means the response
 *   file is truncated or mis-edited.
 */
function pick(pool, random) {
	if (!Array.isArray(pool) || pool.length === 0) {
		throw new LLMRequestError("The canned test response pool is empty.", {
			provider: PROVIDER_ID,
			kind: "bad_response",
		});
	}
	return pool[Math.floor(random() * pool.length)];
}

/**
 * @description Returns a canned DM response.
 * @param {object} options - Call options.
 * @param {Array<object>} options.messages - Conversation in internal format.
 * @param {object} [options.config] - Accepted for interface parity; unused.
 * @param {object} [options.responses] - Response pools; defaults to the bundled file.
 * @param {Function} [options.random=Math.random] - Injected randomness.
 * @returns {Promise<{text: string, model: string, finishReason: string|null, usage: null}>}
 *   The canned reply. Title prompts yield a bare string; everything else yields
 *   a JSON envelope matching what a real DM response looks like.
 * @throws {LLMRequestError} With kind "bad_request" when there are no messages,
 *   or "bad_response" when the response pool is empty or unreadable.
 */
async function chat({ messages, responses, random = Math.random }) {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new LLMRequestError("A request needs at least one message.", {
			provider: PROVIDER_ID,
			kind: "bad_request",
		});
	}

	const pools = responses || loadResponses();
	const allContent = messages.map(m => m.content || "").join(" ");

	if (TITLE_PROMPTS.some(phrase => allContent.includes(phrase))) {
		return {
			text: pick(ADVENTURE_NAMES, random),
			model: STUB_MODEL,
			finishReason: "stop",
			usage: null,
		};
	}

	const isSetup = SETUP_PROMPTS.some(phrase => allContent.includes(phrase));
	const chosen = pick(isSetup ? pools.setup : pools.action, random);

	const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
	const playerName = lastUserMessage?.name || FALLBACK_PLAYER;
	const text = JSON.stringify(chosen).replace(PLAYER_PLACEHOLDER, playerName);

	return { text, model: STUB_MODEL, finishReason: "stop", usage: null };
}

/**
 * @description Lists the single stub model, without any network access.
 * @returns {Promise<Array<{id: string, label: string}>>} The stub model.
 */
async function listModels() {
	return [{ id: STUB_MODEL, label: "Canned responses (no API calls)" }];
}

export const testProvider = {
	id: PROVIDER_ID,
	label: "Test Mode",
	requiresApiKey: false,
	requiresBaseUrl: false,
	defaultBaseUrl: null,
	supportsImages: false,
	keyUrl: null,
	chat,
	listModels,
};
