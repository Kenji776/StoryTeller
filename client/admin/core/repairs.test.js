import test from "node:test";
import assert from "node:assert/strict";

import { isPlayerRepair, playerRepairs, lobbyRepairs, fieldsExcludingPlayer, PLAYER_FIELD } from "./repairs.js";

/**
 * The catalogue as `server/services/adminRepairs.js` publishes it.
 *
 * @description Copied rather than imported: this is the browser half of a socket
 *   contract, and a test that imports the server's own constant would pass even if
 *   the two had drifted apart.
 * @returns {Array<object>} The catalogue.
 */
const catalogue = () => [
	{ type: "player:revive", label: "Revive character", fields: ["player", "hp"] },
	{ type: "hp:set", label: "Set hit points", fields: ["player", "hp"] },
	{ type: "slots:set", label: "Set ability uses spent", fields: ["player", "used"] },
	{ type: "conditions:set", label: "Replace conditions", fields: ["player", "conditions"] },
	{ type: "turn:set", label: "Hand the turn to", fields: ["player"] },
	{ type: "order:rebuild", label: "Rebuild turn order", fields: [] },
	{ type: "ui:unlock", label: "Release action overlay", fields: [] },
	{ type: "resync:force", label: "Force resync", fields: [] },
];

test("a repair naming a character is player-scoped", () => {
	assert.equal(isPlayerRepair({ fields: ["player", "hp"] }), true);
	assert.equal(isPlayerRepair({ fields: ["player"] }), true);
});

test("a repair naming no character is not player-scoped", () => {
	assert.equal(isPlayerRepair({ fields: [] }), false);
	assert.equal(isPlayerRepair({ fields: ["hp"] }), false);
});

test("isPlayerRepair tolerates a malformed catalogue entry", () => {
	assert.equal(isPlayerRepair({}), false);
	assert.equal(isPlayerRepair({ fields: null }), false);
	assert.equal(isPlayerRepair(null), false);
	assert.equal(isPlayerRepair(undefined), false);
});

test("the player-scoped repairs are the ones the inspector can offer", () => {
	assert.deepEqual(playerRepairs(catalogue()).map((r) => r.type),
		["player:revive", "hp:set", "slots:set", "conditions:set", "turn:set"]);
});

test("the lobby-scoped repairs are the ones no character owns", () => {
	assert.deepEqual(lobbyRepairs(catalogue()).map((r) => r.type),
		["order:rebuild", "ui:unlock", "resync:force"]);
});

test("every repair lands in exactly one of the two groups", () => {
	// A repair in neither would silently disappear from the interface.
	const all = catalogue();
	const split = [...playerRepairs(all), ...lobbyRepairs(all)].map((r) => r.type).sort();
	assert.deepEqual(split, all.map((r) => r.type).sort());
});

test("catalogue order is preserved, since the server chose it", () => {
	const reordered = [...catalogue()].reverse();
	assert.deepEqual(playerRepairs(reordered).map((r) => r.type),
		["turn:set", "conditions:set", "slots:set", "hp:set", "player:revive"]);
});

test("an empty or absent catalogue yields no repairs rather than throwing", () => {
	for (const input of [[], null, undefined]) {
		assert.deepEqual(playerRepairs(input), []);
		assert.deepEqual(lobbyRepairs(input), []);
	}
});

test("the player field is dropped once the character is already chosen", () => {
	assert.deepEqual(fieldsExcludingPlayer({ fields: ["player", "hp"] }), ["hp"]);
	assert.deepEqual(fieldsExcludingPlayer({ fields: ["player", "conditions"] }), ["conditions"]);
});

test("a repair that takes only a player needs no further input", () => {
	assert.deepEqual(fieldsExcludingPlayer({ fields: ["player"] }), []);
});

test("a lobby-scoped repair's fields are returned untouched", () => {
	assert.deepEqual(fieldsExcludingPlayer({ fields: [] }), []);
	assert.deepEqual(fieldsExcludingPlayer({ fields: ["hp"] }), ["hp"]);
});

test("fieldsExcludingPlayer tolerates a malformed entry", () => {
	assert.deepEqual(fieldsExcludingPlayer({}), []);
	assert.deepEqual(fieldsExcludingPlayer(null), []);
});

test("the player field name matches what the server reads", () => {
	assert.equal(PLAYER_FIELD, "player");
});
