import test from "node:test";
import assert from "node:assert/strict";

import {
	CONDITIONS, ITEM_TYPES, DAMAGE_TYPES, WEAPON_RANGES,
	ARMOR_TYPES, ABILITY_SCORES, DICE, PHASES,
} from "./vocab.js";

test("conditions are lower-case, matching how the server stores them", () => {
	// `adminRepairs.js` lower-cases what it receives; offering "Poisoned" here would
	// mean the value sent and the value read back differ.
	for (const condition of CONDITIONS) {
		assert.equal(condition, condition.toLowerCase(), `"${condition}" is not lower-case`);
	}
});

test("no vocabulary list contains a duplicate", () => {
	const lists = {
		CONDITIONS, DAMAGE_TYPES, WEAPON_RANGES, ARMOR_TYPES, DICE,
		ITEM_TYPES: ITEM_TYPES.map((t) => t.id),
		ABILITY_SCORES: ABILITY_SCORES.map((s) => s.id),
		PHASES: PHASES.map((p) => p.id),
	};
	for (const [name, list] of Object.entries(lists)) {
		assert.equal(new Set(list).size, list.length, `${name} has a duplicate`);
	}
});

test("no vocabulary list is empty", () => {
	for (const [name, list] of Object.entries({
		CONDITIONS, ITEM_TYPES, DAMAGE_TYPES, WEAPON_RANGES, ARMOR_TYPES, ABILITY_SCORES, DICE, PHASES,
	})) {
		assert.ok(list.length > 0, `${name} is empty`);
	}
});

test("labelled entries carry both an id and a label", () => {
	for (const list of [ITEM_TYPES, ABILITY_SCORES, PHASES]) {
		for (const entry of list) {
			assert.equal(typeof entry.id, "string");
			assert.ok(entry.id.length > 0);
			assert.equal(typeof entry.label, "string");
			assert.ok(entry.label.length > 0);
		}
	}
});

test("the phase ids are the ones admin:phase expects", () => {
	// These reach `store.setPhase` unchanged; a renamed id here is a silent no-op.
	assert.deepEqual(PHASES.map((p) => p.id), ["characterCreation", "readyCheck", "running"]);
});

test("dice are the polyhedral set the game rolls", () => {
	assert.deepEqual([...DICE], [4, 6, 8, 10, 12, 20]);
});

test("the ability scores are the six the character sheet carries", () => {
	assert.deepEqual(ABILITY_SCORES.map((s) => s.id), ["str", "dex", "con", "int", "wis", "cha"]);
});

test("the vocabulary cannot be edited by whoever imports it", () => {
	assert.throws(() => CONDITIONS.push("cursed"), TypeError);
	assert.throws(() => DICE.push(100), TypeError);
});
