import test from "node:test";
import assert from "node:assert/strict";

import { createSocketBridge, MAX_FEED, FORWARDED_EVENTS } from "./socket.js";
import { renderableEvents } from "./feed.js";
import { createStore } from "./store.js";

/**
 * A stand-in for the socket.io client.
 *
 * @description The bridge is the unit under test; the socket is one of its injected
 *   dependencies, in the same way `fetchImpl` is for the provider adapters. This
 *   records what the bridge sent and lets a test play the server's part by firing
 *   an event back (`TDD-8` — no real socket, no network, no timing).
 * @returns {object} The fake, plus `fire` and `sent` for driving and inspecting it.
 */
function fakeSocket() {
	const handlers = new Map();
	const sent = [];
	return {
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		off(event, fn) {
			const list = handlers.get(event) ?? [];
			const at = list.indexOf(fn);
			if (at !== -1) list.splice(at, 1);
		},
		emit(event, payload) {
			sent.push({ event, payload });
		},
		fire(event, payload) {
			for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
		},
		listenerCount(event) {
			return (handlers.get(event) ?? []).length;
		},
		sent,
	};
}

/** Builds a bridge over a real store and a fake socket. */
function harness(initial = {}) {
	const socket = fakeSocket();
	const store = createStore({ feed: [], ...initial });
	const bridge = createSocketBridge({ socket, store, now: () => 1_700_000_000_000 });
	return { socket, store, bridge };
}

/** The last thing the bridge sent. */
const lastSent = (socket) => socket.sent.at(-1);

// ── construction ──────────────────────────────────────────────────────────────

test("the bridge refuses to be built without its collaborators", () => {
	const store = createStore({});
	assert.throws(() => createSocketBridge({ store }), { name: "TypeError", message: /socket/ });
	assert.throws(() => createSocketBridge({ socket: fakeSocket() }), { name: "TypeError", message: /store/ });
	assert.throws(() => createSocketBridge(), { name: "TypeError" });
});

// ── connecting to a lobby ─────────────────────────────────────────────────────

test("connecting asks the server for the lobby and remembers the code", () => {
	const { socket, store, bridge } = harness();
	bridge.connectLobby("x4k2");
	assert.deepEqual(lastSent(socket), { event: "admin:connect", payload: { code: "X4K2" } });
	assert.equal(store.getState().lobby, "X4K2");
});

test("connecting to nothing is refused rather than sent as an empty code", () => {
	const { socket, bridge } = harness();
	for (const code of ["", "   ", null, undefined]) bridge.connectLobby(code);
	assert.equal(socket.sent.length, 0);
});

test("the lobby's state lands in the store when the server sends it", () => {
	const { socket, store } = harness();
	socket.fire("admin:connected", { code: "X4K2", phase: "running" });
	assert.deepEqual(store.getState().lobbyState, { code: "X4K2", phase: "running" });
	assert.equal(store.getState().status, "connected");
});

test("a later state update replaces the one being held", () => {
	const { socket, store } = harness();
	socket.fire("admin:connected", { code: "X4K2", phase: "running" });
	socket.fire("admin:update", { code: "X4K2", phase: "wiped" });
	assert.equal(store.getState().lobbyState.phase, "wiped");
});

test("incidents and the repair catalogue land in their own slices", () => {
	const { socket, store } = harness();
	socket.fire("admin:incidents", [{ id: "1", resolved: false }]);
	socket.fire("admin:repairs", [{ type: "hp:set", fields: ["player", "hp"] }]);
	assert.equal(store.getState().incidents.length, 1);
	assert.equal(store.getState().repairs.length, 1);
});

test("a live incident makes the bridge re-ask for the full list", () => {
	// Counts and ordering are computed server-side; re-requesting keeps them right
	// rather than trying to merge one incident into the list by hand.
	const { socket, bridge } = harness();
	bridge.connectLobby("X4K2");
	socket.sent.length = 0;
	socket.fire("admin:incident", { id: "2" });
	assert.deepEqual(lastSent(socket), { event: "admin:connect", payload: { code: "X4K2" } });
});

// ── the activity feed ─────────────────────────────────────────────────────────

test("a forwarded event becomes an activity line", () => {
	const { socket, store } = harness();
	socket.fire("xp:update", { player: "Mira", amount: 200, reason: "Riddle", xp: 1650 });
	const { feed } = store.getState();
	assert.equal(feed.length, 1);
	assert.equal(feed[0].type, "xp");
	assert.match(feed[0].message, /Mira gained 200 XP/);
});

test("every forwarded event name has a formatter behind it", () => {
	// A name in this list with no formatter is a socket handler that quietly does
	// nothing, which is indistinguishable from the server never sending it.
	const payloads = {
		"xp:update": { player: "a", amount: 1, xp: 1 },
		"hp:update": { player: "a", delta: 1, hp: 1 },
		"gold:update": { player: "a", delta: 1, gold: 1 },
		"turn:update": { current: "a", order: ["a"] },
		"player:action": { player: "a", text: "I open the door." },
		"narration": { content: "The door opens." },
		"player:death": { player: "a" },
		"player:levelup": { newLevel: 2 },
		"player:kicked": { reason: "x" },
		"music:change": { mood: "calm" },
		"sfx:play": { effects: [{ name: "clang" }] },
		"roll:required": { player: "a", sides: 20, stats: [] },
		// The shape the server really sends (lobbyCombat.autoRollIfNeeded). This table
		// previously carried {roll, total, sides}, which the server has never emitted.
		"dice:result": { player: "a", kind: "d20 PERCEPTION (wis+2)", value: 16, detail: { base: 14, bonus: 2, stat: "wis", outcome: "success" } },
		"conditions:update": { player: "a", conditions: [] },
		"inventory:update": { player: "a", item: "x", change: 1, newCount: 1 },
		"spellslots:update": { player: "a", spellSlotsUsed: 1, maxSlots: 2 },
		"rest:vote:start": { type: "long", proposer: "a" },
		"rest:vote:result": { type: "long", passed: true },
		"game:over": { reason: "x" },
		"toast": { type: "info", message: "x" },
	};

	for (const event of FORWARDED_EVENTS) {
		const { socket, store } = harness();
		socket.fire(event, payloads[event]);
		assert.equal(store.getState().feed.length, 1, `${event} produced no activity line`);
	}
});

test("the feed keeps events in the order they arrived", () => {
	const { socket, store } = harness();
	socket.fire("gold:update", { player: "Mira", delta: 5, gold: 5 });
	socket.fire("gold:update", { player: "Mira", delta: 5, gold: 10 });
	assert.deepEqual(store.getState().feed.map((e) => e.message.includes("now: 10") || e.message.endsWith("10")), [false, true]);
});

test("the feed is a tail, not an archive", () => {
	const { socket, store } = harness();
	for (let i = 0; i < MAX_FEED + 25; i += 1) {
		socket.fire("gold:update", { player: "Mira", delta: 1, gold: i });
	}
	const { feed } = store.getState();
	assert.equal(feed.length, MAX_FEED);
	assert.match(feed.at(-1).message, new RegExp(`now ${MAX_FEED + 24}$`), "the newest event survives");
});

test("a contentless narration adds nothing to the feed", () => {
	const { socket, store } = harness();
	socket.fire("narration", { content: null });
	assert.equal(store.getState().feed.length, 0);
});

test("a sound-effect test result is held for the section that asked for it", () => {
	const { socket, store } = harness();
	socket.fire("admin:sfx:result", { ok: true, effect: { name: "clang", file: "clang.mp3" }, source: "library" });
	assert.equal(store.getState().sfxResult.ok, true);
	assert.equal(store.getState().sfxResult.effect.name, "clang");
});

test("a repair result is reported in the feed, refusals included", () => {
	const { socket, store } = harness();
	socket.fire("admin:repair:result", { type: "hp:set", ok: false, reason: "No character named \"Nobody\"" });
	assert.match(store.getState().feed.at(-1).message, /refused/i);
});

// ── lobby deletion ────────────────────────────────────────────────────────────

test("deleting the connected lobby clears what the panel was showing", () => {
	const { socket, store, bridge } = harness();
	bridge.connectLobby("X4K2");
	socket.fire("admin:connected", { code: "X4K2" });
	socket.fire("admin:lobbyDeleted", { code: "X4K2" });
	assert.equal(store.getState().lobby, null);
	assert.equal(store.getState().lobbyState, null);
});

test("deleting a different lobby leaves the connected one alone", () => {
	const { socket, store, bridge } = harness();
	bridge.connectLobby("X4K2");
	socket.fire("admin:connected", { code: "X4K2" });
	socket.fire("admin:lobbyDeleted", { code: "Q7M1" });
	assert.equal(store.getState().lobby, "X4K2");
	assert.notEqual(store.getState().lobbyState, null);
});

// ── connection lifecycle ──────────────────────────────────────────────────────

test("the connection state is reported as it changes", () => {
	const { socket, store } = harness();
	socket.fire("disconnect", "transport close");
	assert.equal(store.getState().status, "disconnected");
	assert.match(store.getState().statusDetail, /transport close/);

	socket.fire("connect_error", new Error("refused"));
	assert.equal(store.getState().status, "error");
	assert.match(store.getState().statusDetail, /refused/);
});

test("reconnecting rejoins the lobby that was open", () => {
	// Without this, a dropped connection leaves the panel showing stale state it can
	// no longer receive updates for.
	const { socket, bridge } = harness();
	bridge.connectLobby("X4K2");
	socket.sent.length = 0;
	socket.fire("connect");
	assert.deepEqual(lastSent(socket), { event: "admin:connect", payload: { code: "X4K2" } });
});

test("reconnecting with no lobby open asks for nothing", () => {
	const { socket } = harness();
	socket.fire("connect");
	assert.equal(socket.sent.length, 0);
});

// ── actions ───────────────────────────────────────────────────────────────────

test("actions carry the connected lobby's code without the caller passing it", () => {
	const { socket, bridge } = harness();
	bridge.connectLobby("X4K2");

	bridge.sendEvent("xp:update", { player: "Mira", amount: 10 });
	assert.deepEqual(lastSent(socket), {
		event: "admin:event",
		payload: { code: "X4K2", type: "xp:update", payload: { player: "Mira", amount: 10 } },
	});

	bridge.sendDM("The door opens.");
	assert.deepEqual(lastSent(socket), { event: "admin:dm", payload: { code: "X4K2", content: "The door opens." } });

	bridge.setPhase("running");
	assert.deepEqual(lastSent(socket), { event: "admin:phase", payload: { code: "X4K2", phase: "running" } });

	bridge.nextTurn();
	assert.deepEqual(lastSent(socket), { event: "admin:nextTurn", payload: { code: "X4K2" } });

	bridge.setMusic("tense_combat");
	assert.deepEqual(lastSent(socket), { event: "admin:music", payload: { code: "X4K2", mood: "tense_combat" } });

	bridge.setLLM("claude", "claude-sonnet-4-6");
	assert.deepEqual(lastSent(socket), {
		event: "admin:llm",
		payload: { code: "X4K2", provider: "claude", model: "claude-sonnet-4-6" },
	});

	bridge.testSfx("sword clash");
	assert.deepEqual(lastSent(socket), { event: "admin:sfx", payload: { code: "X4K2", description: "sword clash" } });

	bridge.sendRepair("hp:set", { player: "Mira", hp: 18 });
	assert.deepEqual(lastSent(socket), {
		event: "admin:repair",
		payload: { code: "X4K2", type: "hp:set", payload: { player: "Mira", hp: 18 } },
	});

	bridge.resolveIncident("inc-1");
	assert.deepEqual(lastSent(socket), { event: "admin:incident:resolve", payload: { code: "X4K2", id: "inc-1" } });
});

test("stopping the music is sent as an explicit null, not an omission", () => {
	const { socket, bridge } = harness();
	bridge.connectLobby("X4K2");
	bridge.setMusic(null);
	assert.deepEqual(lastSent(socket), { event: "admin:music", payload: { code: "X4K2", mood: null } });
});

test("an action with no lobby connected is refused rather than sent codeless", () => {
	const { socket, bridge } = harness();
	bridge.sendEvent("xp:update", { player: "Mira" });
	bridge.sendDM("hello");
	bridge.nextTurn();
	bridge.sendRepair("hp:set", {});
	assert.equal(socket.sent.length, 0);
});

test("deleting a lobby names the lobby explicitly, since it need not be the open one", () => {
	const { socket, bridge } = harness();
	bridge.connectLobby("X4K2");
	bridge.deleteLobby("Q7M1");
	assert.deepEqual(lastSent(socket), { event: "admin:deleteLobby", payload: { code: "Q7M1" } });
});

test("host authentication is sent as the host view's own handshake", () => {
	const { socket, bridge } = harness();
	bridge.hostAuth("X4K2", "char-123");
	assert.deepEqual(lastSent(socket), {
		event: "host:auth",
		payload: { lobbyCode: "X4K2", characterId: "char-123" },
	});
});

// ── teardown ──────────────────────────────────────────────────────────────────

test("disposing detaches every handler the bridge attached", () => {
	const { socket, bridge } = harness();
	const before = FORWARDED_EVENTS.map((event) => socket.listenerCount(event));
	assert.ok(before.every((count) => count > 0), "handlers should be attached to begin with");

	bridge.dispose();
	for (const event of FORWARDED_EVENTS) {
		assert.equal(socket.listenerCount(event), 0, `${event} still has a handler`);
	}
});

test("events arriving after disposal change nothing", () => {
	const { socket, store, bridge } = harness();
	bridge.dispose();
	socket.fire("xp:update", { player: "Mira", amount: 1, xp: 1 });
	assert.equal(store.getState().feed.length, 0);
});

// ── Renderers and subscriptions must agree ───────────────────────────────────

test("every event the feed can render is actually subscribed to", () => {
	// A formatter for an event nobody forwards is dead code wearing the costume of a
	// working feature: the unit test passes, the renderer is correct, and the line
	// never appears in the log because the handler was never installed.
	const forwarded = new Set(FORWARDED_EVENTS);
	const unsubscribed = renderableEvents().filter((event) => !forwarded.has(event));
	assert.deepEqual(unsubscribed, [], `renderers with no subscription: ${unsubscribed.join(", ")}`);
});
