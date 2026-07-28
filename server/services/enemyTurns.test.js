/**
 * Tests for resolving the enemies' turn.
 *
 * @description Combat had no stakes. Across two full games the Dungeon Master
 *   emitted an `hp` block on 4 of 92 turns and a negative delta on 2, despite
 *   constant fighting — the party killed everything and finished untouched, and
 *   `player:death` never fired outside unit tests. Strengthening the prompt moved
 *   damage from 0 turns in 57 to 2 in 92, which is not stakes.
 *
 *   So the enemies' attacks are rolled here, deterministically, before the DM writes
 *   — the same shape as the player dice rolls the server already resolves and hands
 *   over as facts. The model narrates the exchange it is given rather than inventing
 *   one and forgetting the arithmetic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveEnemyAttacks, describeAttacks, stripResolvedDamage } from "./enemyTurns.js";

/** A die that returns a scripted sequence, so every test is exact (`TDD-8`). */
const scripted = (...values) => { let i = 0; return () => values[i++ % values.length]; };

/**
 * @description Three goblins, all able to fight.
 * @param {object} [over] - Fields merged onto each enemy.
 * @returns {object} An enemy roster keyed by name.
 */
function goblins(over = {}) {
	const make = (name) => ({ name, hp: 7, max_hp: 7, ac: 15, str: 12, dex: 14, cr: "1/4", status: "active", ...over });
	return { "Goblin 1": make("Goblin 1"), "Goblin 2": make("Goblin 2"), "Goblin 3": make("Goblin 3") };
}

/**
 * @description A party of two, one armoured and one not.
 * @param {object} [over] - Fields merged onto every member.
 * @returns {object} Players keyed by name.
 */
function party(over = {}) {
	return {
		Brannor: { name: "Brannor", stats: { hp: 12, max_hp: 12, dex: 10 }, armor: { name: "Chain Mail", ac: 16 }, ...over },
		Sylvie: { name: "Sylvie", stats: { hp: 9, max_hp: 9, dex: 16 }, ...over },
	};
}

// ===== Who swings =====

test("every living enemy attacks once", () => {
	const result = resolveEnemyAttacks({ enemies: goblins(), players: party(), rollD20: scripted(10) });
	assert.equal(result.attacks.length, 3);
	assert.deepEqual(result.attacks.map((a) => a.enemy).sort(), ["Goblin 1", "Goblin 2", "Goblin 3"]);
});

test("dead and fled enemies do not attack", () => {
	const enemies = goblins();
	enemies["Goblin 2"].status = "dead";
	enemies["Goblin 3"].status = "fled";
	const result = resolveEnemyAttacks({ enemies, players: party(), rollD20: scripted(10) });
	assert.deepEqual(result.attacks.map((a) => a.enemy), ["Goblin 1"]);
});

test("an enemy at zero hit points does not attack even if its status says otherwise", () => {
	const enemies = goblins();
	enemies["Goblin 1"].hp = 0;
	const result = resolveEnemyAttacks({ enemies, players: party(), rollD20: scripted(10) });
	assert.ok(!result.attacks.some((a) => a.enemy === "Goblin 1"), JSON.stringify(result.attacks));
});

test("no enemies means no attacks and no damage", () => {
	for (const empty of [{}, null, undefined]) {
		const result = resolveEnemyAttacks({ enemies: empty, players: party(), rollD20: scripted(20) });
		assert.deepEqual(result.attacks, []);
		assert.deepEqual(result.damage, {});
	}
});

// ===== Who is hit =====

test("attacks are spread across the party rather than focused on one character", () => {
	// Three goblins all beating on one level-1 character is an instant kill and reads
	// as the engine picking on somebody.
	const result = resolveEnemyAttacks({ enemies: goblins(), players: party(), rollD20: scripted(10) });
	assert.equal(new Set(result.attacks.map((a) => a.target)).size, 2);
});

test("a downed character is not attacked further", () => {
	const p = party();
	p.Brannor.stats.hp = 0;
	const result = resolveEnemyAttacks({ enemies: goblins(), players: p, rollD20: scripted(10) });
	assert.ok(result.attacks.every((a) => a.target === "Sylvie"), JSON.stringify(result.attacks));
});

test("a character flagged dead is not attacked", () => {
	const p = party();
	p.Brannor.dead = true;
	const result = resolveEnemyAttacks({ enemies: goblins(), players: p, rollD20: scripted(10) });
	assert.ok(result.attacks.every((a) => a.target === "Sylvie"));
});

test("nobody left standing means nobody is attacked", () => {
	const p = party();
	p.Brannor.stats.hp = 0;
	p.Sylvie.stats.hp = 0;
	const result = resolveEnemyAttacks({ enemies: goblins(), players: p, rollD20: scripted(20) });
	assert.deepEqual(result.attacks, []);
});

// ===== Hitting and missing =====

test("a roll that beats armour class hits, one that falls short misses", () => {
	// Brannor is AC 16. A goblin's bonus is +3 (str 12 -> +1, proficiency +2).
	const hit = resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, ac: 15, str: 12, cr: "1/4", status: "active" } }, players: { Brannor: party().Brannor }, rollD20: scripted(15) });
	assert.equal(hit.attacks[0].hit, true, JSON.stringify(hit.attacks[0]));

	const miss = resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, ac: 15, str: 12, cr: "1/4", status: "active" } }, players: { Brannor: party().Brannor }, rollD20: scripted(5) });
	assert.equal(miss.attacks[0].hit, false, JSON.stringify(miss.attacks[0]));
});

test("a natural twenty always hits and a natural one always misses", () => {
	const armoured = { Tank: { name: "Tank", stats: { hp: 20, max_hp: 20, dex: 10 }, armor: { ac: 99 } } };
	const crit = resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, ac: 15, str: 1, cr: "0", status: "active" } }, players: armoured, rollD20: scripted(20) });
	assert.equal(crit.attacks[0].hit, true);

	const naked = { Naked: { name: "Naked", stats: { hp: 20, max_hp: 20, dex: 1 } } };
	const fumble = resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, ac: 15, str: 20, cr: "5", status: "active" } }, players: naked, rollD20: scripted(1) });
	assert.equal(fumble.attacks[0].hit, false);
});

test("armour class falls back to dexterity when nothing is worn", () => {
	// Sylvie wears nothing and has dex 16, so AC 13. A total of 13 hits, 12 misses.
	const only = { Sylvie: party().Sylvie };
	assert.equal(resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, str: 12, cr: "1/4", status: "active" } }, players: only, rollD20: scripted(10) }).attacks[0].hit, true);
	assert.equal(resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, str: 12, cr: "1/4", status: "active" } }, players: only, rollD20: scripted(9) }).attacks[0].hit, false);
});

// ===== Damage =====

test("damage is dealt only on a hit", () => {
	const missed = resolveEnemyAttacks({ enemies: goblins(), players: party(), rollD20: scripted(1) });
	assert.deepEqual(missed.damage, {});
	assert.ok(missed.attacks.every((a) => a.damage === 0));
});

test("a hit deals damage and it is totalled per character", () => {
	const result = resolveEnemyAttacks({ enemies: goblins(), players: party(), rollD20: scripted(20) });
	assert.ok(Object.values(result.damage).every((n) => n > 0), JSON.stringify(result.damage));
	const totalled = Object.values(result.damage).reduce((a, b) => a + b, 0);
	assert.equal(totalled, result.attacks.reduce((n, a) => n + a.damage, 0));
});

test("a tougher enemy hits harder than a weaker one", () => {
	// The stub must respect the dice it is handed — a flat `() => 4` returns the same
	// number for 1d6 and 3d10, so it could not show the difference it was asserting.
	const maxRoll = (count, sides) => count * sides;
	const weak = resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 9, str: 12, cr: "1/8", status: "active" } }, players: party(), rollD20: scripted(20), rollDamage: maxRoll });
	const boss = resolveEnemyAttacks({ enemies: { b: { name: "b", hp: 9, str: 12, cr: "5", status: "active" } }, players: party(), rollD20: scripted(20), rollDamage: maxRoll });
	assert.ok(boss.attacks[0].damage > weak.attacks[0].damage, `${boss.attacks[0].damage} vs ${weak.attacks[0].damage}`);
});

test("damage is never negative and never zero on a hit", () => {
	const result = resolveEnemyAttacks({ enemies: goblins(), players: party(), rollD20: scripted(20), rollDamage: () => 1 });
	assert.ok(result.attacks.every((a) => a.damage >= 1), JSON.stringify(result.attacks));
});

// ===== Determinism =====

test("the same rolls always produce the same result", () => {
	// Both sources of randomness have to be injected. Leaving the damage dice real
	// meant this compared two Math.random() draws and would have failed intermittently
	// while appearing to test determinism.
	const args = () => ({ enemies: goblins(), players: party(), rollD20: scripted(11, 4, 18), rollDamage: (c, s) => c * s });
	assert.deepEqual(resolveEnemyAttacks(args()), resolveEnemyAttacks(args()));
});

// ===== What the DM is told =====

test("the attacks are described as facts the DM can narrate", () => {
	const result = resolveEnemyAttacks({ enemies: goblins(), players: party(), rollD20: scripted(20, 1, 20) });
	const text = describeAttacks(result.attacks);

	assert.match(text, /Goblin 1/);
	assert.match(text, /hit|hits/i);
	assert.match(text, /miss|misses/i);
	assert.ok(!text.includes("undefined"), text);
});

test("nothing to describe yields an empty string, not a heading with no content", () => {
	assert.equal(describeAttacks([]), "");
	assert.equal(describeAttacks(null), "");
});

test("the description states the damage so the DM cannot invent a different number", () => {
	const result = resolveEnemyAttacks({ enemies: { g: { name: "g", hp: 7, str: 12, cr: "1/4", status: "active" } }, players: party(), rollD20: scripted(20), rollDamage: () => 5 });
	assert.match(describeAttacks(result.attacks), new RegExp(String(result.attacks[0].damage)));
});

// ── The DM double-wounding people ────────────────────────────────────────────
//
// Told plainly not to add hp updates for attacks the server had already resolved,
// the model did it anyway. In a live game Sylvie went 12 -> 7 ("Struck in combat",
// the rolled damage) -> 2 ("Goblin attack", the DM's own entry for the same blow):
// five points of damage applied twice. A prompt instruction is not a mechanism.

test("the DM's own damage is discarded on a round the server already resolved", () => {
	const kept = stripResolvedDamage([{ player: "Sylvie", delta: -5, reason: "Goblin attack" }], true);
	assert.deepEqual(kept, []);
});

test("healing survives a resolved round", () => {
	// Only damage is the server's during combat. A potion drunk on the same turn is
	// still the DM's to narrate and must not be swallowed.
	const kept = stripResolvedDamage([{ player: "Sylvie", delta: 5, reason: "Healing potion" }], true);
	assert.equal(kept.length, 1);
});

test("the DM keeps its damage on a turn with no enemy round", () => {
	// Traps, falls and poison are still its business.
	const updates = [{ player: "Orrin", delta: -3, reason: "Stepped on a dart trap" }];
	assert.deepEqual(stripResolvedDamage(updates, false), updates);
});

test("a mixed batch keeps the healing and drops the damage", () => {
	const kept = stripResolvedDamage([
		{ player: "Sylvie", delta: -5, reason: "Goblin attack" },
		{ player: "Brannor", delta: 4, reason: "Second Wind" },
		{ player: "Orrin", delta: -2, reason: "Goblin attack" },
	], true);
	assert.deepEqual(kept.map((u) => u.player), ["Brannor"]);
});

test("a zero or unreadable delta is left alone rather than guessed at", () => {
	const updates = [{ player: "A", delta: 0 }, { player: "B", delta: "x" }, { player: "C" }];
	assert.deepEqual(stripResolvedDamage(updates, true), updates);
});

test("a missing or malformed batch yields an empty list rather than throwing", () => {
	for (const bad of [null, undefined, "hp", 7, {}]) {
		assert.deepEqual(stripResolvedDamage(bad, true), []);
	}
});

// ===== Difficulty =====
//
// The dial used to be four adjectives handed to the narrator. These pin it to the
// arithmetic, so "Casual" is measurably gentler than "Merciless" rather than a
// difference of tone.

test("difficulty shifts the enemies' chance to hit", () => {
	const enemies = { Goblin: { name: "Goblin", hp: 7, max_hp: 7, ac: 15, str: 10, cr: "1/4", status: "active" } };
	const players = { Ayla: { name: "Ayla", stats: { hp: 20, max_hp: 20, dex: 10 }, armor: { name: "Chain Shirt", ac: 13, type: "medium" } } };

	const attackOn = (difficulty) => resolveEnemyAttacks({
		enemies, players, difficulty, rollD20: () => 10, rollDamage: () => 4,
	}).attacks[0];

	// The same d20 against the same armour: a swing that misses on Casual lands on
	// Merciless purely because of the setting.
	assert.ok(attackOn("merciless").total > attackOn("standard").total);
	assert.ok(attackOn("casual").total < attackOn("standard").total);
});

test("difficulty scales the damage an enemy deals", () => {
	// A generous maximum, so the one-blow cap is not what is being measured here.
	const enemies = { Ogre: { name: "Ogre", hp: 30, max_hp: 30, ac: 11, str: 10, cr: "2", status: "active" } };
	const players = { Ayla: { name: "Ayla", stats: { hp: 200, max_hp: 200, dex: 10 }, armor: null } };

	const dealt = (difficulty) => resolveEnemyAttacks({
		enemies, players, difficulty, rollD20: () => 20, rollDamage: () => 8,
	}).damage.Ayla;

	assert.equal(dealt("standard"), 8);
	assert.equal(dealt("casual"), 4);
	assert.equal(dealt("hardcore"), 12);
	assert.equal(dealt("merciless"), 16);
});

test("a scaled blow still takes at least one hit point", () => {
	const enemies = { Rat: { name: "Rat", hp: 2, max_hp: 2, ac: 10, str: 4, cr: "0", status: "active" } };
	const players = { Ayla: { name: "Ayla", stats: { hp: 20, max_hp: 20, dex: 10 }, armor: null } };

	const result = resolveEnemyAttacks({ enemies, players, difficulty: "casual", rollD20: () => 20, rollDamage: () => 1 });

	assert.ok(result.damage.Ayla >= 1, `dealt ${result.damage.Ayla}`);
});

test("damage is always a whole number of hit points", () => {
	const enemies = { Ogre: { name: "Ogre", hp: 30, max_hp: 30, ac: 11, str: 12, cr: "2", status: "active" } };
	const players = { Ayla: { name: "Ayla", stats: { hp: 40, max_hp: 40, dex: 10 }, armor: null } };

	for (const difficulty of ["casual", "standard", "hardcore", "merciless"]) {
		for (const rolled of [1, 3, 5, 7, 9]) {
			const dealt = resolveEnemyAttacks({ enemies, players, difficulty, rollD20: () => 20, rollDamage: () => rolled }).damage.Ayla;
			assert.ok(Number.isInteger(dealt), `${difficulty} rolling ${rolled} dealt ${dealt}`);
		}
	}
});

test("an absent or unknown difficulty plays as standard", () => {
	const enemies = { Ogre: { name: "Ogre", hp: 30, max_hp: 30, ac: 11, str: 10, cr: "2", status: "active" } };
	const players = { Ayla: { name: "Ayla", stats: { hp: 40, max_hp: 40, dex: 10 }, armor: null } };
	const dealt = (difficulty) => resolveEnemyAttacks({ enemies, players, difficulty, rollD20: () => 20, rollDamage: () => 8 }).damage.Ayla;

	assert.equal(dealt(undefined), 8);
	assert.equal(dealt("nightmare"), 8);
});

// ===== Action economy =====
//
// The enemy round fires inside `action:submit`, so every enemy used to swing every
// time *any* player acted: a party of three facing three goblins took nine goblin
// attacks per round against their three, and the penalty grew with party size. A
// live merciless run killed a level 3 fighter in three turns to two CR 1/2
// hobgoblins. The roster is now spread across the party's turns.

/**
 * @description Builds a party of the given size.
 * @param {number} size - How many characters.
 * @returns {object} Players keyed by name.
 */
function economyParty(size) {
	return Object.fromEntries(
		Array.from({ length: size }, (_, i) => [`P${i}`, { name: `P${i}`, stats: { hp: 30, max_hp: 30, dex: 10 }, armor: null }])
	);
}

/**
 * @description Builds a roster of identical enemies.
 * @param {number} count - How many.
 * @returns {object} Enemies keyed by name.
 */
function horde(count) {
	return Object.fromEntries(
		Array.from({ length: count }, (_, i) => [`E${i}`, { name: `E${i}`, hp: 7, max_hp: 7, ac: 15, str: 10, cr: "1/4", status: "active" }])
	);
}

test("each enemy attacks exactly once over a full round of player turns", () => {
	const enemies = horde(3);
	const players = economyParty(3);

	const swings = [];
	for (let turnIndex = 0; turnIndex < 3; turnIndex++) {
		const { attacks } = resolveEnemyAttacks({ enemies, players, turnIndex, partySize: 3, rollD20: () => 10, rollDamage: () => 1 });
		swings.push(...attacks.map((a) => a.enemy));
	}

	assert.equal(swings.length, 3, `three enemies over three turns should swing three times, got ${swings.length}`);
	assert.deepEqual([...swings].sort(), ["E0", "E1", "E2"]);
});

test("a single player faces the whole roster on their turn", () => {
	// Their turn *is* the round, so nothing should be held back.
	const { attacks } = resolveEnemyAttacks({
		enemies: horde(3), players: economyParty(1), turnIndex: 0, partySize: 1, rollD20: () => 10, rollDamage: () => 1,
	});

	assert.equal(attacks.length, 3);
});

test("more enemies than players means several act on one turn", () => {
	// Six goblins against two characters: three per player turn, six over the round.
	const enemies = horde(6);
	const players = economyParty(2);

	const first = resolveEnemyAttacks({ enemies, players, turnIndex: 0, partySize: 2, rollD20: () => 10, rollDamage: () => 1 });
	const second = resolveEnemyAttacks({ enemies, players, turnIndex: 1, partySize: 2, rollD20: () => 10, rollDamage: () => 1 });

	assert.equal(first.attacks.length, 3);
	assert.equal(second.attacks.length, 3);
	assert.deepEqual([...first.attacks, ...second.attacks].map((a) => a.enemy).sort(), ["E0", "E1", "E2", "E3", "E4", "E5"]);
});

test("fewer enemies than players means some turns draw no attack", () => {
	// One goblin against three characters attacks once per round, not three times.
	const enemies = horde(1);
	const players = economyParty(3);

	const counts = [0, 1, 2].map((turnIndex) =>
		resolveEnemyAttacks({ enemies, players, turnIndex, partySize: 3, rollD20: () => 10, rollDamage: () => 1 }).attacks.length);

	assert.deepEqual(counts, [1, 0, 0]);
});

test("a turn index beyond the party wraps rather than silencing the enemies", () => {
	const { attacks } = resolveEnemyAttacks({
		enemies: horde(2), players: economyParty(2), turnIndex: 5, partySize: 2, rollD20: () => 10, rollDamage: () => 1,
	});

	assert.equal(attacks.length, 1);
});

test("without a turn index the whole roster acts, as it did before", () => {
	// Callers that do not know the turn — the timer path, an admin-forced round —
	// keep the old behaviour rather than silently dropping attacks.
	const { attacks } = resolveEnemyAttacks({ enemies: horde(3), players: economyParty(3), rollD20: () => 10, rollDamage: () => 1 });

	assert.equal(attacks.length, 3);
});

test("dead enemies are skipped without stealing a living one's turn", () => {
	// If the slice were taken before filtering the dead, a corpse would absorb a slot
	// and the survivors would attack less often than they should.
	const enemies = horde(3);
	enemies.E1.status = "dead";
	enemies.E1.hp = 0;

	const swings = [0, 1, 2].flatMap((turnIndex) =>
		resolveEnemyAttacks({ enemies, players: economyParty(3), turnIndex, partySize: 3, rollD20: () => 10, rollDamage: () => 1 })
			.attacks.map((a) => a.enemy));

	assert.deepEqual(swings.sort(), ["E0", "E2"]);
});

// ===== No character is deleted in one blow =====
//
// At a damage multiplier of 2.0 a CR 2 ogre one-shot a level 3 character in 82% of
// simulated fights: 2d6+4 tops out at 16, doubled is 32, against 26 hit points. Being
// killed outright by a low-level enemy from full health is the thing the operator
// named as unacceptable, and it also makes the difficulty dial unusable — the only
// way to make a fight harder was to make it arbitrary.

test("a single blow cannot take a character from full health to dead", () => {
	const players = { Ayla: { name: "Ayla", stats: { hp: 26, max_hp: 26, dex: 10 }, armor: null } };
	const ogre = { Ogre: { name: "Ogre", hp: 59, max_hp: 59, ac: 11, str: 19, cr: "2", status: "active" } };

	// Maximum damage roll, always hitting, at the harshest setting.
	const { attacks } = resolveEnemyAttacks({
		enemies: ogre, players, difficulty: "merciless", rollD20: () => 20, rollDamage: () => 12,
	});

	assert.ok(attacks[0].damage < 26, `one blow dealt ${attacks[0].damage} against 26 maximum hit points`);
});

test("the cap is a share of maximum health, not a flat number", () => {
	// A level 1 character and a level 10 one must both survive their first hit.
	for (const maxHp of [8, 12, 26, 40, 80]) {
		const players = { Ayla: { name: "Ayla", stats: { hp: maxHp, max_hp: maxHp, dex: 10 }, armor: null } };
		const brute = { Brute: { name: "Brute", hp: 99, max_hp: 99, ac: 11, str: 20, cr: "12", status: "active" } };

		const { attacks } = resolveEnemyAttacks({
			enemies: brute, players, difficulty: "merciless", rollD20: () => 20, rollDamage: () => 30,
		});

		assert.ok(attacks[0].damage < maxHp, `${maxHp} hit points took ${attacks[0].damage} from one blow`);
	}
});

test("a wounded character can still be killed by one blow", () => {
	// The cap protects against deletion from full health, not against dying. A
	// character on their last legs is still in danger, which is the entire point.
	const players = { Ayla: { name: "Ayla", stats: { hp: 3, max_hp: 26, dex: 10 }, armor: null } };
	const ogre = { Ogre: { name: "Ogre", hp: 59, max_hp: 59, ac: 11, str: 19, cr: "2", status: "active" } };

	const { damage } = resolveEnemyAttacks({
		enemies: ogre, players, difficulty: "merciless", rollD20: () => 20, rollDamage: () => 12,
	});

	assert.ok(damage.Ayla > 3, `${damage.Ayla} would not finish a character on 3 hit points`);
});

test("the cap does not interfere with ordinary blows", () => {
	// A goblin hitting for 3 must still hit for 3; the rail is for the outliers.
	const players = { Ayla: { name: "Ayla", stats: { hp: 26, max_hp: 26, dex: 10 }, armor: null } };
	const goblin = { G: { name: "G", hp: 7, max_hp: 7, ac: 15, str: 10, cr: "1/4", status: "active" } };

	const { attacks } = resolveEnemyAttacks({
		enemies: goblin, players, difficulty: "standard", rollD20: () => 20, rollDamage: () => 3,
	});

	assert.equal(attacks[0].damage, 3);
});

test("a character with no stated maximum is not shielded by a nonsense cap", () => {
	const players = { Ayla: { name: "Ayla", stats: { hp: 20, dex: 10 }, armor: null } };
	const ogre = { Ogre: { name: "Ogre", hp: 59, max_hp: 59, ac: 11, str: 19, cr: "2", status: "active" } };

	const { attacks } = resolveEnemyAttacks({
		enemies: ogre, players, difficulty: "merciless", rollD20: () => 20, rollDamage: () => 12,
	});

	assert.ok(attacks[0].damage >= 1 && Number.isInteger(attacks[0].damage));
});
