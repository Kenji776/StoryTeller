/**
 * A character's armour class — the one place that computes it.
 *
 * @description It used to be "whatever number is on the armour, else 10 + DEX". A
 *   DEX 16 rogue was therefore AC 13 naked and AC 11 in leather, so putting armour on
 *   made her easier to hit — while `armor.json`'s own note for that entry reads
 *   "AC 11 + DEX modifier". The data always said to add dexterity; the code dropped
 *   it the moment anything was worn.
 *
 *   It was also computed in two places with two different rules, so the armour class
 *   the advisor quoted to a player and the one the enemies rolled against were not the
 *   same number. That is the drift `describePartyForDM` was already bitten by, and the
 *   fix is the same: one function, every caller.
 */

import { mod } from "../helpers/dice.js";

/** Armour class for a character wearing nothing but their reflexes. */
export const UNARMOURED_BASE = 10;

/**
 * How much dexterity each armour category lets you keep. `null` means none at all —
 * distinct from a cap of 0, because a cap still lets a *negative* modifier through
 * and heavy armour ignores dexterity in both directions.
 *
 * An unrecognised type is treated as light rather than as "no dexterity". The DM
 * invents armour, and dropping the modifier for an unfamiliar word is precisely the
 * behaviour that produced the original inversion.
 */
const DEX_ALLOWANCE = {
	light: Infinity,
	medium: 2,
	heavy: null,
};

/**
 * @description Reads a number that has to be positive to count.
 * @param {*} value - The candidate.
 * @returns {number} The number, or 0 when it cannot be read.
 */
function positive(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Computes a character's armour class.
 *
 * @description Wearing armour is never worse than wearing none: the unarmoured value
 *   is the floor, so a character in something flimsy keeps their reflexes rather than
 *   being punished for the upgrade.
 * @param {object} player - The character sheet; `stats.dex`, `armor` and `shield` are read.
 * @returns {number} The armour class, always a whole number of at least 1.
 */
export function armourClass(player) {
	const dexMod = mod(Number(player?.stats?.dex) || 10);
	const unarmoured = UNARMOURED_BASE + dexMod;

	const armour = player?.armor;
	const base = positive(armour?.ac);
	const shield = positive(player?.shield?.ac);

	if (!base) return Math.max(1, unarmoured + shield);

	const type = String(armour.type || armour.armor_type || "light").trim().toLowerCase();
	const allowance = type in DEX_ALLOWANCE ? DEX_ALLOWANCE[type] : DEX_ALLOWANCE.light;
	const dexApplied = allowance === null ? 0 : Math.min(dexMod, allowance);

	// `loot.js` folds an enchantment into `ac` before it ever gets here, so `bonus` is
	// only for items granted by an admin or carried in on an imported sheet. Adding
	// both would count the same +1 twice.
	const enchantment = Number(armour.bonus) || 0;

	const worn = base + dexApplied + enchantment + shield;

	return Math.max(1, Math.max(worn, unarmoured + shield));
}
