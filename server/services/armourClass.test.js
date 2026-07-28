/**
 * Tests for armour class.
 *
 * @description The rule was "whatever number is on the armour, else 10 + DEX". A
 *   DEX 16 rogue was therefore AC 13 naked and AC 11 in leather: putting armour on
 *   made her measurably easier to hit, and `armor.json`'s own note for that entry
 *   reads "AC 11 + DEX modifier". Every light-armour character in the game was
 *   being penalised for wearing armour.
 *
 *   It was also computed twice — `enemyTurns.js` one way, `characterCapability.js`
 *   another — so the number a player was told and the number combat used disagreed.
 *   One function now, and both callers use it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { armourClass, UNARMOURED_BASE } from "./armourClass.js";

/**
 * @description Builds a character sheet carrying only what AC depends on.
 * @param {number} dex - The dexterity score.
 * @param {object|null} armor - The worn armour, or null.
 * @returns {object} A sheet.
 */
function sheet(dex, armor = null) {
	return { name: "Sylvie", stats: { dex, hp: 20, max_hp: 20 }, armor };
}

// ── The defect ───────────────────────────────────────────────────────────────

test("light armour adds the full dexterity modifier", () => {
	// Leather Armor is 11 in the catalogue and its note says "+ DEX modifier".
	assert.equal(armourClass(sheet(16, { name: "Leather Armor", ac: 11, type: "light" })), 14);
});

test("wearing armour is never worse than wearing none", () => {
	// The property that was violated. Checked across the whole catalogue rather than
	// for one example, because the inversion was invisible until someone did the sum.
	for (let dex = 6; dex <= 20; dex++) {
		const naked = armourClass(sheet(dex));
		for (const armor of [
			{ name: "Padded Armor", ac: 11, type: "light" },
			{ name: "Leather Armor", ac: 11, type: "light" },
			{ name: "Studded Leather", ac: 12, type: "light" },
			{ name: "Hide Armor", ac: 12, type: "medium" },
			{ name: "Chain Shirt", ac: 13, type: "medium" },
			{ name: "Breastplate", ac: 14, type: "medium" },
			{ name: "Ring Mail", ac: 14, type: "heavy" },
			{ name: "Chain Mail", ac: 16, type: "heavy" },
		]) {
			const worn = armourClass(sheet(dex, armor));
			assert.ok(worn >= naked, `DEX ${dex}: ${armor.name} gave AC ${worn}, worse than AC ${naked} unarmoured`);
		}
	}
});

// ── The 5e rules by armour type ──────────────────────────────────────────────

test("unarmoured is ten plus dexterity", () => {
	assert.equal(armourClass(sheet(10)), UNARMOURED_BASE);
	assert.equal(armourClass(sheet(16)), 13);
	assert.equal(armourClass(sheet(6)), 8);
});

test("medium armour caps the dexterity bonus at two", () => {
	const chain = { name: "Chain Shirt", ac: 13, type: "medium" };

	assert.equal(armourClass(sheet(20, chain)), 15, "DEX +5 should cap at +2");
	assert.equal(armourClass(sheet(14, chain)), 15, "DEX +2 is under the cap");
	assert.equal(armourClass(sheet(10, chain)), 13);
});

test("heavy armour ignores dexterity entirely, good or bad", () => {
	const plate = { name: "Chain Mail", ac: 16, type: "heavy" };

	assert.equal(armourClass(sheet(20, plate)), 16);
	assert.equal(armourClass(sheet(6, plate)), 16);
});

test("a negative dexterity modifier lowers armour class where it applies", () => {
	assert.equal(armourClass(sheet(6, { name: "Leather Armor", ac: 11, type: "light" })), 9);
});

// ── Enchantment ──────────────────────────────────────────────────────────────

test("an enchantment bonus is added on top", () => {
	// The loot engine folds its bonus into `ac`, but an item equipped from an admin
	// grant or an imported sheet may carry it separately.
	const warded = { name: "+1 Chain Shirt", ac: 13, type: "medium", bonus: 1 };

	assert.equal(armourClass(sheet(14, warded)), 16);
});

test("a bonus already folded into the armour class is not counted twice", () => {
	// `loot.js` writes the total into `ac`. An item carrying both must not stack.
	const fromLoot = { name: "+1 Chain Shirt of Warding", ac: 15, type: "medium" };

	assert.equal(armourClass(sheet(14, fromLoot)), 17);
});

// ── Boundaries and bad input ─────────────────────────────────────────────────

test("an unknown armour type is treated as light rather than ignored", () => {
	// The DM invents armour types. Dropping DEX for an unrecognised word is the
	// behaviour that caused the original bug.
	assert.equal(armourClass(sheet(16, { name: "Strange Coat", ac: 12, type: "gossamer" })), 15);
	assert.equal(armourClass(sheet(16, { name: "Strange Coat", ac: 12 })), 15);
});

test("armour with no usable armour class falls back to being unarmoured", () => {
	assert.equal(armourClass(sheet(16, { name: "Rags", ac: 0, type: "light" })), 13);
	assert.equal(armourClass(sheet(16, { name: "Rags", ac: "nonsense", type: "light" })), 13);
});

test("a missing or malformed sheet still yields a usable number", () => {
	for (const bad of [null, undefined, {}, { stats: null }, "Sylvie"]) {
		const ac = armourClass(bad);
		assert.ok(Number.isInteger(ac) && ac >= 1, `got ${ac} for ${JSON.stringify(bad)}`);
	}
});

test("armour class is always a whole number", () => {
	for (let dex = 3; dex <= 20; dex++) {
		assert.ok(Number.isInteger(armourClass(sheet(dex, { name: "Chain Shirt", ac: 13, type: "medium" }))));
	}
});

test("a shield stacks on top of worn armour", () => {
	const plate = { name: "Chain Mail", ac: 16, type: "heavy" };

	assert.equal(armourClass({ ...sheet(10, plate), shield: { name: "Shield", ac: 2 } }), 18);
});
