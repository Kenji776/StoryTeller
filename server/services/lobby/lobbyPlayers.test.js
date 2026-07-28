/**
 * Tests for character sheet storage.
 *
 * @description `upsertPlayer` initialised `max_hp` from *current* hp on a
 *   character's first save, discarding whatever maximum the sheet supplied. For a
 *   freshly built character the two are equal and nothing shows. For a wounded one —
 *   an imported sheet, a character carried between sessions — the maximum was
 *   permanently reduced to whatever the current total happened to be, and healing
 *   could never lift them past it. A live probe drank a potion that rolled 8 and
 *   watched a 4/20 rogue stay at 4.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { playerMethods } from "./lobbyPlayers.js";

/**
 * Builds a minimal LobbyStore stand-in for the player methods.
 *
 * @description `playerMethods` is mixed into `LobbyStore.prototype`, so binding it to
 *   a `this` exposing `index` and `persist` exercises the real method with no store,
 *   disk or socket (`TDD-8`).
 * @returns {object} The store double.
 */
function makeStore() {
	const store = Object.create(playerMethods);
	store.index = {
		lob1: { lobbyId: "lob1", phase: "lobby", players: {}, sockets: { sid1: { playerName: null } }, hostSid: "sid1" },
	};
	store.persist = () => {};
	return store;
}

/**
 * @description Builds a sheet in the shape the client submits.
 * @param {object} [stats] - Stats to use.
 * @returns {object} A sheet.
 */
function sheet(stats) {
	return { name: "Sylvie", class: "Rogue", race: "Halfling", level: 1, stats, abilities: [], inventory: [] };
}

const statsOf = (store) => store.index.lob1.players.Sylvie.stats;

// ── The defect ───────────────────────────────────────────────────────────────

test("a sheet that states its own max_hp keeps it when the character is wounded", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 4, max_hp: 20, dex: 16 }));

	assert.equal(statsOf(store).max_hp, 20);
	assert.equal(statsOf(store).hp, 4);
});

// ── What must not regress ────────────────────────────────────────────────────

test("a stored max_hp still wins over a re-submitted sheet", () => {
	// This is why the preservation exists: a client must not be able to raise its
	// own maximum by editing the sheet mid-game.
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 12, max_hp: 12, dex: 16 }));
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 12, max_hp: 999, dex: 16 }));

	assert.equal(statsOf(store).max_hp, 12);
});

test("a sheet with no max_hp still initialises it from current hp", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 9, dex: 16 }));

	assert.equal(statsOf(store).max_hp, 9);
});

test("a sheet with neither hp nor max_hp falls back to ten", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ dex: 16 }));

	assert.equal(statsOf(store).max_hp, 10);
});
