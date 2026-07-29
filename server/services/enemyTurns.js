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
 *
 *   Exported so `spellAttacks.js` grades a creature's saving throws on the same reading
 *   of the same field. A second parser would drift, and the divergence would be silent.
 * @param {*} cr - The rating.
 * @returns {number} The rating as a number; 0 when unreadable.
 */
export function crValue(cr) {
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
 * The most of a character's maximum health one blow may take. Three-quarters leaves a
 * character at full health standing after any single hit, however large, while leaving
 * two hits lethal.
 */
const ONE_BLOW_SHARE = 0.75;

/**
 * The most attacks one action may contain, however the model writes the stat block.
 * A "multiattack": 50 is a typo or a joke, not a monster.
 */
const MAX_ATTACKS_PER_ACTION = 4;

/**
 * @description How many times a creature swings when it spends its action. One,
 *   unless its stat block says otherwise — an NPC has the same action economy as a
 *   player, and multiattack is the specific perk that varies it.
 * @param {object} enemy - The roster entry.
 * @returns {number} A whole number between 1 and `MAX_ATTACKS_PER_ACTION`.
 */
function attacksPerAction(enemy) {
	const stated = Math.floor(Number(enemy?.multiattack ?? enemy?.attacks));
	if (!Number.isFinite(stated) || stated < 1) return 1;
	return Math.min(MAX_ATTACKS_PER_ACTION, stated);
}

/**
 * @description The most damage one attack may deal to a character.
 * @param {object} player - The character sheet.
 * @returns {number} The cap, or Infinity when the sheet states no maximum — inventing
 *   one from current hit points would shrink the cap as they were worn down, which is
 *   the opposite of what it is for.
 */
function oneBlowCap(player) {
	const max = Number(player?.stats?.max_hp);
	return Number.isFinite(max) && max > 0 ? Math.max(1, Math.floor(max * ONE_BLOW_SHARE)) : Infinity;
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
export function resolveEnemyAttacks({ enemies, players, difficulty, round, turnIndex, partySize, rollD20 = d20, rollDamage, tactics = null } = {}) {
	const { enemyAttackBonus, enemyDamageMultiplier } = difficultyModifiers(difficulty);
	const rollDice = rollDamage ?? ((count, sides) => {
		let total = 0;
		for (let i = 0; i < count; i++) total += roll(sides);
		return total;
	});

	const living = Object.values(enemies ?? {}).filter(
		(e) => e && e.status !== "dead" && e.status !== "fled" && (Number(e.hp) || 0) > 0,
	);
	const targets = Object.values(players ?? {}).filter(isStanding);

	// An NPC has an action and spends it once per round, exactly as a player does.
	//
	// This runs on every `action:submit`, so without a share-out every enemy swung on
	// every player's turn: a party of three facing three goblins took nine goblin
	// attacks a round against their three, and the penalty grew with party size. A
	// live merciless run killed a level 3 fighter in three turns to two CR ½ hobgoblins.
	//
	// The first fix sliced the living roster by the acting player's index. That got the
	// aggregate right and the rule wrong: kill one goblin mid-round and the array
	// reindexes, so another silently loses its turn while a third takes one it had
	// already had. Whether a creature has acted is now recorded on the creature, and
	// the pending ones are dealt out evenly across the turns still to come — so the
	// bookkeeping survives anything happening to the roster mid-round.
	//
	// A caller that does not know the round — the timer path, an admin-forced round —
	// gets the whole roster, which is the old behaviour and the safe one.
	const knowsRound = Number.isFinite(Number(round));
	let attackers = living;

	if (knowsRound) {
		const pending = living.filter((e) => Number(e.actedInRound) !== Number(round));
		const seats = Math.max(1, Math.floor(Number(partySize)) || 1);
		const seat = Number.isFinite(Number(turnIndex))
			? ((Math.floor(Number(turnIndex)) % seats) + seats) % seats
			: 0;
		// Share what is left over the turns still to come, so the last player does not
		// inherit everybody the earlier turns did not get to.
		const turnsRemaining = Math.max(1, seats - seat);
		attackers = pending.slice(0, Math.ceil(pending.length / turnsRemaining));
	}

	if (!attackers.length || !targets.length) return { attacks: [], damage: {}, acted: [], moves: [], outOfReach: [] };

	const attacks = [];
	const damage = {};
	// Both empty for a lobby without a map, so a caller that never opted in reads the same shape
	// it always did with nothing in the new fields.
	const moves = [];
	const outOfReach = [];

	// Offset by the acting player's turn, not started from zero.
	//
	// This function runs once per player turn and the share-out above usually hands it a single
	// enemy, so a counter local to the call never advanced past its first value: `targets[0]`, every
	// turn, for the whole fight. The comment below promised round-robin and delivered "always hit
	// whoever is first in the players object", which picked the party off in object order.
	//
	// A simulation with the tactical map switched off is what surfaced it — Dorn at 0 hit points
	// while the other three finished untouched. Deriving the offset from `turnIndex` advances it
	// between calls while keeping the result a function of state, so a fight is still reproducible
	// (`TDD-8`) rather than depending on a counter that would leak between lobbies.
	const turnOffset = Number.isFinite(Number(turnIndex)) ? Math.abs(Math.floor(Number(turnIndex))) : 0;
	let swing = turnOffset;
	attackers.forEach((enemy) => {
		const cr = crValue(enemy.cr);

		// With a map in play a creature may walk before it swings. Done here rather than before
		// the round because actions are shared out across the players' turns: moving everybody up
		// front would have each enemy travel once per player turn and strike once per round.
		const walked = tactics?.beforeStrike?.(enemy) ?? null;
		if (walked) moves.push(walked);

		// The exception to one-action-one-attack. A creature whose stat block says it
		// strikes twice does so — within its single action, not as extra actions, so it
		// still cannot come round again later in the same round.
		for (let blow = 0; blow < attacksPerAction(enemy); blow++) {
		// Round-robin rather than everyone piling onto one character: three goblins
		// focusing a level-1 party member is an instant kill and reads as the engine
		// singling somebody out.
		//
		// With a map, `tactics` replaces that with proximity — the nearest character, which is
		// what makes stepping in front of somebody mean anything. Round-robin remains the whole
		// of the behaviour for a lobby that never opted in, because there is nothing sensible to
		// prefer when nobody has a position.
		const target = tactics?.pickTarget
			? tactics.pickTarget(enemy, targets)
			: targets[swing++ % targets.length];
		if (!target) continue;

		// A creature that closed but fell short does not get to swing. Distance costing the
		// monsters something is the other half of positioning mattering: before this, an enemy
		// forty feet away hit you anyway.
		if (tactics?.canStrike && !tactics.canStrike(enemy, target)) {
			outOfReach.push({ enemy: enemy.name, target: target.name });
			continue;
		}

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

			// No single blow deletes a character at full health. At a damage multiplier
			// of 2 a CR 2 ogre one-shot a level 3 character in 82% of simulated fights,
			// which is both miserable and makes the difficulty dial useless: the only
			// way to make a fight harder was to make it arbitrary. Capped as a share of
			// the maximum so it holds at every level.
			//
			// This is not immortality. It caps one *blow*, not a turn, and a character
			// already wounded still dies — which is the point.
			dealt = Math.min(dealt, oneBlowCap(target));

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
		}
	});

	// Who spent their action. The caller records it on the roster — this stays a
	// resolver and does not write to the enemies it was handed, the same split
	// `resolveAttack` keeps from `applyEnemyDamage`.
	return { attacks, damage, acted: attackers.map((e) => e.name), moves, outOfReach };
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
