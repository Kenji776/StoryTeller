/**
 * experience — turns defeated enemies into XP awards.
 *
 * @description XP used to be entirely at the Dungeon Master's discretion: the
 *   server awarded it only when the model volunteered an `updates.xp` block. Across
 *   a 30-turn playtest, including a confirmed kill, it never did, so every character
 *   finished at zero XP and the entire progression system — levelling, the level-up
 *   event, abilities gained on level-up — was unreachable in practice.
 *
 *   The enemy stat blocks carried a challenge rating the whole time. Reading it
 *   makes the award deterministic and testable, and takes the decision away from a
 *   narrator that has no reason to remember bookkeeping mid-scene. The model is
 *   still free to emit `updates.xp` for story milestones; that path is unchanged.
 */

/** Challenge rating → XP, from the standard monster table. */
const CR_XP = new Map([
	["0", 10], ["1/8", 25], ["1/4", 50], ["1/2", 100],
	["1", 200], ["2", 450], ["3", 700], ["4", 1100], ["5", 1800],
	["6", 2300], ["7", 2900], ["8", 3900], ["9", 5000], ["10", 5900],
	["11", 7200], ["12", 8400], ["13", 10000], ["14", 11500], ["15", 13000],
	["16", 15000], ["17", 18000], ["18", 20000], ["19", 22000], ["20", 25000],
	["21", 33000], ["22", 41000], ["23", 50000], ["24", 62000],
	["25", 75000], ["26", 90000], ["27", 105000], ["28", 120000],
	["29", 135000], ["30", 155000],
]);

/** The most XP any single enemy can be worth, used to clamp invented ratings. */
const MAX_CR_XP = CR_XP.get("30");

/** Fractional ratings, for when the model sends 0.25 rather than "1/4". */
const NUMERIC_FRACTIONS = new Map([[0, "0"], [0.125, "1/8"], [0.25, "1/4"], [0.5, "1/2"]]);

/**
 * Converts a challenge rating into an XP value.
 *
 * @description Accepts the several shapes the model actually emits: `"1/4"`, `"1"`,
 *   `1`, and `0.25`. A rating above the table is clamped to the highest entry rather
 *   than discarded, because awarding nothing for an invented CR 40 dragon is a worse
 *   failure than awarding too little.
 * @param {string|number} cr - The challenge rating.
 * @returns {number} The XP the enemy is worth; 0 if the rating cannot be read.
 */
export function xpForChallengeRating(cr) {
	if (cr === null || cr === undefined || typeof cr === "object") return 0;

	const key = String(cr).trim();
	if (!key) return 0;
	if (CR_XP.has(key)) return CR_XP.get(key);

	const numeric = Number(key);
	if (!Number.isFinite(numeric) || numeric < 0) return 0;

	if (NUMERIC_FRACTIONS.has(numeric)) return CR_XP.get(NUMERIC_FRACTIONS.get(numeric));

	const whole = String(Math.floor(numeric));
	return CR_XP.has(whole) ? CR_XP.get(whole) : MAX_CR_XP;
}

/**
 * Splits the XP from a batch of kills across the party.
 *
 * @description The total is divided evenly and rounded down, so a party never
 *   receives more XP than the enemies were worth — rounding up would mint XP that
 *   scales with party size. A share that rounds below one is raised to one, so
 *   killing something in a large party is never worth literally nothing.
 * @param {Array<{name: string, cr: string|number}>} kills - The enemies defeated.
 * @param {string[]} party - Names of the characters sharing the award.
 * @returns {Array<{player: string, amount: number, reason: string}>} One entry per
 *   character, in the shape `broadcastXPUpdates` consumes. Empty when there is
 *   nothing to award.
 */
export function xpForKills(kills, party) {
	if (!Array.isArray(kills) || !Array.isArray(party) || party.length === 0) return [];

	let total = 0;
	const named = [];
	for (const kill of kills) {
		const worth = xpForChallengeRating(kill?.cr);
		if (worth <= 0) continue;
		total += worth;
		if (kill?.name) named.push(String(kill.name));
	}
	if (total <= 0) return [];

	const share = Math.max(1, Math.floor(total / party.length));
	const reason = named.length ? `Defeated ${named.join(", ")}` : "Enemies defeated";

	return party.map((player) => ({ player, amount: share, reason }));
}
