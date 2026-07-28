/**
 * Tests for the party status block handed to the Dungeon Master.
 *
 * @description This block is labelled "authoritative — do not guess or override",
 *   so an error in it becomes an error in the fiction. A 30-turn playtest ran with
 *   the lobby configured for 3 ability uses; the DM was told every character had
 *   "slots: 0/1 ⚠️ NO SLOTS REMAINING" and duly narrated a Wizard's magic failing
 *   for lack of a resource the feasibility gate had, three seconds earlier,
 *   confirmed he still had two of. One variable was serving as both the character's
 *   level and their ability pool.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { describePartyForDM } from "./lobbyPrompts.js";

/**
 * @description Builds a lobby carrying one configurable character.
 * @param {object} [player] - Fields to override on the character.
 * @param {object} [lobby] - Fields to override on the lobby.
 * @returns {object} The lobby record.
 */
function lobbyWith(player = {}, lobby = {}) {
	return {
		abilitySlotsBase: 3,
		players: {
			Brannor: {
				name: "Brannor", class: "Fighter", level: 1, spellSlotsUsed: 0,
				stats: { hp: 12, max_hp: 12 },
				abilities: [{ name: "Second Wind" }],
				...player,
			},
		},
		...lobby,
	};
}

// ===== The pool the lobby actually configured =====

test("the ability pool reported to the DM is the one the host configured", () => {
	const line = describePartyForDM(lobbyWith());
	assert.match(line, /slots: 3\/3/);
	assert.ok(!line.includes("NO SLOTS REMAINING"), line);
});

test("spent uses are subtracted from the configured pool, not from the level", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 1 }));
	assert.match(line, /slots: 2\/3/);
});

test("the character's level is reported independently of the pool", () => {
	// The defect: one `max` variable was both the level and the pool, so raising
	// the pool would have silently promoted every character.
	const line = describePartyForDM(lobbyWith({ level: 1 }, { abilitySlotsBase: 5 }));
	assert.match(line, /Lv 1/);
	assert.match(line, /slots: 5\/5/);
});

test("a higher level widens the pool on top of the configured base", () => {
	const line = describePartyForDM(lobbyWith({ level: 3 }, { abilitySlotsBase: 3 }));
	assert.match(line, /Lv 3/);
	assert.match(line, /slots: 5\/5/);
});

test("the default pool applies when the host set nothing", () => {
	const line = describePartyForDM(lobbyWith({}, { abilitySlotsBase: undefined }));
	assert.match(line, /slots: 1\/1/);
});

// ===== Exhaustion =====

test("the exhaustion warning appears only when the pool is genuinely empty", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 3 }));
	assert.match(line, /slots: 0\/3/);
	assert.match(line, /NO SLOTS REMAINING/);
});

test("overspending past the pool still reports zero, never a negative", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 99 }));
	assert.match(line, /slots: 0\/3/);
});

test("a zero-slot lobby reports the pool as exhausted from the start", () => {
	const line = describePartyForDM(lobbyWith({}, { abilitySlotsBase: 0 }));
	assert.match(line, /slots: 0\/0/);
	assert.match(line, /NO SLOTS REMAINING/);
});

// ===== Unlimited =====

test("an unlimited pool is described in words and never as a fraction", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 7 }, { abilitySlotsBase: "unlimited" }));
	assert.match(line, /slots: unlimited/i);
	assert.ok(!line.includes("NO SLOTS REMAINING"), line);
	assert.ok(!/Infinity|NaN/.test(line), line);
});

// ===== Health =====

test("a dead character is reported as dead rather than by hit points", () => {
	const line = describePartyForDM(lobbyWith({ dead: true, stats: { hp: 0, max_hp: 12 } }));
	assert.match(line, /DEAD/);
});

test("a badly wounded character is flagged to the DM", () => {
	const line = describePartyForDM(lobbyWith({ stats: { hp: 2, max_hp: 12 } }));
	assert.match(line, /HP: 2\/12/);
	assert.match(line, /CRITICALLY LOW HP/);
});

test("a healthy character carries no wound warning", () => {
	const line = describePartyForDM(lobbyWith());
	assert.ok(!line.includes("CRITICALLY LOW"), line);
});

// ===== Abilities and equipment =====

test("abilities are listed by name, whether objects or legacy strings", () => {
	assert.match(describePartyForDM(lobbyWith({ abilities: [{ name: "Second Wind" }] })), /\[Second Wind\]/);
	assert.match(describePartyForDM(lobbyWith({ abilities: ["Old Style"] })), /\[Old Style\]/);
});

test("a character with no abilities is described as having none", () => {
	assert.match(describePartyForDM(lobbyWith({ abilities: [] })), /\[none\]/);
});

test("unarmed and unarmored are stated rather than omitted", () => {
	const line = describePartyForDM(lobbyWith());
	assert.match(line, /weapon: unarmed/);
	assert.match(line, /armor: unarmored/);
});

// ===== Shape =====

test("every party member gets exactly one line", () => {
	const lobby = lobbyWith();
	lobby.players.Sylvie = { name: "Sylvie", class: "Rogue", level: 1, stats: { hp: 9, max_hp: 9 } };
	const lines = describePartyForDM(lobby).split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /Brannor/);
	assert.match(lines[1], /Sylvie/);
});

test("an empty or malformed lobby yields an empty block rather than throwing", () => {
	for (const bad of [null, undefined, {}, { players: null }, { players: {} }]) {
		assert.equal(describePartyForDM(bad), "");
	}
});

test("no line ever contains undefined or NaN", () => {
	const line = describePartyForDM(lobbyWith({ stats: undefined, level: undefined, abilities: undefined }));
	assert.ok(!/undefined|NaN/.test(line), line);
});
