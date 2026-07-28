/**
 * Tests for HP application.
 *
 * @description `applyHPChange` had a floor at 0 and no ceiling, while every other
 *   HP write path in the codebase clamps to `max_hp` (short rest in
 *   `lobbySettings`, the admin repairs). A 30-turn playtest ended with a level-1
 *   Fighter at 23/12 and a Wizard at 17/12: healing at full health was strictly
 *   profitable, and the Dungeon Master was then prompted with hit points above a
 *   maximum it was still balancing encounters against.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { progressionMethods } from "./lobbyProgression.js";

/**
 * Builds a minimal LobbyStore stand-in carrying one player.
 *
 * @description `progressionMethods` is mixed into `LobbyStore.prototype`, so binding
 *   it to a `this` exposing `index`, `findPlayerKey` and `persist` exercises the real
 *   method without a store, a disk, or a socket (`TDD-8`).
 * @param {object} [stats] - The player's starting stats.
 * @returns {object} The store double.
 */
function makeStore(stats = { hp: 12, max_hp: 12 }) {
	const store = Object.create(progressionMethods);
	store.index = { lob1: { lobbyId: "lob1", players: { Brannor: { name: "Brannor", stats } } } };
	store.persisted = [];
	store.persist = (id) => store.persisted.push(id);
	store.findPlayerKey = (id, name) => (store.index[id]?.players[name] ? name : null);
	return store;
}

const hpOf = (store) => store.index.lob1.players.Brannor.stats.hp;

// ===== The ceiling =====

test("healing at full health does not push a character above max_hp", () => {
	const store = makeStore({ hp: 12, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", 6), 12);
	assert.equal(hpOf(store), 12);
});

test("an overlarge heal stops exactly at max_hp", () => {
	const store = makeStore({ hp: 7, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", 99), 12);
});

test("a heal that lands short of the maximum is applied in full", () => {
	const store = makeStore({ hp: 4, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", 5), 9);
});

test("a heal landing exactly on the maximum is applied in full", () => {
	const store = makeStore({ hp: 7, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", 5), 12);
});

// ===== The floor, which must survive the new ceiling =====

test("damage still floors at zero rather than going negative", () => {
	const store = makeStore({ hp: 4, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", -99), 0);
});

test("damage that does not kill is applied in full", () => {
	const store = makeStore({ hp: 12, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", -5), 7);
});

test("a character already over maximum is brought down, not up, by damage", () => {
	// Lobbies saved by the unclamped build carry inflated HP. Taking damage must
	// normalise such a character rather than clamping the result upward.
	const store = makeStore({ hp: 23, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", -5), 12);
});

// ===== Sheets that do not carry a maximum =====

test("a sheet with no max_hp is left uncapped rather than collapsing to NaN", () => {
	const store = makeStore({ hp: 10 });
	assert.equal(store.applyHPChange("lob1", "Brannor", 5), 15);
});

test("a non-numeric max_hp is ignored rather than treated as a ceiling", () => {
	for (const bad of [null, 0, -3, "twelve", NaN]) {
		const store = makeStore({ hp: 10, max_hp: bad });
		const after = store.applyHPChange("lob1", "Brannor", 5);
		assert.equal(after, 15, `max_hp ${String(bad)} should not cap`);
		assert.ok(Number.isFinite(after));
	}
});

// ===== Boundaries and invalid input =====

test("a zero delta leaves HP untouched", () => {
	const store = makeStore({ hp: 7, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Brannor", 0), 7);
});

test("a missing or malformed delta is treated as no change", () => {
	for (const bad of [undefined, null, "", NaN, "abc"]) {
		const store = makeStore({ hp: 7, max_hp: 12 });
		assert.equal(store.applyHPChange("lob1", "Brannor", bad), 7, `delta ${String(bad)}`);
	}
});

test("an unknown player yields 0 and changes nothing", () => {
	const store = makeStore({ hp: 7, max_hp: 12 });
	assert.equal(store.applyHPChange("lob1", "Nobody", 5), 0);
	assert.equal(hpOf(store), 7);
	assert.deepEqual(store.persisted, []);
});

test("an unknown lobby yields 0", () => {
	const store = makeStore();
	assert.equal(store.applyHPChange("nope", "Brannor", 5), 0);
});

test("a change is persisted", () => {
	const store = makeStore({ hp: 7, max_hp: 12 });
	store.applyHPChange("lob1", "Brannor", 1);
	assert.deepEqual(store.persisted, ["lob1"]);
});

// ===== Properties =====

test("HP after any change always lies between zero and the maximum", () => {
	for (const start of [0, 1, 7, 12]) {
		for (const delta of [-99, -7, -1, 0, 1, 7, 99]) {
			const store = makeStore({ hp: start, max_hp: 12 });
			const after = store.applyHPChange("lob1", "Brannor", delta);
			assert.ok(after >= 0 && after <= 12, `hp ${start} delta ${delta} -> ${after}`);
		}
	}
});

test("repeated healing is idempotent once the maximum is reached", () => {
	const store = makeStore({ hp: 12, max_hp: 12 });
	store.applyHPChange("lob1", "Brannor", 5);
	store.applyHPChange("lob1", "Brannor", 5);
	assert.equal(hpOf(store), 12);
});
