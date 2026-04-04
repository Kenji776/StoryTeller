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
