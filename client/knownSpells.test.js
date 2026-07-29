/**
 * Tests for the in-game known-spell list.
 *
 * @description The character sheet showed a caster `2/2` spell slots and never said what
 *   those slots could be spent on. Spells were pickable at creation and then invisible
 *   for the rest of the game, so a player had to remember their choices from a screen
 *   they last saw hours earlier. A live four-hander went fifteen actions with two casters
 *   and no spell cast at all; one of them asked the table, out of character, how spell
 *   slots worked.
 *
 *   These tests pin the summary shown for each entry — what it costs, and what it does —
 *   because that is what a player reads before deciding a turn.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { describeKnownSpells } from "./knownSpells.js";

const CATALOGUE = [
	{ name: "Fire Bolt", level: 0, resolution: "attack", damage: "1d10", damageType: "fire", range: "ranged" },
	{ name: "Sacred Flame", level: 0, resolution: "save", save: "dex", onSave: "none", damage: "1d8", damageType: "radiant", range: "ranged" },
	{ name: "Light", level: 0, resolution: "utility", range: "touch", description: "An object you touch sheds bright light." },
	{ name: "Magic Missile", level: 1, resolution: "auto", damage: "3d4+3", damageType: "force", range: "ranged" },
	{ name: "Cure Wounds", level: 1, resolution: "heal", healing: "1d8", addCastingMod: true, range: "touch" },
	{ name: "Burning Hands", level: 1, resolution: "save", save: "dex", onSave: "half", damage: "3d6", damageType: "fire", area: "15-foot cone" },
];

/**
 * @description Finds one row by spell name.
 * @param {Array<object>} rows - Rows returned by describeKnownSpells.
 * @param {string} name - The spell to find.
 * @returns {object|undefined} The matching row.
 */
function row(rows, name) {
	return rows.find((r) => r.name === name);
}

test("a cantrip is marked as free rather than costing a slot", () => {
	// The distinction decides whether a turn is affordable, so it has to be on the row
	// itself and not inferred from the level number.
	const rows = describeKnownSpells(["Fire Bolt"], CATALOGUE);
	assert.equal(row(rows, "Fire Bolt").cost, "Cantrip");
	assert.equal(row(rows, "Fire Bolt").free, true);
});

test("a levelled spell states that it spends a slot", () => {
	const rows = describeKnownSpells(["Magic Missile"], CATALOGUE);
	assert.equal(row(rows, "Magic Missile").cost, "1 slot");
	assert.equal(row(rows, "Magic Missile").free, false);
});

test("an attack spell shows its damage and that it must hit", () => {
	assert.equal(row(describeKnownSpells(["Fire Bolt"], CATALOGUE), "Fire Bolt").effect,
		"1d10 fire — ranged attack");
});

test("a save spell names the save and what a success does", () => {
	// Half-on-save and nothing-on-save are different decisions for the player.
	assert.equal(row(describeKnownSpells(["Sacred Flame"], CATALOGUE), "Sacred Flame").effect,
		"1d8 radiant — DEX save for none");
	assert.equal(row(describeKnownSpells(["Burning Hands"], CATALOGUE), "Burning Hands").effect,
		"3d6 fire — DEX save for half, 15-foot cone");
});

test("an unerring spell says so instead of showing an attack it never makes", () => {
	assert.equal(row(describeKnownSpells(["Magic Missile"], CATALOGUE), "Magic Missile").effect,
		"3d4+3 force — always hits");
});

test("a healing spell shows what it restores", () => {
	assert.equal(row(describeKnownSpells(["Cure Wounds"], CATALOGUE), "Cure Wounds").effect,
		"heals 1d8 + casting modifier");
});

test("a utility spell falls back to its description", () => {
	assert.equal(row(describeKnownSpells(["Light"], CATALOGUE), "Light").effect,
		"An object you touch sheds bright light.");
});

test("cantrips are listed before the spells that cost a slot", () => {
	const rows = describeKnownSpells(["Cure Wounds", "Fire Bolt", "Magic Missile", "Sacred Flame"], CATALOGUE);
	assert.deepEqual(rows.map((r) => r.name), ["Fire Bolt", "Sacred Flame", "Cure Wounds", "Magic Missile"]);
});

test("a spell missing from the catalogue is still shown, not silently dropped", () => {
	// Dropping it would recreate the defect this list exists to fix: a spell the
	// character owns that the player cannot see. Better a bare name than nothing.
	const rows = describeKnownSpells(["Fire Bolt", "Wish"], CATALOGUE);
	assert.equal(rows.length, 2);
	const unknown = row(rows, "Wish");
	assert.equal(unknown.effect, "—");
	assert.equal(unknown.cost, "—");
});

test("a character who knows nothing gets an empty list, not a broken one", () => {
	assert.deepEqual(describeKnownSpells([], CATALOGUE), []);
});

test("malformed input yields an empty list rather than throwing", () => {
	// This renders inside the character panel; a bad payload must not blank the sheet.
	assert.deepEqual(describeKnownSpells(null, CATALOGUE), []);
	assert.deepEqual(describeKnownSpells(undefined, undefined), []);
	assert.deepEqual(describeKnownSpells(["Fire Bolt"], null), [{ name: "Fire Bolt", level: null, cost: "—", free: false, effect: "—" }]);
});

test("a duplicated name is listed once", () => {
	assert.equal(describeKnownSpells(["Fire Bolt", "Fire Bolt"], CATALOGUE).length, 1);
});

test("a blank or non-string entry is ignored", () => {
	assert.deepEqual(describeKnownSpells(["", null, 7, "Fire Bolt"], CATALOGUE).map((r) => r.name), ["Fire Bolt"]);
});
