/**
 * The status conditions this game recognises.
 *
 * @description The list existed only as prose inside the DM prompt, which made it
 *   unusable by anything that needs to *check* a condition rather than describe one.
 *   Anything the model invents — "woozy", "shaken" — must be discarded rather than
 *   written to a character sheet, because nothing would ever remove it again.
 *
 *   Alphabetical, and the prompt interpolates this same array, so the two cannot
 *   drift apart.
 */
export const CANONICAL_CONDITIONS = Object.freeze([
	"blinded",
	"burning",
	"charmed",
	"deafened",
	"exhausted",
	"frightened",
	"grappled",
	"incapacitated",
	"invisible",
	"paralyzed",
	"petrified",
	"poisoned",
	"prone",
	"restrained",
	"stunned",
	"unconscious",
]);

const CANONICAL_SET = new Set(CANONICAL_CONDITIONS);

/**
 * Normalises a condition name, or rejects it.
 *
 * @param {*} name - A condition name from the model, an item, or an admin tool.
 * @returns {string|null} The canonical name, or null when it is not one of ours.
 */
export function canonicalCondition(name) {
	if (typeof name !== "string") return null;
	const cleaned = name.trim().toLowerCase();
	return CANONICAL_SET.has(cleaned) ? cleaned : null;
}
