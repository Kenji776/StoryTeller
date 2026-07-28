import { test } from "node:test";
import assert from "node:assert/strict";

import { LobbyStore } from "./lobbyStore.js";

/**
 * Builds a store exposing the real `publicState` over a hand-written lobby.
 *
 * @description `publicState` reads `this.index` and calls `hostPlayerName`, both of
 *   which the prototype supplies; nothing else is needed. Constructing the class
 *   properly would touch `server/data/lobbies`, and a unit test must not (`TDD-8`),
 *   so the prototype is borrowed instead.
 * @param {object} [overrides] - Lobby fields to set or replace.
 * @returns {{store: LobbyStore, lobbyId: string}} The host and the lobby's id.
 */
function makeStore(overrides = {}) {
	const store = Object.create(LobbyStore.prototype);
	store.index = {
		lob1: {
			lobbyId: "lob1",
			code: "X4K2",
			phase: "running",
			players: {
				Mira: { name: "Mira", stats: { hp: 18, max_hp: 22 }, level: 3 },
				Bran: { name: "Bran", stats: { hp: 22, max_hp: 30 }, level: 3 },
			},
			sockets: {},
			initiative: ["Mira", "Bran"],
			turnIndex: 1,
			history: [],
			...overrides,
		},
	};
	return { store, lobbyId: "lob1" };
}

test("publicState publishes the current round", () => {
	// Regression: the admin panel read the round from `initiative`, which is an array
	// of names. `round` was never published at all, so the panel's Round indicator
	// was pinned to 1 for the entire life of a campaign.
	const { store, lobbyId } = makeStore({ round: 7 });
	assert.equal(store.publicState(lobbyId).round, 7);
});

test("publicState defaults the round to 1 before combat has begun", () => {
	const { store, lobbyId } = makeStore();
	assert.equal(store.publicState(lobbyId).round, 1);
});

test("publicState still publishes the turn order and pointer alongside the round", () => {
	// The round is additional information, not a replacement: existing clients read
	// `initiative` and `turnIndex` and must keep working.
	const { store, lobbyId } = makeStore({ round: 3 });
	const state = store.publicState(lobbyId);
	assert.deepEqual(state.initiative, ["Mira", "Bran"]);
	assert.equal(state.turnIndex, 1);
});

test("publicState agrees with turnInfo about the round", () => {
	const { store, lobbyId } = makeStore({ round: 5 });
	assert.equal(store.publicState(lobbyId).round, store.turnInfo(lobbyId).round);
});

test("publicState returns null for a lobby that does not exist", () => {
	const { store } = makeStore();
	assert.equal(store.publicState("nope"), null);
});
