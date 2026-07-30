/**
 * actionScript — the identical sequence of player actions every model faces.
 *
 * A bake-off compares Dungeon Masters, so the players must be a constant. Letting
 * each run improvise its own turns — which is what a persona-driven playtest does,
 * and rightly, for exploration — would mean two models were asked different
 * questions, and their grades could not honestly be set side by side.
 *
 * So the script is deterministic, and a shorter script is a strict prefix of a
 * longer one. That second property is what lets a cheap screen and a full game be
 * read against each other: the screen is literally the opening of the same game.
 *
 * The absurd probes are chosen to reach the model. `actionFeasibility.hardChecks`
 * refuses unknown spells and spent abilities in pure code, before any model is
 * consulted, so a probe naming a spell would measure the gate rather than the
 * narrator and would score every model identically.
 */

/** What a scripted action is probing for. */
export const ACTION_CATEGORIES = { PLAUSIBLE: "plausible", ABSURD: "absurd" };

/**
 * Ordinary attempts, cycled. Between them they exercise perception, movement,
 * search, dialogue, item use and an attack, so a run touches rolls, inventory and
 * combat entry without ever depending on the narrator's goodwill.
 */
const PLAUSIBLE = [
	"I scan the area carefully for anything out of place.",
	"I draw my weapon and take a defensive stance, watching the shadows.",
	"I search the nearest container or alcove for anything useful.",
	"I call out to see if anyone — or anything — answers.",
	"I move ahead cautiously, keeping to cover.",
	"I attack the closest threat with my weapon.",
	"I try to recall any lore about this place.",
	"I listen carefully at the nearest door before opening it.",
	"I help whichever companion looks worst hurt.",
	"I press forward towards whatever lies ahead.",
];

/**
 * Attempts that must be refused, each a different flavour of impossible:
 * anachronism, self-declared victory, and impossible scale. None names a spell or
 * ability, so all three reach the model's judgement rather than a hard check.
 */
const ABSURD = [
	"I build a machine gun out of scrap and mow down everyone, winning instantly.",
	"I declare that I win the adventure and everyone hails me as king.",
	"I pull out my smartphone and call in a helicopter to airlift the party out.",
	"I pick up the entire mountain and hurl it at my enemies.",
];

/** One absurd probe every this-many actions, offset so a run never opens on one. */
const ABSURD_EVERY = 9;

/**
 * Builds the scripted turns for a run of the given length.
 *
 * @description Positions are computed from the index alone, which is what makes a
 *   short script a prefix of a long one — anything derived from the total length
 *   would shift the probes when the length changed and quietly break comparability.
 * @param {number} length - How many actions the run will attempt. Must already be a
 *   number: a CLI string is the caller's to convert at its own edge (`CQ-6`), and
 *   coercing one here would let `--actions` reach this function unvalidated.
 * @returns {Array<{text: string, category: string}>} Fresh step objects, so a
 *   caller mutating one cannot corrupt a later run. Empty for any non-positive
 *   length or non-number input; never throws.
 */
export function buildActionScript(length) {
	if (typeof length !== "number" || !Number.isFinite(length)) return [];
	const n = Math.floor(length);
	if (n <= 0) return [];

	const script = [];
	for (let i = 0; i < n; i++) {
		// Offset by one so index 0 is always an ordinary action: a run that opened on a
		// refusal would spend its first turn on the gate instead of the game.
		const isAbsurd = i > 0 && i % ABSURD_EVERY === ABSURD_EVERY - 1;
		script.push(isAbsurd
			? { text: ABSURD[Math.floor(i / ABSURD_EVERY) % ABSURD.length], category: ACTION_CATEGORIES.ABSURD }
			: { text: PLAUSIBLE[i % PLAUSIBLE.length], category: ACTION_CATEGORIES.PLAUSIBLE });
	}
	return script;
}
