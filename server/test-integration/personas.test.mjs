/**
 * Tests for the persona brief.
 *
 * @description These run in the integration tier because that is where the harness lives,
 *   but they touch no network and no model — `viewFromState` and `systemPrompt` are pure.
 *   Run with `node --test server/test-integration/personas.test.mjs`.
 *
 *   A live four-hander went fifteen actions with two casters and never cast anything. The
 *   agents kept narrating preparation — "readying myself to heal", "prepare for a spell" —
 *   and one finally asked the table, out of character, how spell slots worked. The brief
 *   listed abilities and inventory and never mentioned that the character knew any spells,
 *   so as far as the agent was concerned it did not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { viewFromState, systemPrompt } from "./personas.mjs";

/**
 * @description Builds a `state:update` snapshot holding one caster.
 * @param {object} [over] - Fields to override on the sheet.
 * @returns {object} A state payload.
 */
function stateWithCaster(over = {}) {
	return {
		abilitySlotsBase: 3,
		players: {
			"Ovid Marrow": {
				class: "Cleric",
				level: 2,
				abilities: [{ name: "Channel Divinity" }],
				inventory: [{ name: "Healing Potion", count: 2 }],
				spells: ["Sacred Flame", "Cure Wounds"],
				spellSlotsUsed: 1,
				stats: { hp: 7, max_hp: 12 },
				...over,
			},
		},
		party: [],
		enemies: [],
	};
}

const PLAYER = { name: "Ovid Marrow", spec: { race: "Human", cls: "Cleric" } };

test("the view carries the spells the character actually knows", () => {
	const view = viewFromState(stateWithCaster(), "Ovid Marrow");
	assert.deepEqual(view.spells, ["Sacred Flame", "Cure Wounds"]);
});

test("the view reports spell slots left, not slots used", () => {
	// The sheet stores what has been spent; an agent needs what remains.
	const view = viewFromState(stateWithCaster(), "Ovid Marrow");
	assert.equal(view.spellSlots, "1 of 2");
});

test("a caster with every slot spent is told none remain", () => {
	const view = viewFromState(stateWithCaster({ spellSlotsUsed: 2 }), "Ovid Marrow");
	assert.equal(view.spellSlots, "0 of 2");
});

test("spent slots beyond the maximum still report zero rather than a negative", () => {
	const view = viewFromState(stateWithCaster({ spellSlotsUsed: 9 }), "Ovid Marrow");
	assert.equal(view.spellSlots, "0 of 2");
});

test("a non-caster has no spells and no slot line", () => {
	const view = viewFromState(stateWithCaster({ spells: [], class: "Fighter" }), "Ovid Marrow");
	assert.deepEqual(view.spells, []);
	assert.equal(view.spellSlots, null);
});

test("a sheet with no spells field at all does not break the view", () => {
	const state = stateWithCaster();
	delete state.players["Ovid Marrow"].spells;
	const view = viewFromState(state, "Ovid Marrow");
	assert.deepEqual(view.spells, []);
});

test("the brief names the spells the character knows", () => {
	// The defect verbatim: the agent could not act on what it was never told.
	const prompt = systemPrompt(PLAYER, viewFromState(stateWithCaster(), "Ovid Marrow"));
	assert.match(prompt, /Sacred Flame/);
	assert.match(prompt, /Cure Wounds/);
});

test("the brief states the phrasing that actually casts a spell", () => {
	// Saying "I ready myself to heal" resolves as nothing. The server recognises a cast
	// by name, so the agent has to be told to name it.
	const prompt = systemPrompt(PLAYER, viewFromState(stateWithCaster(), "Ovid Marrow"));
	assert.match(prompt, /I cast <?name/i);
});

test("the brief tells a caster how many slots are left", () => {
	const prompt = systemPrompt(PLAYER, viewFromState(stateWithCaster(), "Ovid Marrow"));
	assert.match(prompt, /Spell slots left: 1 of 2/);
});

test("a non-caster's brief says nothing about spells at all", () => {
	// Otherwise every fighter is invited to cast something it does not have.
	const view = viewFromState(stateWithCaster({ spells: [], class: "Fighter" }), "Ovid Marrow");
	const prompt = systemPrompt({ name: "Brannor Ironfoot", spec: { race: "Dwarf", cls: "Fighter" } }, view);
	assert.doesNotMatch(prompt, /spell/i);
});
