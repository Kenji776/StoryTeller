/**
 * Tests for spell resolution.
 *
 * @description The last part of a turn the narrator decided alone. A spell reached
 *   `autoRollIfNeeded`, which rolled a d20 plus one ability modifier — `int`, whatever
 *   the class — and graded it on a flat ladder: 15 or better succeeds. The target's
 *   armour class decided nothing, so a goblin at AC 15 and a dragon at AC 19 were
 *   equally hard to hit with Fire Bolt, and the damage was whatever the prose felt like.
 *
 *   This mirrors `playerAttacks.js` deliberately, down to the injected dice, so the two
 *   halves of what a character can do are resolved by the same kind of code.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { spellSaveDC, spellAttackBonus, resolveSpell, describeSpell } from "./spellAttacks.js";

/**
 * @description A caster sheet carrying only what resolution reads.
 * @param {object} [over] - Fields to override.
 * @returns {object} A sheet.
 */
function wizard(over = {}) {
	return { name: "Elara", class: "Wizard", level: 1, stats: { int: 16, wis: 8, cha: 10 }, ...over };
}

/**
 * @description A roster entry.
 * @param {object} [over] - Fields to override.
 * @returns {object} An enemy.
 */
function goblin(over = {}) {
	return { name: "Goblin 1", hp: 12, ac: 15, cr: "1/4", status: "alive", ...over };
}

/** Catalogue-shaped spells, so the tests do not depend on the live file's balance. */
const FIRE_BOLT = { name: "Fire Bolt", level: 0, resolution: "attack", damage: "1d10", damageType: "fire" };
const BURNING_HANDS = {
	name: "Burning Hands", level: 1, resolution: "save", save: "dex", onSave: "half",
	damage: "3d6", damageType: "fire",
};
const SACRED_FLAME = {
	name: "Sacred Flame", level: 0, resolution: "save", save: "dex", onSave: "none",
	damage: "1d8", damageType: "radiant",
};
const MAGIC_MISSILE = { name: "Magic Missile", level: 1, resolution: "auto", damage: "3d4+3", damageType: "force" };
const CURE_WOUNDS = { name: "Cure Wounds", level: 1, resolution: "heal", healing: "1d8", addCastingMod: true };
const MAGE_HAND = { name: "Mage Hand", level: 0, resolution: "utility" };

/** A roller returning a fixed sequence, so a test states the dice it means. */
const dice = (...values) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

// ── The save DC ──────────────────────────────────────────────────────────────

test("the save DC is eight plus proficiency plus the casting modifier", () => {
	// A level-1 wizard with INT 16: 8 + 2 + 3.
	assert.equal(spellSaveDC(wizard()), 13);
});

test("the save DC uses the class's own casting stat, not intelligence", () => {
	// A cleric with WIS 18 and INT 8 must not be graded on INT. This is the hardcoded
	// `statKey = "int"` defect, expressed as a number.
	const cleric = { name: "Ovid", class: "Cleric", level: 1, stats: { int: 8, wis: 18 } };
	assert.equal(spellSaveDC(cleric), 8 + 2 + 4);
});

test("the save DC climbs with proficiency", () => {
	assert.equal(spellSaveDC(wizard({ level: 5 })), 8 + 3 + 3);
	assert.equal(spellSaveDC(wizard({ level: 17 })), 8 + 6 + 3);
});

test("a non-caster has no spell save DC", () => {
	assert.equal(spellSaveDC({ name: "Bron", class: "Fighter", level: 5, stats: { str: 18 } }), null);
});

test("the save DC survives a sheet with no stats", () => {
	// Ability 10 → modifier 0, so 8 + proficiency.
	assert.equal(spellSaveDC({ class: "Wizard", level: 1 }), 10);
});

// ── The attack bonus ─────────────────────────────────────────────────────────

test("the attack bonus is proficiency plus the casting modifier", () => {
	assert.equal(spellAttackBonus(wizard(), "standard"), 5);
});

test("difficulty moves the caster's bonus exactly as it moves a weapon attack", () => {
	// The one place the dial touches the party's own dice. A caster left out of it would
	// find Casual no gentler for magic than Standard.
	assert.equal(spellAttackBonus(wizard(), "casual"), 8);
	assert.equal(spellAttackBonus(wizard(), "merciless"), 4);
});

test("an unknown difficulty is treated as standard rather than throwing", () => {
	assert.equal(spellAttackBonus(wizard(), "nonsense"), 5);
	assert.equal(spellAttackBonus(wizard()), 5);
});

// ── Attack spells ────────────────────────────────────────────────────────────

test("an attack spell is rolled against the target's real armour class", () => {
	// The whole defect: AC 15 now decides. 11 + 5 = 16 lands.
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin(),
		rollD20: dice(11), rollDamage: () => 6,
	});
	assert.equal(cast.ac, 15);
	assert.equal(cast.total, 16);
	assert.equal(cast.hit, true);
	assert.equal(cast.damage, 6);
	assert.equal(cast.damageType, "fire");
});

test("an attack spell that falls short of the armour class misses for nothing", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin({ ac: 19 }),
		rollD20: dice(11), rollDamage: () => 6,
	});
	assert.equal(cast.hit, false);
	assert.equal(cast.damage, 0);
});

test("a natural twenty is a critical hit and doubles the dice", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin({ ac: 30 }),
		rollD20: dice(20), rollDamage: () => 6,
	});
	assert.equal(cast.critical, true);
	assert.equal(cast.hit, true, "a natural twenty lands whatever the armour class");
	assert.equal(cast.damage, 12, "two rolls of the damage dice");
});

test("a natural one misses however large the bonus", () => {
	const cast = resolveSpell({
		caster: wizard({ level: 20 }), spell: FIRE_BOLT, target: goblin({ ac: 5 }),
		rollD20: dice(1), rollDamage: () => 6,
	});
	assert.equal(cast.hit, false);
	assert.equal(cast.damage, 0);
});

test("a spell attack adds no ability modifier to its damage", () => {
	// 5e: a cantrip's damage is the dice alone. Adding the casting modifier would make
	// every caster's damage scale twice with one stat.
	const cast = resolveSpell({
		caster: wizard({ stats: { int: 20 } }), spell: FIRE_BOLT, target: goblin(),
		rollD20: dice(18), rollDamage: () => 4,
	});
	assert.equal(cast.damage, 4);
});

test("a target with no stated armour class gets the same default a weapon attack uses", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin({ ac: undefined }),
		rollD20: dice(10), rollDamage: () => 3,
	});
	assert.equal(cast.ac, 12);
});

// ── Save spells ──────────────────────────────────────────────────────────────

test("a save spell is resisted by the target rolling against the caster's DC", () => {
	// DC 13. The goblin rolls 18 + 2 proficiency = 20, and saves.
	const cast = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin(),
		rollD20: dice(18), rollDamage: () => 10,
	});
	assert.equal(cast.dc, 13);
	assert.equal(cast.saved, true);
	assert.equal(cast.saveAbility, "dex");
});

test("a successful save against a half-damage spell still takes half, rounded down", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin(),
		rollD20: dice(18), rollDamage: () => 11,
	});
	assert.equal(cast.saved, true);
	assert.equal(cast.damage, 5);
});

test("a successful save against a no-quarter spell takes nothing", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: SACRED_FLAME, target: goblin(),
		rollD20: dice(18), rollDamage: () => 7,
	});
	assert.equal(cast.saved, true);
	assert.equal(cast.damage, 0);
});

test("a failed save takes the damage in full", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin(),
		rollD20: dice(3), rollDamage: () => 11,
	});
	assert.equal(cast.saved, false);
	assert.equal(cast.damage, 11);
});

test("a tougher creature saves more often, through its challenge rating", () => {
	// The same roll: a CR 1/4 goblin fails where a CR 12 monster succeeds.
	const roll = 9;
	const weak = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin({ cr: "1/4" }),
		rollD20: dice(roll), rollDamage: () => 10,
	});
	const strong = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin({ cr: 12 }),
		rollD20: dice(roll), rollDamage: () => 10,
	});
	assert.equal(weak.saved, false);
	assert.equal(strong.saved, true);
});

test("a save spell is never a critical hit", () => {
	// There is no attack roll to crit on; a natural 20 belongs to the *target* here.
	const cast = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin(),
		rollD20: dice(20), rollDamage: () => 10,
	});
	assert.equal(cast.critical, false);
	assert.equal(cast.saved, true, "a natural 20 on a saving throw is the target's win");
});

// ── Spells that simply land ──────────────────────────────────────────────────

test("magic missile hits without a roll", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: MAGIC_MISSILE, target: goblin({ ac: 30 }),
		rollD20: dice(1), rollDamage: () => 9,
	});
	assert.equal(cast.hit, true);
	assert.equal(cast.damage, 9);
	assert.equal(cast.critical, false);
});

// ── Healing ──────────────────────────────────────────────────────────────────

test("a healing spell rolls its dice and adds the casting modifier", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: CURE_WOUNDS, target: null, rollDamage: () => 5,
	});
	assert.equal(cast.resolution, "heal");
	assert.equal(cast.healed, 8, "5 rolled plus INT 16's +3");
	assert.equal(cast.damage, 0);
});

test("a healing spell never restores less than one hit point", () => {
	const cast = resolveSpell({
		caster: wizard({ stats: { int: 1 } }), spell: CURE_WOUNDS, target: null, rollDamage: () => 1,
	});
	assert.ok(cast.healed >= 1);
});

// ── What the resolver declines ───────────────────────────────────────────────

test("a utility spell resolves to nothing, because the narrator owns it", () => {
	assert.equal(resolveSpell({ caster: wizard(), spell: MAGE_HAND, target: goblin() }), null);
});

test("an attack or save spell with no target resolves to nothing", () => {
	assert.equal(resolveSpell({ caster: wizard(), spell: FIRE_BOLT, target: null }), null);
	assert.equal(resolveSpell({ caster: wizard(), spell: BURNING_HANDS, target: null }), null);
});

test("a missing caster or spell resolves to nothing rather than throwing", () => {
	assert.equal(resolveSpell({ caster: null, spell: FIRE_BOLT, target: goblin() }), null);
	assert.equal(resolveSpell({ caster: wizard(), spell: null, target: goblin() }), null);
	assert.equal(resolveSpell({}), null);
	assert.equal(resolveSpell(), null);
});

test("a spell whose damage the roller cannot read still resolves rather than dealing nothing", () => {
	// The catalogue is validated at boot, but a DM-granted spell is not.
	const cast = resolveSpell({
		caster: wizard(), spell: { ...FIRE_BOLT, damage: "8d6 fire" }, target: goblin(),
		rollD20: dice(18),
	});
	assert.ok(cast.damage >= 1, "a hit should never deal nothing");
});

// ── The block handed to the DM ───────────────────────────────────────────────

test("the block states the numbers and forbids the model changing them", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin(),
		rollD20: dice(18), rollDamage: () => 7,
	});
	const block = describeSpell(cast, { ...goblin(), hp: 5 });
	assert.match(block, /Fire Bolt/);
	assert.match(block, /Goblin 1/);
	assert.match(block, /7/);
	assert.match(block, /do NOT/i);
	assert.match(block, /5 hit points/);
});

test("the block spells out a miss so the narrator cannot award a graze", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin({ ac: 25 }),
		rollD20: dice(4), rollDamage: () => 7,
	});
	const block = describeSpell(cast, goblin({ ac: 25 }));
	assert.match(block, /MISSES/);
	assert.match(block, /partial success|graze/i);
});

test("the block reports a save as a save, with the DC and the roll", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin(),
		rollD20: dice(18), rollDamage: () => 11,
	});
	const block = describeSpell(cast, { ...goblin(), hp: 7 });
	assert.match(block, /DC 13/);
	assert.match(block, /dex/i);
	assert.match(block, /SAVES/i);
	assert.match(block, /5/, "half of 11");
});

test("the block announces a death when the target is down", () => {
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin(),
		rollD20: dice(18), rollDamage: () => 20,
	});
	const block = describeSpell(cast, { ...goblin(), hp: 0 });
	assert.match(block, /DIES/);
});

test("there is no block when there was nothing to resolve", () => {
	assert.equal(describeSpell(null), "");
	assert.equal(describeSpell(undefined), "");
});

// ── The block has to read as English, because a model writes prose from it ───

test("an unerring spell is described with one verb, not two", () => {
	// It read "casts Magic Missile at Goblin 2 strikes unerringly HITS for 10 force
	// damage" — the attack phrasing and the auto phrasing both applied. Invisible in
	// code, obvious the moment one was rendered.
	const cast = resolveSpell({
		caster: wizard(), spell: MAGIC_MISSILE, target: goblin(),
		rollD20: dice(1), rollDamage: () => 10,
	});
	const block = describeSpell(cast, goblin());
	assert.doesNotMatch(block, /unerringly HITS/);
	assert.match(block, /10 force damage/);
});

test("a saving throw is named as one", () => {
	// "DC 13 dex throw" is not a sentence. The ability reads as an ability.
	const cast = resolveSpell({
		caster: wizard(), spell: BURNING_HANDS, target: goblin(),
		rollD20: dice(3), rollDamage: () => 8,
	});
	const block = describeSpell(cast, goblin());
	assert.match(block, /DC 13 DEX saving throw/);
	assert.doesNotMatch(block, /dex throw/);
});

test("no line in the block carries a doubled or dangling space", () => {
	// The damage-type interpolation is optional, and the collapse that hid a missing
	// one used to run over the whole line.
	for (const spell of [FIRE_BOLT, BURNING_HANDS, MAGIC_MISSILE, { ...FIRE_BOLT, damageType: undefined }]) {
		const cast = resolveSpell({
			caster: wizard(), spell, target: goblin(), rollD20: dice(18), rollDamage: () => 6,
		});
		for (const line of describeSpell(cast, goblin()).split("\n")) {
			// The leading two-space indent on continuation lines is deliberate, and is the
			// same shape `describeAttack` uses; what must not appear is a gap *inside* a
			// sentence, which is what an absent damage type used to leave behind.
			assert.doesNotMatch(line.trimStart(), /\S  +\S/, `doubled space in: ${line}`);
			assert.doesNotMatch(line, /\s+$/, `trailing space in: ${line}`);
		}
	}
});

test("a target left on one hit point is described in the singular", () => {
	// "still standing on 1 hit points" is the kind of seam a model happily reproduces
	// verbatim in its prose.
	const cast = resolveSpell({
		caster: wizard(), spell: FIRE_BOLT, target: goblin(),
		rollD20: dice(18), rollDamage: () => 11,
	});
	const block = describeSpell(cast, { ...goblin(), hp: 1 });
	assert.match(block, /on 1 hit point\./);
	assert.doesNotMatch(block, /1 hit points/);
});
