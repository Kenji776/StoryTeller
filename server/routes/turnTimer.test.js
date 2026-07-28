import { test } from "node:test";
import assert from "node:assert/strict";

import { createTimerSystem } from "./turnTimer.js";

/**
 * Builds a timer system over fakes.
 *
 * @description Only the synchronous timer paths are exercised here; the LLM-driven
 *   expiry tail is integration territory. `setTimeout` is left real but every test
 *   asserts on what happened *synchronously*, so nothing waits on a clock.
 * @param {object} [opts] - Overrides.
 * @returns {object} The system plus assertion handles.
 */
function makeSystem(opts = {}) {
	const emitted = [];
	const lobby = {
		lobbyId: "lob1",
		phase: "running",
		timerEnabled: true,
		timerMinutes: 3,
		initiative: ["Ayla", "Brom"],
		turnIndex: 0,
		players: { Ayla: { name: "Ayla" }, Brom: { name: "Brom" } },
		sockets: { s1: { playerName: "Ayla" }, s2: { playerName: "Brom" } },
		...opts.lobby,
	};

	const store = {
		index: { lob1: lobby },
		persist() {},
		turnInfo: () => ({ current: lobby.initiative[lobby.turnIndex] ?? null, order: lobby.initiative, round: 1 }),
		publicState: () => ({ lobbyId: "lob1" }),
		removeFromTurnOrder() {},
		nextTurn() {},
		incrementMissedTurns: () => 1,
		appendUser() {},
		composeMessages: () => [],
	};

	const io = {
		to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
		sockets: { sockets: new Map([["s1", {}], ["s2", {}]]) },
	};

	const system = createTimerSystem({
		io, store, log: () => {},
		room: (id) => id,
		devMode: true,
		ttsActiveFor: () => false,
		ELEVEN_API_KEY: "test-key-DO-NOT-USE",
		LLM_TIMEOUT_MS: 1000,
		HISTORY_SUMMARIZE_THRESHOLD: 99,
		MAX_SUMMARY_LENGTH: 1000,
		getLLMResponse: async () => "",
		llmOpts: () => ({}),
		parseDMJson: async () => null,
		streamNarrationToClients: async () => {},
		broadcastXPUpdates() {}, broadcastHPUpdates() {}, broadcastInventoryUpdates() {},
		broadcastGoldUpdates() {}, broadcastConditionUpdates() {}, broadcastAbilityUpdates() {},
		broadcastPartyState() {}, updateMap() {}, resolveSfx: async () => [], broadcastLobbies() {},
		...opts.deps,
	});

	return { system, lobby, emitted, store };
}

// ── The reading delay ────────────────────────────────────────────────────────

test("entering the reading delay clears the previous turn's deadline", () => {
	const h = makeSystem();
	h.lobby.turnDeadlineAt = Date.now() - 60_000;   // last turn's, already past
	h.system.startTurnTimer("lob1", 5_000);
	assert.equal(h.lobby.turnDeadlineAt, null);
	h.system.cancelTurnTimer("lob1");
});

test("starting the real clock records when the turn ends", () => {
	const h = makeSystem();
	h.system.startTurnTimer("lob1", 0);
	assert.ok(h.lobby.turnDeadlineAt > Date.now());
	h.system.cancelTurnTimer("lob1");
});

// ── Resuming ─────────────────────────────────────────────────────────────────

test("resuming with no deadline set starts a fresh clock rather than expiring the turn_regression", () => {
	// The bug: turnDeadlineAt is null during the reading delay, Number(null) is 0,
	// so `0 - Date.now()` is hugely negative and finite. The isFinite guard never
	// fired and every rejection during the reading delay instantly ended that
	// player's turn.
	const h = makeSystem();
	h.lobby.turnDeadlineAt = null;

	h.system.resumeTurnTimer("lob1");

	const started = h.emitted.filter((e) => e.event === "timer:start");
	assert.equal(started.length, 1, "a fresh clock should start");
	assert.ok(started[0].payload.durationMs > 60_000, "it should be a full turn, not a remnant");
	assert.equal(h.lobby.turnIndex, 0, "the turn must not have advanced");
	h.system.cancelTurnTimer("lob1");
});

test("resuming with an undefined deadline also starts a fresh clock", () => {
	const h = makeSystem();
	delete h.lobby.turnDeadlineAt;
	h.system.resumeTurnTimer("lob1");
	assert.ok(h.emitted.some((e) => e.event === "timer:start"));
	h.system.cancelTurnTimer("lob1");
});

test("resuming restores only the time that was left, not a fresh budget", () => {
	const h = makeSystem();
	h.lobby.turnDeadlineAt = Date.now() + 30_000;

	h.system.resumeTurnTimer("lob1");

	const started = h.emitted.find((e) => e.event === "timer:start");
	assert.ok(started.payload.durationMs <= 30_000, `got ${started.payload.durationMs}ms`);
	assert.ok(started.payload.durationMs > 25_000, "and roughly what remained");
	h.system.cancelTurnTimer("lob1");
});

test("resuming keeps the original deadline, so the countdown does not jump", () => {
	const h = makeSystem();
	const deadline = Date.now() + 30_000;
	h.lobby.turnDeadlineAt = deadline;
	h.system.resumeTurnTimer("lob1");
	assert.equal(h.emitted.find((e) => e.event === "timer:start").payload.endsAt, deadline);
	h.system.cancelTurnTimer("lob1");
});

test("resuming a turn whose deadline has genuinely passed does not start a new clock", () => {
	const h = makeSystem();
	h.lobby.turnDeadlineAt = Date.now() - 5_000;

	// handleTimerExpiry bails when the active player has already changed. Flipping
	// the answer after the resume reads it keeps the async expiry tail -- LLM call,
	// turn advance, fresh timer -- out of this synchronous test.
	let reads = 0;
	h.store.turnInfo = () => ({ current: ++reads === 1 ? "Ayla" : "Brom", order: h.lobby.initiative, round: 1 });

	h.system.resumeTurnTimer("lob1");
	assert.ok(!h.emitted.some((e) => e.event === "timer:start"), "an overdue turn expires, it does not restart");
});

test("resuming does nothing when the timer is disabled for the lobby", () => {
	const h = makeSystem({ lobby: { timerEnabled: false } });
	h.lobby.turnDeadlineAt = Date.now() + 30_000;
	h.system.resumeTurnTimer("lob1");
	assert.deepEqual(h.emitted.filter((e) => e.event === "timer:start"), []);
});

test("resuming does nothing for a lobby that is not running", () => {
	const h = makeSystem({ lobby: { phase: "hibernating" } });
	h.lobby.turnDeadlineAt = Date.now() + 30_000;
	h.system.resumeTurnTimer("lob1");
	assert.deepEqual(h.emitted.filter((e) => e.event === "timer:start"), []);
});

test("resuming an unknown lobby does not throw", () => {
	const h = makeSystem();
	assert.doesNotThrow(() => h.system.resumeTurnTimer("nope"));
});

// ── Skipping ─────────────────────────────────────────────────────────────────

test("skipping a turn tells the table who and why", () => {
	const h = makeSystem();
	h.system.skipTurn("lob1", "Ayla", "three rejected actions");
	const skipped = h.emitted.find((e) => e.event === "turn:skipped");
	assert.equal(skipped.payload.player, "Ayla");
	assert.match(skipped.payload.reason, /three/);
	h.system.cancelTurnTimer("lob1");
});

test("skipping releases the action overlay, so nobody is left locked out", () => {
	const h = makeSystem();
	h.system.skipTurn("lob1", "Ayla", "reason");
	assert.ok(h.emitted.some((e) => e.event === "ui:unlock"));
	h.system.cancelTurnTimer("lob1");
});

test("skipping an unknown lobby does not throw", () => {
	const h = makeSystem();
	assert.doesNotThrow(() => h.system.skipTurn("nope", "Ayla", "reason"));
});

// ── Grace ────────────────────────────────────────────────────────────────────

test("a player inside their disconnect grace still counts as present", () => {
	const h = makeSystem({ deps: { hasGrace: (id, name) => name === "Ayla" } });
	h.lobby.sockets = {};   // no live socket at all
	assert.equal(h.system.isPlayerConnected("lob1", "Ayla"), true);
});

test("a player with neither a socket nor grace counts as absent", () => {
	const h = makeSystem({ deps: { hasGrace: () => false } });
	h.lobby.sockets = {};
	assert.equal(h.system.isPlayerConnected("lob1", "Ayla"), false);
});
