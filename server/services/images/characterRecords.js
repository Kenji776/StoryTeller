/**
 * Keeping a character looking like themselves.
 *
 * The image server holds a likeness under an id; StoryTeller holds that id on the
 * player's record. This module owns the two decisions in between — whether an
 * existing likeness still applies, and how to phrase a moment as a scene — so
 * both can be tested without a server, and so neither is re-derived at a call
 * site where it would drift.
 *
 * The single rule everything here serves: **appearance is what is always true,
 * a scene is what is happening now.** The server prepends the stored appearance
 * to every scene, so restating any of it is not merely redundant — it is the
 * documented cause of the same character coming out with a different face.
 */

/**
 * @description Normalises an appearance for comparison. Case and whitespace
 *   differences are not changes: a sheet re-saved with a stray space must not
 *   throw away a working likeness and mint a new face.
 * @param {*} text - The appearance.
 * @returns {string} A comparable form.
 */
function comparable(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Decides what to do about a player's stored likeness.
 *
 * @description The server has no way to edit a stored appearance, so a permanent
 *   change means a new identity rather than an update. The old id is returned as
 *   `retire` rather than dropped, so the caller can delete it instead of leaving
 *   an orphan the game no longer references.
 * @param {object} [input] - The player's record and their current appearance.
 * @param {object|null} [input.record] - The player, carrying `imageCharacterId`
 *   and `imageAppearance` if they have been drawn before.
 * @param {string} input.appearance - What is permanently true of them now.
 * @param {boolean} [input.force=false] - Rebuild even if nothing changed.
 * @returns {{action: "create"|"reuse", characterId?: string, retire: string|null}}
 *   What to do, and which old identity to clean up.
 * @throws {TypeError} When the appearance is blank — continuity rests on it.
 */
export function characterPlan({ record, appearance, force = false } = {}) {
	if (typeof appearance !== "string" || !appearance.trim()) {
		throw new TypeError("A character's appearance is required; continuity rests entirely on it.");
	}

	const existingId = record?.imageCharacterId ?? null;
	const existingAppearance = record?.imageAppearance ?? null;

	// A stored id with no remembered appearance predates this feature. It cannot be
	// compared against, and reusing it pins the character to a likeness nobody can
	// inspect, so it is rebuilt.
	const comparable_ = existingId && existingAppearance && comparable(existingAppearance) === comparable(appearance);

	if (comparable_ && !force) {
		return { action: "reuse", characterId: existingId, retire: null };
	}
	return { action: "create", retire: existingId };
}

/**
 * Phrases a moment as a scene the image server will accept.
 *
 * @description Deliberately narrow. It trims, folds in a mood, and removes the
 *   character's own name — the server already knows who this is, and a name in
 *   the scene reads as a second person in the frame. It does *not* add any
 *   physical description, and there is no parameter through which a caller could.
 * @param {object} [input] - The moment.
 * @param {string} input.moment - What is happening, in plain words.
 * @param {string} [input.mood] - How it should feel, e.g. "triumphant".
 * @param {string} [input.name] - The character's name, removed if it appears.
 * @returns {string} The scene.
 * @throws {TypeError} When the moment is blank.
 */
export function sceneFor({ moment, mood, name } = {}) {
	if (typeof moment !== "string" || !moment.trim()) {
		throw new TypeError("A scene needs a moment: what is happening, not what they look like.");
	}

	let scene = moment.trim();

	if (typeof name === "string" && name.trim()) {
		// Whole words only. A character called "Shallow" must not turn "shallows"
		// into "s".
		const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		scene = scene.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "").replace(/\s{2,}/g, " ").trim();
	}

	if (typeof mood === "string" && mood.trim()) {
		scene = `${scene}, ${mood.trim()}`;
	}

	return scene.replace(/\s{2,}/g, " ").replace(/[.,\s]+$/, "").trim();
}
