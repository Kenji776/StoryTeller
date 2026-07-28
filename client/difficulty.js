/**
 * The difficulty dial, and what it actually does.
 *
 * @description `difficulty` used to be four adjectives handed to the narrator. It
 *   shaped encounter composition and the tone of the prompt, and touched no number.
 *   Once attacks and damage became deterministic ([ADR 0018](../../docs/decisions/0018-player-attacks-are-rolled-by-the-server.md))
 *   that left the setting unable to affect the thing it is named after — combat got
 *   materially harder for everyone at once, and Casual was no gentler than Merciless.
 *
 *   The dial scales the **opposition**, not the party's dice, with one exception
 *   stated plainly to the host: a small adjustment to the party's own attack rolls,
 *   which is what lets Casual actually be casual now that AC decides hits.
 *
 *   These numbers are quoted verbatim in the settings window. They are here, once, so
 *   the description and the mathematics cannot drift apart — the failure this codebase
 *   has hit with spell slots, with armour class, and with the condition vocabulary.
 */

/** The difficulties, softest first. */
export const DIFFICULTIES = Object.freeze(["casual", "standard", "hardcore", "merciless"]);

const MODIFIERS = Object.freeze({
	casual: Object.freeze({
		enemyAttackBonus: -3,
		enemyDamageMultiplier: 0.5,
		enemyHpMultiplier: 0.6,
		playerAttackBonus: 3,
	}),
	standard: Object.freeze({
		enemyAttackBonus: 0,
		enemyDamageMultiplier: 1,
		enemyHpMultiplier: 1,
		playerAttackBonus: 0,
	}),
	hardcore: Object.freeze({
		enemyAttackBonus: 2,
		enemyDamageMultiplier: 1.25,
		enemyHpMultiplier: 1.25,
		playerAttackBonus: 0,
	}),
	merciless: Object.freeze({
		enemyAttackBonus: 4,
		enemyDamageMultiplier: 1.5,
		enemyHpMultiplier: 1.5,
		playerAttackBonus: -1,
	}),
});

/**
 * The modifiers for a difficulty.
 *
 * @description Frozen, because three call sites share the returned object and a
 *   caller editing it would change the rules for everyone mid-game.
 * @param {*} name - The lobby's `difficulty`.
 * @returns {{enemyAttackBonus: number, enemyDamageMultiplier: number,
 *   enemyHpMultiplier: number, playerAttackBonus: number}} The modifiers. An
 *   unrecognised difficulty gets Standard's, so a lobby saved before this existed
 *   plays a balanced game rather than one with undefined numbers.
 */
export function difficultyModifiers(name) {
	return MODIFIERS[name] ?? MODIFIERS.standard;
}

/**
 * @description Renders a multiplier as the plus-or-minus percentage a person reads.
 * @param {number} multiplier - e.g. 1.25.
 * @returns {string} e.g. "+25%".
 */
function asPercent(multiplier) {
	const delta = Math.round((multiplier - 1) * 100);
	return `${delta > 0 ? "+" : ""}${delta}%`;
}

/**
 * @description Renders a bonus with its sign, as it would appear on a character sheet.
 * @param {number} bonus - e.g. -3.
 * @returns {string} e.g. "-3".
 */
function asBonus(bonus) {
	return `${bonus > 0 ? "+" : ""}${bonus}`;
}

/**
 * Describes a difficulty in the terms it actually operates in.
 *
 * @description Shown to the host at setup. Adjectives are not a mechanical statement
 *   — "enemies are relentless" tells a host nothing they can plan around — so this
 *   states the real numbers, derived from the same table that applies them.
 * @param {*} name - The lobby's `difficulty`.
 * @returns {string[]} One line per effect, ready to render as a list.
 */
export function describeDifficulty(name) {
	const mods = difficultyModifiers(name);

	if (mods === MODIFIERS.standard) {
		return [
			"Enemies attack and damage you at their unmodified values.",
			"Your attack rolls are unmodified.",
			"Straight 5e maths — this is the baseline the other settings adjust from.",
		];
	}

	return [
		`Enemies are ${asBonus(mods.enemyAttackBonus)} to hit you.`,
		`Enemy damage is ${asPercent(mods.enemyDamageMultiplier)}.`,
		`Enemies have ${asPercent(mods.enemyHpMultiplier)} hit points.`,
		mods.playerAttackBonus === 0
			? "Your attack rolls are unmodified."
			: `Your attack rolls are ${asBonus(mods.playerAttackBonus)}.`,
	];
}
