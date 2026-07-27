import { test } from "node:test";
import assert from "node:assert/strict";

import { turnAttemptMethods, MAX_ACTION_ATTEMPTS } from "./turnAttempts.js";

/**
 * Builds a minimal store hosting the turn-attempt mixin.
 *
 * @description The mixin only needs `index` and `persist`, so no real LobbyStore and
 *   no filesystem are involved (`TDD-8`). Persist calls are counted rather than
 *   performed, because attempt state must survive a reconnect and that means it has
 *   to be written, not merely held in memory.
 * @param {string[]} [order] - Initiative order to seed.
 * @returns {{store: object, lobbyId: string, persists: function(): number}} The host.
 */
function makeStore(order = ["Ayla", "Brom"]) {
	let persistCount = 0;
	const store = {
		index: {
			lob1: {
				lobbyId: "lob1",
				initiative: [...order],
				turnIndex: 0,
				players: Object.fromEntries(order.map((n) => [n, { name: n }])),
			},
		},
		persist() { persistCount++; },
		...turnAttemptMethods,
	};
	return { store, lobbyId: "lob1", persists: () => persistCount };
}

// ── Counting rejections ──────────────────────────────────────────────────────

test("a player starts their turn with no attempts against them", () => {
	const { store, lobbyId } = makeStore();
	assert.equal(store.attemptsUsed(lobbyId, "Ayla"), 0);
});

test("recording a rejection reports the attempt number just used", () => {
	const { store, lobbyId } = makeStore();
	assert.equal(store.recordRejectedAttempt(lobbyId, "Ayla").attempts, 1);
});

test("rejections accumulate within a single turn", () => {
	const { store, lobbyId } = makeStore();
	store.recordRejectedAttempt(lobbyId, "Ayla");
	store.recordRejectedAttempt(lobbyId, "Ayla");
	assert.equal(store.attemptsUsed(lobbyId, "Ayla"), 2);
});

test("a player is not yet exhausted before the final allowed attempt", () => {
	const { store, lobbyId } = makeStore();
	for (let i = 1; i < MAX_ACTION_ATTEMPTS; i++) {
		assert.equal(store.recordRejectedAttempt(lobbyId, "Ayla").exhausted, false, `attempt ${i}`);
	}
});

test("the third rejection exhausts the player's chances", () => {
	const { store, lobbyId } = makeStore();
	let result;
	for (let i = 0; i < MAX_ACTION_ATTEMPTS; i++) result = store.recordRejectedAttempt(lobbyId, "Ayla");
	assert.equal(result.exhausted, true);
	assert.equal(result.attempts, MAX_ACTION_ATTEMPTS);
});

test("a rejection reports how many chances remain, for the player-facing message", () => {
	const { store, lobbyId } = makeStore();
	assert.equal(store.recordRejectedAttempt(lobbyId, "Ayla").remaining, MAX_ACTION_ATTEMPTS - 1);
});

test("remaining never goes negative once exhausted", () => {
	const { store, lobbyId } = makeStore();
	for (let i = 0; i < MAX_ACTION_ATTEMPTS + 3; i++) store.recordRejectedAttempt(lobbyId, "Ayla");
	assert.equal(store.recordRejectedAttempt(lobbyId, "Ayla").remaining, 0);
});

// ── Isolation between players and turns ──────────────────────────────────────

test("one player's rejections do not count against another", () => {
	const { store, lobbyId } = makeStore();
	store.recordRejectedAttempt(lobbyId, "Ayla");
	store.recordRejectedAttempt(lobbyId, "Ayla");
	assert.equal(store.attemptsUsed(lobbyId, "Brom"), 0);
});

test("clearing the turn's attempts gives the next player a clean slate", () => {
	const { store, lobbyId } = makeStore();
	store.recordRejectedAttempt(lobbyId, "Ayla");
	store.clearTurnAttempts(lobbyId);
	assert.equal(store.attemptsUsed(lobbyId, "Ayla"), 0);
});

test("a player who was skipped last round gets their full chances again", () => {
	const { store, lobbyId } = makeStore();
	for (let i = 0; i < MAX_ACTION_ATTEMPTS; i++) store.recordRejectedAttempt(lobbyId, "Ayla");
	store.clearTurnAttempts(lobbyId);
	assert.equal(store.recordRejectedAttempt(lobbyId, "Ayla").exhausted, false);
});

// ── Durability across a reconnect ────────────────────────────────────────────

test("attempt state is persisted, so it survives a reconnect", () => {
	const { store, lobbyId, persists } = makeStore();
	const before = persists();
	store.recordRejectedAttempt(lobbyId, "Ayla");
	assert.ok(persists() > before, "a rejection must be written, not just held in memory");
});

test("clearing attempts is persisted too", () => {
	const { store, lobbyId, persists } = makeStore();
	store.recordRejectedAttempt(lobbyId, "Ayla");
	const before = persists();
	store.clearTurnAttempts(lobbyId);
	assert.ok(persists() > before);
});

test("attempt state lives on the lobby, so it is visible to a rejoining socket", () => {
	const { store, lobbyId } = makeStore();
	store.recordRejectedAttempt(lobbyId, "Ayla");
	// Simulate a fresh socket reading the same lobby object.
	const rehydrated = { index: store.index, persist() {}, ...turnAttemptMethods };
	assert.equal(rehydrated.attemptsUsed(lobbyId, "Ayla"), 1);
});

// ── Invalid input and edges ──────────────────────────────────────────────────

test("recording against an unknown lobby is a harmless no-op", () => {
	const { store } = makeStore();
	const r = store.recordRejectedAttempt("nope", "Ayla");
	assert.equal(r.attempts, 0);
	assert.equal(r.exhausted, false);
});

test("attemptsUsed on an unknown lobby reports zero rather than throwing", () => {
	const { store } = makeStore();
	assert.equal(store.attemptsUsed("nope", "Ayla"), 0);
});

test("clearing an unknown lobby does not throw", () => {
	const { store } = makeStore();
	assert.doesNotThrow(() => store.clearTurnAttempts("nope"));
});

test("a missing player name is rejected rather than silently counted", () => {
	const { store, lobbyId } = makeStore();
	assert.throws(() => store.recordRejectedAttempt(lobbyId, ""), /playerName/);
});

test("the attempt ceiling is three, matching the player-facing promise", () => {
	assert.equal(MAX_ACTION_ATTEMPTS, 3);
});
