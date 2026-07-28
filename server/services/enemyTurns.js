/**
 * enemyTurns — resolves what the enemies do, before the Dungeon Master describes it.
 *
 * @description Combat had no stakes. Across two full games the DM emitted an `hp`
 *   block on 4 of 92 turns and a negative delta on 2, despite constant fighting: the
 *   party killed everything and finished untouched, and `player:death` never fired
 *   outside unit tests. Strengthening the prompt moved damage from 0 turns in 57 to
 *   2 in 92 — better, and still not stakes. Asking a narrator mid-scene to remember
 *   arithmetic is asking for the thing it is worst at, exactly as with XP (ADR 0008).
 *
 *   So the enemies' attacks are rolled here and handed to the model as settled facts,
 *   the same way the server already resolves a player's dice roll and reports the
 *   outcome. The DM narrates the exchange it is given rather than inventing one. That
 *   ordering matters: resolving after the DM wrote would let it describe a clean
 *   dodge while the character's hit points fell.
 *
 *   Every source of randomness is injected so a test can script the dice (`TDD-8`).
 */

import { d20, roll, mod } from "../helpers/dice.js";
// One armour class, computed in one place. Held separately here and in
// `characterCapability.js`, the two disagreed, so the number a player was quoted was
// not the number the enemies rolled against.
import { armourClass } from "./armourClass.js";
// The dial that used to be four adjectives. Held here as well as in the settings
// window, the description and the arithmetic would drift.
import { difficultyModifiers } from "../../client/difficulty.js";

/**
 * Damage dice by challenge rating, as `[count, sides]`.
 *
 * @description Coarse on purpose. The point is that an ogre hurts more than a rat,
 *   not that this reproduces a monster manual the model invents its enemies from
 *   anyway.
 */
const DAMAGE_BY_CR = [
	{ upTo: 0.25, dice: [1, 6] },
	{ upTo: 1, dice: [1, 8] },
	{ upTo: 4, dice: [2, 6] },
	{ upTo: 10, dice: [2, 10] },
	{ upTo: Infinity, dice: [3, 10] },
];

/** Attack bonus granted by challenge rating, standing in for proficiency. */
const PROFICIENCY_BY_CR = [
	{ upTo: 4, bonus: 2 },
	{ upTo: 8, bonus: 3 },
	{ upTo: 12, bonus: 4 },
	{ upTo: Infinity, bonus: 5 },
];


/**
 * @description Reads a challenge rating, which arrives as "1/4", "1", or a number.
 * @param {*} cr - The rating.
 * @returns {number} The rating as a number; 0 when unreadable.
 */
function crValue(cr) {
	if (typeof cr === "number" && Number.isFinite(cr)) return Math.max(0, cr);
	const text = String(cr ?? "").trim();
	const fraction = text.match(/^(\d+)\s*\/\s*(\d+)$/);
	if (fraction) return Number(fraction[1]) / Number(fraction[2]);
	const n = Number(text);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * @description Picks the first table row whose threshold the rating falls under.
 * @param {Array<object>} table - Rows carrying `upTo`.
 * @param {number} cr - The numeric rating.
 * @returns {object} The matching row.
 */
function byCR(table, cr) {
	return table.find((row) => cr <= row.upTo) ?? table[table.length - 1];
}

/**
 * @description Whether a character can still be attacked. Zero hit points counts as
 *   down even without the flag, because the two are set by separate code paths and
 *   can disagree.
 * @param {object} player - The character sheet.
 * @returns {boolean} True if they are still standing.
 */
function isStanding(player) {
	if (player?.dead) return false;
	const hp = Number(player?.stats?.hp);
	return !Number.isFinite(hp) || hp > 0;
}

/**
 * Rolls the enemies' attacks for this round.
 *
 * @param {object} params - Inputs.
 * @param {object} params.enemies - Enemy records keyed by name.
 * @param {object} params.players - Character sheets keyed by name.
 * @param {function(): number} [params.rollD20] - Injected d20.
 * @param {function(number, number): number} [params.rollDamage] - Injected damage roll,
 *   taking `(count, sides)`.
 * @returns {{attacks: Array<object>, damage: Object<string, number>}} Every attack
 *   made, and the total damage per character. `damage` carries only characters that
 *   were actually hit, so it can be applied directly.
 */
export function resolveEnemyAttacks({ enemies, players, difficulty, rollD20 = d20, rollDamage } = {}) {
	const { enemyAttackBonus, enemyDamageMultiplier } = difficultyModifiers(difficulty);
	const rollDice = rollDamage ?? ((count, sides) => {
		let total = 0;
		for (let i = 0; i < count; i++) total += roll(sides);
		return total;
	});

	const attackers = Object.values(enemies ?? {}).filter(
		(e) => e && e.status !== "dead" && e.status !== "fled" && (Number(e.hp) || 0) > 0,
	);
	const targets = Object.values(players ?? {}).filter(isStanding);

	if (!attackers.length || !targets.length) return { attacks: [], damage: {} };

	const attacks = [];
	const damage = {};

	attackers.forEach((enemy, index) => {
		// Round-robin rather than everyone piling onto one character: three goblins
		// focusing a level-1 party member is an instant kill and reads as the engine
		// singling somebody out.
		const target = targets[index % targets.length];
		const cr = crValue(enemy.cr);

		const bonus = mod(Number(enemy.str) || 10) + byCR(PROFICIENCY_BY_CR, cr).bonus + enemyAttackBonus;
		const base = rollD20();
		const total = base + bonus;
		const ac = armourClass(target);

		// A natural 20 always lands and a natural 1 always fails, whatever the maths.
		const hit = base === 20 || (base !== 1 && total >= ac);

		let dealt = 0;
		if (hit) {
			const [count, sides] = byCR(DAMAGE_BY_CR, cr).dice;
			const raw = rollDice(count, sides) + mod(Number(enemy.str) || 10);
			// Scaled after the roll rather than by inflating the dice, so the shape of
			// the distribution is unchanged and only its magnitude moves. Rounded and
			// floored at 1: a blow that lands always costs something.
			dealt = Math.max(1, Math.round(raw * enemyDamageMultiplier));
			damage[target.name] = (damage[target.name] ?? 0) + dealt;
		}

		attacks.push({
			enemy: enemy.name,
			target: target.name,
			base,
			bonus,
			total,
			ac,
			hit,
			damage: dealt,
		});
	});

	return { attacks, damage };
}

/**
 * Renders resolved attacks as facts for the DM to narrate.
 *
 * @description States the damage explicitly so the model describes the blow that
 *   was actually struck rather than inventing a different number, which is the whole
 *   reason this runs before the narration instead of after it.
 * @param {Array<object>} attacks - The result of `resolveEnemyAttacks`.
 * @returns {string} One line per attack, or "" when nothing happened.
 */
export function describeAttacks(attacks) {
	if (!Array.isArray(attacks) || !attacks.length) return "";

	const lines = attacks.map((a) => (a.hit
		? `- ${a.enemy} attacks ${a.target}: rolled ${a.total} against AC ${a.ac} — HITS for ${a.damage} damage.`
		: `- ${a.enemy} attacks ${a.target}: rolled ${a.total} against AC ${a.ac} — MISSES.`));

	return `ENEMY ACTIONS THIS ROUND (already resolved — narrate exactly these outcomes, do not change them and do not add "hp" updates for them):\n${lines.join("\n")}`;
}

/**
 * Removes damage the DM issued for a round the server had already resolved.
 *
 * @description The prompt tells the model plainly not to add `hp` updates for
 *   attacks it has been handed. It does anyway. In a live game Sylvie went 12 to 7
 *   ("Struck in combat", the rolled damage) and then to 2 ("Goblin attack", the DM's
 *   own entry for the same blow): five points applied twice, and a character two hit
 *   points from a death that had not really happened.
 *
 *   An instruction is not a mechanism. On a round the server resolved, damage is the
 *   server's; healing is still the DM's, so a potion drunk in the same turn survives.
 *   Traps and falls keep working on every turn without an enemy round, which is when
 *   the model is the only thing that knows about them.
 * @param {*} updates - The DM's `updates.hp` array.
 * @param {boolean} resolved - Whether an enemy round was resolved this turn.
 * @returns {Array<object>} The updates that should still be applied.
 */
export function stripResolvedDamage(updates, resolved) {
	if (!Array.isArray(updates)) return [];
	if (!resolved) return updates;

	return updates.filter((u) => {
		const delta = Number(u?.delta);
		// Only unambiguous damage is dropped. A zero or unreadable delta is left for
		// the normal path to reject, rather than guessed at here.
		return !(Number.isFinite(delta) && delta < 0);
	});
}
