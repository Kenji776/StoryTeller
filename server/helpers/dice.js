/**
 * Rolls a single die with the given number of sides.
 * @param {number} [sides=20] - The number of sides on the die.
 * @returns {number} A random integer between 1 and `sides` (inclusive).
 */
export function roll(sides=20){ return Math.floor(Math.random()*sides)+1; }

/**
 * Rolls a standard 20-sided die.
 * @returns {number} A random integer between 1 and 20 (inclusive).
 */
export function d20(){ return roll(20); }

/**
 * Calculates the D&D-style ability score modifier for a given stat value.
 * @param {number} [stat=10] - The ability score (e.g. Strength, Dexterity).
 * @returns {number} The modifier, computed as floor((stat - 10) / 2).
 */
export function mod(stat=10){ return Math.floor((stat-10)/2); }

/**
 * The most dice one expression may roll. A model writing "9999d6" should not be
 * able to occupy the event loop.
 */
const MAX_DICE = 100;

/** `2d4+2`, `d8`, `1d6-2`, or a bare `5`. */
const EXPRESSION = /^(?:(\d*)d(\d+))?([+-]?\d+)?$/;

/**
 * Rolls a dice expression such as `"2d4+2"`.
 *
 * @description The DM and the character builder both describe item effects this way
 *   (`attributes: { healing: "2d4+2" }`), so something has to read them. The random
 *   source is a parameter rather than `Math.random` so a potion's effect can be
 *   pinned in a test — the reason `CQ-5` exists.
 * @param {string} expr - The expression. Whitespace and case are ignored.
 * @param {Function} [rng=Math.random] - Returns a float in [0, 1).
 * @returns {{total: number, rolls: number[], modifier: number}|null} The result, or
 *   null when the expression cannot be read. The total is clamped at zero.
 */
export function rollExpression(expr, rng = Math.random) {
	if (typeof expr !== "string") return null;

	const cleaned = expr.replace(/\s+/g, "").toLowerCase();
	if (!cleaned) return null;

	const match = EXPRESSION.exec(cleaned);
	if (!match) return null;

	const [, countRaw, sidesRaw, modifierRaw] = match;

	// Neither dice nor a modifier means the expression was empty of everything the
	// pattern allows to be optional — "d" and "" both reach here.
	if (sidesRaw === undefined && modifierRaw === undefined) return null;

	const rolls = [];
	if (sidesRaw !== undefined) {
		const count = countRaw === "" ? 1 : Number(countRaw);
		const sides = Number(sidesRaw);
		if (!count || !sides || count > MAX_DICE) return null;

		for (let i = 0; i < count; i++) rolls.push(Math.floor(rng() * sides) + 1);
	}

	const modifier = modifierRaw ? Number(modifierRaw) : 0;
	const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;

	return { total: Math.max(0, total), rolls, modifier };
}
