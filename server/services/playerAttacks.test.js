/**
 * Tests for player attack resolution.
 *
 * @description The enemies' attacks have been rolled server-side since `enemyTurns.js`
 *   landed; the players' never were. `autoRollIfNeeded` rolled a d20 plus one stat
 *   modifier and graded it on a flat ladder — 15 or better succeeds — so the enemy's
 *   armour class, stored on the roster and shown to the DM, decided nothing. A goblin
 *   at AC 15 and a dragon at AC 19 were exactly as hard to hit. Damage was never rolled
 *   at all: the model picked a number and `updateEnemies` wrote it down.
 *
 *   This is the missing half, and it mirrors `resolveEnemyAttacks` deliberately.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAttack, chooseTarget, proficiencyBonus } from "./playerAttacks.js";

/** A fighter with a plain shortsword. */
function fighter(over = {}) {
	return {
		name: "Brannor Ironfoot",
		class: "Fighter",
		level: 3,
		stats: { hp: 24, max_hp: 28, str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
		weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
		...over,
	};
}

/** A live enemy roster. */
function roster(over = {}) {
	return {
		"Goblin 1": { name: "Goblin 1", hp: 7, max_hp: 7, ac: 15, str: 8, dex: 14, cr: "1/4", status: "active" },
		"Goblin 2": { name: "Goblin 2", hp: 3, max_hp: 7, ac: 15, str: 8, dex: 14, cr: "1/4", status: "active" },
		Gurnak: { name: "Gurnak", hp: 59, max_hp: 76, ac: 11, str: 19, dex: 8, cr: "7", status: "active" },
		...over,
	};
}

/** Dice that always land on a stated face. */
const always = (n) => () => n;

// ── Proficiency ──────────────────────────────────────────────────────────────

test("proficiency follows the 5e progression", () => {
	// Enemies get 2–5 by challenge rating. Players got nothing at all, so the party
	// scaled worse than its opposition with every level.
	assert.equal(proficiencyBonus(1), 2);
	assert.equal(proficiencyBonus(4), 2);
	assert.equal(proficiencyBonus(5), 3);
	assert.equal(proficiencyBonus(9), 4);
	assert.equal(proficiencyBonus(13), 5);
	assert.equal(proficiencyBonus(17), 6);
	assert.equal(proficiencyBonus(20), 6);
});

test("a nonsense level still yields a usable proficiency", () => {
	for (const level of [0, -3, null, undefined, "eight", 999]) {
		const bonus = proficiencyBonus(level);
		assert.ok(Number.isInteger(bonus) && bonus >= 2 && bonus <= 6, `got ${bonus} for ${level}`);
	}
});

// ── Choosing a target ────────────────────────────────────────────────────────

test("an enemy named in the action is the target", () => {
	assert.equal(chooseTarget("I swing at Gurnak with my axe.", roster())?.name, "Gurnak");
	assert.equal(chooseTarget("I stab Goblin 2 in the throat.", roster())?.name, "Goblin 2");
});

test("a name is matched without case or exact spacing", () => {
	assert.equal(chooseTarget("i lunge at gurnak", roster())?.name, "Gurnak");
	assert.equal(chooseTarget("I attack the GOBLIN 1", roster())?.name, "Goblin 1");
});

test("a bare species name finds the numbered enemy", () => {
	// Players type "I attack the goblin", not "I attack Goblin 1".
	assert.equal(chooseTarget("I attack the goblin.", roster())?.name.startsWith("Goblin"), true);
});

test("naming nobody falls to the most wounded enemy still standing", () => {
	// Finishing what the party started reads better than picking at random, and it is
	// what a table would do.
	assert.equal(chooseTarget("I attack!", roster())?.name, "Goblin 2");
});

test("the dead and the fled are never targeted", () => {
	const corpses = roster({
		"Goblin 2": { name: "Goblin 2", hp: 0, max_hp: 7, ac: 15, cr: "1/4", status: "dead" },
		"Goblin 1": { name: "Goblin 1", hp: 7, max_hp: 7, ac: 15, cr: "1/4", status: "fled" },
	});

	assert.equal(chooseTarget("I attack Goblin 2.", corpses)?.name, "Gurnak");
	assert.equal(chooseTarget("I attack!", corpses)?.name, "Gurnak");
});

test("an empty or absent roster yields no target", () => {
	assert.equal(chooseTarget("I attack!", {}), null);
	assert.equal(chooseTarget("I attack!", null), null);
	assert.equal(chooseTarget("", roster()), null);
});

// ── The attack roll ──────────────────────────────────────────────────────────

test("an attack is rolled against the target's actual armour class", () => {
	// The defect this exists for. Gurnak is AC 11 and a goblin is AC 15; the same
	// roll must land on one and miss the other.
	const target = (name) => roster()[name];
	const opts = { attacker: fighter(), rollD20: always(8), rollDamage: () => 3 };

	assert.equal(resolveAttack({ ...opts, target: target("Gurnak") }).hit, true, "8+5=13 should beat AC 11");
	assert.equal(resolveAttack({ ...opts, target: target("Goblin 1") }).hit, false, "8+5=13 should miss AC 15");
});

test("the attack bonus is the ability modifier plus proficiency plus the weapon's enchantment", () => {
	const result = resolveAttack({
		attacker: fighter({ weapon: { name: "+2 Ruinbrand", damage: "1d6", damageType: "piercing", bonus: 2 } }),
		target: roster().Gurnak,
		rollD20: always(10),
		rollDamage: () => 3,
	});

	// STR 16 is +3, level 3 is proficiency +2, the weapon adds 2.
	assert.equal(result.bonus, 7);
	assert.equal(result.total, 17);
});

test("a natural twenty always hits and a natural one always misses", () => {
	const wall = { name: "Wall", hp: 99, max_hp: 99, ac: 40, cr: "20", status: "active" };
	const paper = { name: "Paper", hp: 1, max_hp: 1, ac: 1, cr: "0", status: "active" };

	assert.equal(resolveAttack({ attacker: fighter(), target: wall, rollD20: always(20), rollDamage: () => 3 }).hit, true);
	assert.equal(resolveAttack({ attacker: fighter(), target: paper, rollD20: always(1), rollDamage: () => 3 }).hit, false);
});

// ── Damage ───────────────────────────────────────────────────────────────────

test("damage is the weapon's dice plus the ability modifier plus the enchantment", () => {
	const result = resolveAttack({
		attacker: fighter({ weapon: { name: "+1 Shortsword", damage: "1d6", damageType: "slashing", bonus: 1 } }),
		target: roster().Gurnak,
		rollD20: always(18),
		// One d6 showing 4.
		rollDamage: () => 4,
	});

	// 4 rolled + 3 for STR 16 + 1 for the enchantment.
	assert.equal(result.damage, 8);
	assert.equal(result.damageType, "slashing");
});

test("a critical hit rolls the weapon's dice twice, and does not double the modifiers", () => {
	const opts = {
		attacker: fighter(),
		target: roster().Gurnak,
		rollDamage: () => 4,
	};

	const normal = resolveAttack({ ...opts, rollD20: always(18) });
	const crit = resolveAttack({ ...opts, rollD20: always(20) });

	assert.equal(crit.critical, true);
	assert.equal(normal.critical, false);
	// 4 + 4 rolled + 3 for STR, against 4 + 3.
	assert.equal(crit.damage, 11);
	assert.equal(normal.damage, 7);
});

test("a miss deals nothing", () => {
	const result = resolveAttack({ attacker: fighter(), target: roster()["Goblin 1"], rollD20: always(2), rollDamage: () => 6 });

	assert.equal(result.hit, false);
	assert.equal(result.damage, 0);
});

test("a hit always takes at least one hit point", () => {
	// A feeble character with a penalty must not heal what they hit.
	const weakling = fighter({ level: 1, stats: { str: 3, dex: 3 }, weapon: { name: "Twig", damage: "1d4", damageType: "bludgeoning" } });
	const result = resolveAttack({ attacker: weakling, target: roster().Gurnak, rollD20: always(20), rollDamage: () => 1 });

	assert.ok(result.damage >= 1, `dealt ${result.damage}`);
});

test("an affix that adds damage adds it on a hit and not on a miss", () => {
	const flaming = fighter({
		weapon: { name: "Shortsword of Embers", damage: "1d6", damageType: "slashing", bonus_damage: "1d6", bonus_damage_type: "fire" },
	});
	const opts = { attacker: flaming, target: roster().Gurnak, rollDamage: () => 4 };

	const hit = resolveAttack({ ...opts, rollD20: always(18) });
	const miss = resolveAttack({ ...opts, rollD20: always(2) });

	assert.equal(hit.bonusDamage, 4);
	assert.equal(hit.damage, 11, "4 weapon + 3 STR + 4 fire");
	assert.equal(miss.bonusDamage, 0);
});

// ── Which ability, and unarmed ───────────────────────────────────────────────

test("a ranged weapon uses dexterity", () => {
	const archer = fighter({
		stats: { str: 8, dex: 18 },
		weapon: { name: "Longbow", damage: "1d8", damageType: "piercing", range: "ranged" },
	});
	const result = resolveAttack({ attacker: archer, target: roster().Gurnak, rollD20: always(10), rollDamage: () => 4 });

	assert.equal(result.ability, "dex");
	assert.equal(result.bonus, 6, "DEX 18 is +4, level 3 proficiency is +2");
});

test("a finesse weapon uses whichever ability is better", () => {
	const rogue = fighter({
		stats: { str: 8, dex: 18 },
		weapon: { name: "Dagger", damage: "1d4", damageType: "piercing", range: "melee" },
	});

	assert.equal(resolveAttack({ attacker: rogue, target: roster().Gurnak, rollD20: always(10), rollDamage: () => 2 }).ability, "dex");
});

test("a character with no weapon punches", () => {
	const result = resolveAttack({ attacker: fighter({ weapon: null }), target: roster().Gurnak, rollD20: always(18), rollDamage: () => 2 });

	assert.equal(result.weaponName, "Unarmed Strike");
	assert.ok(result.damage >= 1);
});

test("an unreadable weapon damage expression falls back rather than dealing nothing", () => {
	// The model invented `"damage": "1d6+1"` before now, which no roller here accepts.
	const odd = fighter({ weapon: { name: "Odd Blade", damage: "1d6+1", damageType: "slashing" } });
	const result = resolveAttack({ attacker: odd, target: roster().Gurnak, rollD20: always(18), rollDamage: () => 3 });

	assert.ok(result.damage >= 1, `dealt ${result.damage}`);
});

// ── Determinism and bad input ────────────────────────────────────────────────

test("the same dice produce the same attack", () => {
	const opts = { attacker: fighter(), target: roster().Gurnak, rollD20: always(14), rollDamage: () => 5 };

	assert.deepEqual(resolveAttack(opts), resolveAttack(opts));
});

test("an attack with no target resolves to nothing rather than throwing", () => {
	assert.equal(resolveAttack({ attacker: fighter(), target: null, rollD20: always(20), rollDamage: () => 4 }), null);
	assert.equal(resolveAttack({}), null);
});

test("a target with no readable armour class is still hittable", () => {
	const vague = { name: "Shape", hp: 10, max_hp: 10, status: "active" };
	const result = resolveAttack({ attacker: fighter(), target: vague, rollD20: always(10), rollDamage: () => 3 });

	assert.ok(Number.isInteger(result.ac) && result.ac > 0);
	assert.equal(result.hit, true);
});

test("the result names everything the narrator needs to describe the blow", () => {
	const result = resolveAttack({ attacker: fighter(), target: roster().Gurnak, rollD20: always(18), rollDamage: () => 4 });

	for (const field of ["attacker", "targetName", "weaponName", "base", "bonus", "total", "ac", "hit", "critical", "damage", "damageType"]) {
		assert.ok(field in result, `result is missing "${field}"`);
	}
});

// ── The block handed to the narrator ─────────────────────────────────────────

import { describeAttack } from "./playerAttacks.js";

/** A resolved hit, as `resolveAttack` returns one. */
const HIT = {
	attacker: "Brannor Ironfoot", targetName: "Gurnak", weaponName: "+1 Shortsword",
	ability: "str", base: 15, bonus: 6, total: 21, ac: 11,
	hit: true, critical: false, damage: 9, damageType: "slashing", bonusDamage: 0, bonusDamageType: null,
};

const MISS = { ...HIT, base: 3, total: 9, ac: 15, hit: false, damage: 0 };

test("no attack produces no block", () => {
	assert.equal(describeAttack(null), "");
	assert.equal(describeAttack(undefined), "");
});

test("a hit states the roll, the armour class and the damage", () => {
	const block = describeAttack(HIT, { name: "Gurnak", hp: 50 });

	assert.match(block, /rolled 21/);
	assert.match(block, /AC 11/);
	assert.match(block, /HITS for 9 slashing damage/);
});

test("a critical hit is announced as one", () => {
	assert.match(describeAttack({ ...HIT, critical: true, damage: 14 }, { hp: 45 }), /CRITICAL/);
	assert.doesNotMatch(describeAttack(HIT, { hp: 50 }), /CRITICAL/);
});

test("extra damage from an affix is broken out so it can be described", () => {
	const flaming = { ...HIT, damage: 13, bonusDamage: 4, bonusDamageType: "fire" };

	assert.match(describeAttack(flaming, { hp: 46 }), /including 4 fire/);
});

test("a miss is stated plainly and partial success is forbidden", () => {
	// The narrator's bias is always toward letting the player succeed. A graze is how
	// a miss becomes a hit with extra steps.
	const block = describeAttack(MISS, { name: "Gurnak", hp: 59 });

	assert.match(block, /MISSES/);
	assert.match(block, /graze/i);
	assert.doesNotMatch(block, /HITS/);
});

test("a target reduced to zero is reported as dead, and one still up is not", () => {
	assert.match(describeAttack(HIT, { name: "Gurnak", hp: 0 }), /DIES/);
	assert.match(describeAttack(HIT, { name: "Gurnak", hp: 12 }), /still standing on 12/);
	assert.doesNotMatch(describeAttack(HIT, { name: "Gurnak", hp: 12 }), /DIES/);
});

test("the block says the numbers are settled and must not be duplicated", () => {
	for (const attack of [HIT, MISS]) {
		const block = describeAttack(attack, { hp: 10 });
		assert.match(block, /Do NOT change these numbers/);
		assert.match(block, /"enemies"/);
	}
});

test("an unknown target state omits the standing line rather than inventing one", () => {
	const block = describeAttack(HIT, undefined);

	assert.match(block, /HITS for 9/);
	assert.doesNotMatch(block, /still standing/);
	assert.doesNotMatch(block, /DIES/);
});

// ── Recognising an attack ────────────────────────────────────────────────────

import { isAttackAction } from "./playerAttacks.js";

test("attack verbs are recognised", () => {
	for (const action of [
		"I attack the goblin.",
		"I strike at Gurnak.",
		"I swing my axe.",
		"I stab him in the ribs.",
		"She slashes at the wolf.",
		"I lunge forward.",
		"I hack through the vines.",
		"I shoot the archer.",
		"I fire an arrow at the ogre.",
		"I loose a bolt.",
	]) {
		assert.equal(isAttackAction(action), true, `"${action}" was not read as an attack`);
	}
});

test("lighting a fire is not an attack", () => {
	// "fire" alone would make a campfire into a bow shot, which is why the pattern
	// requires something one actually fires, or an "at".
	assert.equal(isAttackAction("I fire the kindling and get the camp warm."), false);
	assert.equal(isAttackAction("I set fire to the barricade."), false);
});

test("ordinary actions are not attacks", () => {
	for (const action of [
		"I ask the innkeeper about the road north.",
		"I search the goblin bodies.",
		"I cast Light on my holy symbol.",
		"I climb the rope.",
	]) {
		assert.equal(isAttackAction(action), false, `"${action}" was read as an attack`);
	}
});

test("malformed input is not an attack", () => {
	for (const bad of [null, undefined, "", 42, {}]) {
		assert.equal(isAttackAction(bad), false);
	}
});
