/**
 * encounterPacing — makes sure fights actually happen.
 *
 * @description Whether the party was ever attacked was entirely the narrator's whim.
 *   In one 120-turn game every DM turn — 36 of 36 — set `combat_over: true` and not
 *   one carried an enemies array. There was no combat at all, so the enemy-turn
 *   resolver had nobody to roll for and `player:death` could not fire however
 *   dangerous the lobby's settings claimed the world was.
 *
 *   The brutality and difficulty settings turned out to govern *tone* — "wounds
 *   bleed", "enemies are relentless" — with nothing mechanical attached. A party of
 *   cautious players who scout and investigate will never be attacked, because
 *   nothing ever asks the model to attack them.
 *
 *   So the server counts the quiet turns and, past a threshold, tells the DM to start
 *   an encounter in this response. Deterministic pacing, narrated by the model — the
 *   same division of labour as XP (ADR 0008) and the enemies' turn.
 */

/**
 * Turns of quiet tolerated before an encounter is forced, by difficulty.
 *
 * @description A threshold rather than a random chance: randomness would let a table
 *   go a whole session untouched by luck, which is the situation this exists to
 *   prevent.
 */
export const QUIET_TURNS_BY_DIFFICULTY = Object.freeze({
	casual: 14,
	standard: 9,
	hardcore: 6,
	merciless: 4,
});

/** Used when the lobby's difficulty is missing or unrecognised. */
const DEFAULT_DIFFICULTY = "standard";

/**
 * @description Resolves a difficulty to its quiet threshold, falling back to
 *   standard rather than to "never", which would silently restore the old behaviour.
 * @param {*} difficulty - The lobby setting.
 * @returns {number} Turns of quiet tolerated.
 */
function quietLimit(difficulty) {
	const key = typeof difficulty === "string" ? difficulty.toLowerCase().trim() : "";
	return QUIET_TURNS_BY_DIFFICULTY[key] ?? QUIET_TURNS_BY_DIFFICULTY[DEFAULT_DIFFICULTY];
}

/**
 * Decides whether this turn should bring an encounter.
 *
 * @param {object} params - Inputs.
 * @param {number} params.quietTurns - Consecutive turns with no living enemy.
 * @param {string} params.difficulty - The lobby difficulty.
 * @param {boolean} params.enemiesPresent - Whether a fight is already under way.
 * @returns {boolean} True when the DM should be told to start one.
 */
export function shouldForceEncounter({ quietTurns, difficulty, enemiesPresent } = {}) {
	// A fight already in progress is handled by the enemy-turn resolver; stacking
	// another onto it would pile encounters on a party that is already busy.
	if (enemiesPresent) return false;

	const quiet = Number(quietTurns);
	if (!Number.isFinite(quiet) || quiet < 0) return false;

	return quiet >= quietLimit(difficulty);
}

/** How hard the forced encounter should bite, by difficulty. */
const SEVERITY_BY_DIFFICULTY = Object.freeze({
	casual: "Keep it modest — a single weak creature or a pair of them, a scare rather than a threat.",
	standard: "Make it a fair fight: enough enemies that the party has to work, sized to their level.",
	hardcore: "Make it genuinely dangerous. The enemies are tactical and either outnumber the party or outclass them.",
	merciless: "Make it lethal. The party should be in real danger of losing someone here.",
});

/**
 * Builds the instruction that starts a fight.
 *
 * @description Names the fields the roster needs, because an encounter narrated
 *   without stat blocks in `updates.enemies` leaves the roster empty and the
 *   enemy-turn resolver with nothing to roll — the exact failure this exists to end.
 * @param {string} difficulty - The lobby difficulty.
 * @returns {string} The directive, for a system message.
 */
export function encounterDirective(difficulty) {
	const key = typeof difficulty === "string" ? difficulty.toLowerCase().trim() : "";
	const severity = SEVERITY_BY_DIFFICULTY[key] ?? SEVERITY_BY_DIFFICULTY[DEFAULT_DIFFICULTY];

	return [
		"ENCOUNTER DUE — START A FIGHT IN THIS RESPONSE, NOW.",
		"The party has gone too long without a threat. Something hostile finds them this turn,",
		"arising naturally from wherever they are and whatever they were just doing.",
		severity,
		"",
		"Required in this response:",
		'- Full stat blocks under updates in the "enemies" array: name, hp, max_hp, ac, str, dex, con, int, wis, cha, cr, and "status": "active".',
		'- "combat_over": false.',
		"- The enemies SURVIVE this turn and are still standing when the next player acts.",
		"  Do not let this one action wipe them out — a fight runs several rounds, and their",
		"  attacks are rolled by the server on the turns that follow.",
	].join("\n");
}
