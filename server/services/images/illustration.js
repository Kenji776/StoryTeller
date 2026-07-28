/**
 * When the Dungeon Master asks for a picture.
 *
 * The DM already emits side-channel directives alongside its narration — `music`
 * for a mood change, `sfx` for a sound. `illustrate` is the same idea: the model
 * decides a moment is worth drawing and says so, and the server decides whether
 * to actually spend seven seconds and possibly somebody's money on it.
 *
 * Those are deliberately two decisions. A model asked "is this a key moment?"
 * will say yes far more often than a player wants an image, so the directive is
 * a *request* and `illustrationGate` is the answer. Without that split, the first
 * enthusiastic session produces an illustration every turn.
 *
 * The directive distinguishes two kinds, and the distinction is the whole reason
 * this is not just a prompt string:
 *
 * - **characters** — party members are in frame, so each is drawn from their
 *   stored likeness and comes out looking like themselves.
 * - **scene** — a place, an item, a creature. A plain prompt is right, and a
 *   likeness would mean nothing.
 */

/** How freely the DM may call for pictures. */
export const ILLUSTRATION_MODES = Object.freeze(["off", "key-moments", "generous"]);

/** Minimum gap between illustrations, per mode. */
const COOLDOWN_MS = Object.freeze({
	"key-moments": 10 * 60 * 1000,
	generous: 3 * 60 * 1000,
});

/**
 * Most characters drawn for one directive.
 *
 * Each is a separate generation on a server that works one at a time, so a
 * six-person party would be roughly a minute of waiting. Four is already
 * generous for a single beat.
 */
const MAX_CHARACTERS = 4;

/** Longest prompt forwarded. The model occasionally returns an essay. */
const MAX_PROMPT = 600;

/**
 * @description Determines whether a value is a plain (non-array, non-null) object.
 * @param {*} value - The value to test.
 * @returns {boolean} True when the value is a non-null, non-array object.
 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @description Trims and clamps a piece of model-authored text.
 * @param {*} value - The candidate.
 * @returns {string} The cleaned text, empty when there was none.
 */
function clean(value) {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_PROMPT) : "";
}

/**
 * Reads an illustration directive out of a DM reply.
 *
 * @description Everything here is model output and therefore untrusted (`CQ-6`):
 *   names are matched against the real party rather than believed, counts are
 *   capped, and text is clamped.
 *
 *   A named character with no stored likeness is dropped rather than drawn — an
 *   image of a stranger with a party member's name is worse than one fewer image.
 *   If that leaves nobody, the directive degrades to a plain scene, because the
 *   moment is still worth a picture even without the right faces.
 * @param {object|null} reply - The parsed DM JSON.
 * @param {object} [context] - What the lobby knows.
 * @param {Array<object>} [context.party] - Players, carrying `name` and `imageCharacterId`.
 * @returns {{kind: "characters"|"scene", moment?: string, prompt?: string,
 *   characters?: Array<object>, mood: string|null}|null} The directive, or null.
 */
export function parseIllustration(reply, { party = [] } = {}) {
	const raw = reply?.illustrate;
	if (!isPlainObject(raw)) return null;

	const moment = clean(raw.moment);
	const subject = clean(raw.subject);
	if (!moment && !subject) return null;

	const mood = clean(raw.mood) || null;

	const wanted = Array.isArray(raw.characters) ? raw.characters : [];
	const byName = new Map(
		party.filter((p) => p?.name).map((p) => [String(p.name).trim().toLowerCase(), p]),
	);

	const characters = wanted
		.map((name) => byName.get(String(name ?? "").trim().toLowerCase()))
		// No likeness means no continuity, and a stranger wearing the party's name
		// is worse than one fewer picture.
		.filter((player) => player?.imageCharacterId)
		.slice(0, MAX_CHARACTERS);

	if (characters.length) {
		return { kind: "characters", moment: moment || subject, characters, mood };
	}
	return { kind: "scene", prompt: moment || subject, mood };
}

/**
 * Decides whether an illustration may actually be drawn now.
 *
 * @description Fails closed. An unknown or absent mode is `off`, because the
 *   failure mode of guessing the other way is spending an operator's money on
 *   pictures nobody asked for.
 * @param {object} [input] - The lobby's setting and history.
 * @param {string} [input.mode] - One of `ILLUSTRATION_MODES`.
 * @param {number|null} [input.lastAt] - When the last illustration was drawn.
 * @param {number} input.now - The current instant.
 * @returns {{allowed: boolean, reason: string}} Whether to draw, and why not.
 */
export function illustrationGate({ mode, lastAt, now } = {}) {
	if (!ILLUSTRATION_MODES.includes(mode) || mode === "off") {
		return { allowed: false, reason: "Illustrations are switched off for this game." };
	}

	const cooldown = COOLDOWN_MS[mode];
	if (lastAt && now - lastAt < cooldown) {
		const waitMinutes = Math.ceil((cooldown - (now - lastAt)) / 60000);
		return { allowed: false, reason: `Too soon after the last illustration — about ${waitMinutes} more minute(s).` };
	}

	return { allowed: true, reason: "" };
}
