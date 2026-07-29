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
 * @description Reduces whatever the lobby stored to a key the tables in this module
 *   actually carry. A lobby saved before difficulty existed holds `undefined`; a host
 *   editing settings by hand has produced `"Merciless "`. Falling back to standard
 *   rather than to "never" matters: "never" would silently restore the behaviour this
 *   module was written to end.
 * @param {*} difficulty - The lobby setting.
 * @returns {string} One of the four known keys.
 */
function difficultyKey(difficulty) {
	const key = typeof difficulty === "string" ? difficulty.toLowerCase().trim() : "";
	return key in QUIET_TURNS_BY_DIFFICULTY ? key : DEFAULT_DIFFICULTY;
}

/**
 * @description Resolves a difficulty to its quiet threshold.
 * @param {*} difficulty - The lobby setting.
 * @returns {number} Turns of quiet tolerated.
 */
function quietLimit(difficulty) {
	return QUIET_TURNS_BY_DIFFICULTY[difficultyKey(difficulty)];
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

/**
 * Enemies per living character, as `[fewest, most]`, by difficulty.
 *
 * @description The dial had no say in how *many* things attacked, so a lone character
 *   and a table of four were handed the same instruction and the solo player faced
 *   several times the opposition per head. 39% of stored games are solo, and that
 *   single omission is the whole of the measured solo penalty: at one enemy per
 *   character a solo character wins 84% of Hardcore goblin fights against a party of
 *   four's 94%, at two per character it wins 34%.
 *
 *   **The ceiling is one per character at every setting, and that is measurement, not
 *   taste.** Enemy count is by far the sharpest lever in this engine — over the goblin
 *   archetype it carries a Hardcore party of three from 93% to 11% in three steps —
 *   because it scales the opposition's damage output *and* its hit points at once.
 *   Pushed past one per character it does not make Hardcore and Merciless land nearer
 *   their 50%/25% targets, it makes a high-armour encounter unwinnable outright: a
 *   Merciless party of three facing four AC 18 hobgoblins wins 0% of the time. So
 *   difficulty above Standard is expressed in the multipliers in `client/difficulty.js`
 *   and in the *floor* here, never in the ceiling. See ADR 0022.
 */
/**
 * @description How many characters the encounter is being built for. Anything missing,
 *   zero, negative or unreadable counts as one: the smallest encounter, so a caller
 *   that forgets to pass the party cannot accidentally ambush a lone character with a
 *   party's worth of creatures.
 * @param {*} partySize - Living characters at the table.
 * @returns {number} A whole number of seats, at least one.
 */
function livingSeats(partySize) {
	const heads = Math.floor(Number(partySize));
	return Number.isFinite(heads) && heads > 0 ? heads : 1;
}

const ENEMIES_PER_CHARACTER = Object.freeze({
	casual: Object.freeze([0.5, 0.75]),
	standard: Object.freeze([0.75, 1]),
	hardcore: Object.freeze([1, 1]),
	merciless: Object.freeze([1, 1]),
});

/**
 * How many enemies this table should face.
 *
 * @description Sized to the party rather than to the world, so the same lobby setting
 *   means the same fight per head whether one character shows up or six. A count and
 *   not a challenge-rating budget because the engine's own difficulty comes mostly from
 *   the armour class the model invents, which no CR budget predicts — see ADR 0022.
 * @param {object} [params] - Inputs.
 * @param {*} [params.partySize] - Living characters at the table.
 * @param {*} [params.difficulty] - The lobby difficulty.
 * @returns {{min: number, max: number}} Whole enemy counts, `min <= max`, never below
 *   one. A party size that is missing, zero, negative or unreadable is budgeted as
 *   solo — the smallest encounter, so a caller that forgets cannot accidentally
 *   ambush one character with six creatures.
 */
export function encounterBudget({ partySize, difficulty } = {}) {
	const seats = livingSeats(partySize);
	const [fewest, most] = ENEMIES_PER_CHARACTER[difficultyKey(difficulty)];

	const min = Math.max(1, Math.round(seats * fewest));
	return { min, max: Math.max(min, Math.round(seats * most)) };
}

/**
 * Tells the narrator how big this fight should be.
 *
 * @description Shared verbatim by the forced-encounter directive and by the standing
 *   system prompt, which is the one that shapes most fights — the directive only fires
 *   when the table has gone quiet too long. Held separately the two named different
 *   counts, which is the drift this codebase has already paid for with armour class,
 *   spell slots and the condition vocabulary.
 *
 *   A lone character gets an extra paragraph, because capping the *count* at one does
 *   nothing about one creature sized for a party: measured, the CR 2 ogre that is a 55%
 *   fight for a party of three is a 0% fight for a level 3 character alone.
 * @param {object} [params] - Who is at the table.
 * @param {*} [params.partySize] - Living characters; treated as solo when absent.
 * @param {*} [params.difficulty] - The lobby difficulty.
 * @returns {string} The block, several lines, no trailing newline.
 */
export function encounterSizingBrief({ partySize, difficulty } = {}) {
	const { min, max } = encounterBudget({ partySize, difficulty });
	const seats = livingSeats(partySize);
	const count = min === max ? `exactly ${min}` : `${min} to ${max}`;

	const lines = [
		`SIZE IT TO THIS TABLE — ${seats} character${seats === 1 ? " is" : "s are"} playing.`,
		`Write ${count} hostile creature${max === 1 ? "" : "s"}, no more.`
			+ (max > 1 ? " One larger monster may stand in for the whole group." : ""),
	];

	if (seats === 1) {
		lines.push(
			"That one creature must be sized for ONE character, not for an adventuring party.",
			"A monster that would be a fair fight for a party kills a lone character outright:",
			"a level 3 character alone against a CR 2 ogre wins none of the time, where a party",
			"of three wins half. Pick something a single character of their level can beat.",
		);
	}

	lines.push(
		"Enemy numbers are the sharpest thing in this game: past one creature per character a",
		"fight stops being hard and becomes unwinnable, and the server already scales their",
		"attacks and damage for the difficulty, so a harsher setting does NOT mean more bodies.",
	);

	return lines.join("\n");
}

/**
 * How hard the forced encounter should bite, by difficulty.
 *
 * @description Character, not headcount — the count is stated separately and derived,
 *   so a line here that also named a number would be the second place the same fact
 *   lived, and the two would drift.
 */
const SEVERITY_BY_DIFFICULTY = Object.freeze({
	casual: "Keep it modest — weak creatures, a scare rather than a threat.",
	standard: "Make it a fair fight: enough that the party has to work, sized to their level.",
	hardcore: "Make it genuinely dangerous. The enemies are tactical and outclass the party.",
	merciless: "Make it lethal. The party should be in real danger of losing someone here.",
});

/**
 * Builds the instruction that starts a fight.
 *
 * @description Names the fields the roster needs, because an encounter narrated
 *   without stat blocks in `updates.enemies` leaves the roster empty and the
 *   enemy-turn resolver with nothing to roll — the exact failure this exists to end.
 *
 *   It also states the size of the table and the number of creatures that suits it.
 *   The count alone is not enough: told only "two to three", the model still writes
 *   for the party it imagines rather than the one that is playing, and a solo
 *   character got a pack.
 * @param {string} difficulty - The lobby difficulty.
 * @param {object} [params] - Who is at the table.
 * @param {*} [params.partySize] - Living characters; treated as solo when absent, which
 *   is the smallest encounter and therefore the safe failure.
 * @returns {string} The directive, for a system message.
 */
export function encounterDirective(difficulty, { partySize } = {}) {
	const severity = SEVERITY_BY_DIFFICULTY[difficultyKey(difficulty)];

	return [
		"ENCOUNTER DUE — START A FIGHT IN THIS RESPONSE, NOW.",
		"The party has gone too long without a threat. Something hostile finds them this turn,",
		"arising naturally from wherever they are and whatever they were just doing.",
		severity,
		"",
		encounterSizingBrief({ partySize, difficulty }),
		"",
		"Required in this response:",
		'- Full stat blocks under updates in the "enemies" array: name, hp, max_hp, ac, str, dex, con, int, wis, cha, cr, and "status": "active".',
		'- "combat_over": false.',
		"- The enemies SURVIVE this turn and are still standing when the next player acts.",
		"  Do not let this one action wipe them out — a fight runs several rounds, and their",
		"  attacks are rolled by the server on the turns that follow.",
	].join("\n");
}
