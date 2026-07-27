import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionSystem } from "./sessionEvents.js";
import { PlayerSessions } from "../services/playerSessions.js";
import { EventJournal } from "../services/eventJournal.js";
import { createLobbyBus } from "../services/lobbyBus.js";

/**
 * Builds a session system wired to fakes.
 *
 * @description Clock injected throughout so grace expiry is driven by advancing a
 *   number rather than by sleeping (`TDD-8`). The socket double records both what it
 *   emitted and which rooms it joined, since re-entering the lobby room is the whole
 *   point of a resume.
 * @param {object} [opts] - Overrides.
 * @returns {object} The system plus handles for assertions.
 */
function makeSystem(opts = {}) {
	let clock = 100_000;
	const roomEmits = [];
	const removed = [];

	const lobby = {
		lobbyId: "lob1",
		code: "ABC123",
		phase: "running",
		initiative: ["Ayla", "Brom"],
		turnIndex: 0,
		round: 1,
		players: {
			Ayla: { name: "Ayla", level: 2, stats: { dex: 12, hp: 10 }, initiativeTotal: 15 },
			Brom: { name: "Brom", level: 2, stats: { dex: 10, hp: 10 }, initiativeTotal: 9 },
		},
		sockets: {},
		...opts.lobby,
	};

	const store = {
		index: { lob1: lobby },
		persist() {},
		publicState: (id) => ({ lobbyId: id, phase: lobby.phase, initiative: lobby.initiative, turnIndex: lobby.turnIndex }),
		turnInfo: () => ({ current: lobby.initiative[lobby.turnIndex] ?? null, order: lobby.initiative, round: lobby.round }),
		removeFromTurnOrder: (id, name) => {
			removed.push(name);
			lobby.initiative = lobby.initiative.filter((n) => n !== name);
		},
		insertIntoInitiative: (id, name) => {
			if (!lobby.initiative.includes(name)) lobby.initiative.push(name);
			return lobby.players[name]?.initiativeTotal ?? 0;
		},
	};

	const io = { to: (r) => ({ emit: (event, payload) => roomEmits.push({ room: r, event, payload }) }) };
	const sessions = new PlayerSessions({ now: () => clock, graceMs: opts.graceMs ?? 5_000, newToken: (() => { let n = 0; return () => `tok-${++n}`; })() });
	const journal = new EventJournal({ now: () => clock });
	const bus = createLobbyBus({ io, journal, epoch: 4242, buildSnapshot: (id) => store.publicState(id) });

	const system = createSessionSystem({
		io, store, room: (id) => id, log: () => {}, sessions, bus,
		resolveActiveTurn: () => store.turnInfo(),
		startTurnTimer: () => {},
		cancelTurnTimer: () => {},
		broadcastLobbies: () => {},
	});

	/** @description Builds a socket double with recorded emits and room joins. */
	const makeSocket = (id) => {
		const emits = [];
		const joined = [];
		const handlers = {};
		const sock = {
			id, emits, joined,
			join: (r) => joined.push(r),
			emit: (event, payload) => emits.push({ event, payload }),
			on: (event, fn) => { handlers[event] = fn; },
			fire: (event, ...args) => handlers[event]?.(...args),
		};
		system.registerSessionEvents(sock);
		return sock;
	};

	return { system, sessions, bus, store, lobby, io, roomEmits, removed, makeSocket, advance: (ms) => { clock += ms; } };
}

// ── Issuing a session ────────────────────────────────────────────────────────

test("opening a session hands the client a token to reconnect with", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	const issued = sock.emits.find((e) => e.event === "session:token");
	assert.ok(issued, "session:token must be sent");
	assert.equal(typeof issued.payload.token, "string");
});

test("the issued token also carries the sequence the client is starting from", () => {
	const h = makeSystem();
	h.bus.emit("lob1", "hp:update", { player: "Ayla" });
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	const issued = sock.emits.find((e) => e.event === "session:token");
	assert.equal(issued.payload.seq, 1);
	assert.equal(issued.payload.epoch, 4242);
});

// ── Resuming ─────────────────────────────────────────────────────────────────

test("resuming with a valid token puts the socket back in the lobby room", () => {
	const h = makeSystem();
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);

	const second = h.makeSocket("s2");
	second.fire("session:resume", { token });
	assert.ok(second.joined.includes("lob1"), "the reconnected socket must rejoin the room");
});

test("resuming re-binds the player to the new socket id", () => {
	const h = makeSystem();
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);
	const second = h.makeSocket("s2");
	second.fire("session:resume", { token });
	assert.equal(h.lobby.sockets.s2?.playerName, "Ayla");
	assert.equal(h.lobby.sockets.s1, undefined, "the dead socket record must be released");
});

test("resuming clears the disconnected flag so the party sees them back", () => {
	const h = makeSystem();
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);
	h.system.handleDisconnecting(first);
	assert.equal(h.lobby.players.Ayla.disconnected, true);

	const second = h.makeSocket("s2");
	second.fire("session:resume", { token });
	assert.ok(!h.lobby.players.Ayla.disconnected);
});

test("resuming sends a full snapshot so the client can rebuild", () => {
	const h = makeSystem();
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);
	const second = h.makeSocket("s2");
	second.fire("session:resume", { token });
	assert.ok(second.emits.some((e) => e.event === "session:resumed"));
	assert.ok(second.emits.some((e) => e.event === "state:update"));
});

test("resuming restores a player who had already been dropped from the order", () => {
	const h = makeSystem();
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);
	h.store.removeFromTurnOrder("lob1", "Ayla");
	assert.ok(!h.lobby.initiative.includes("Ayla"));

	const second = h.makeSocket("s2");
	second.fire("session:resume", { token });
	assert.ok(h.lobby.initiative.includes("Ayla"), "a returning player must get their seat back");
});

test("an unknown token is refused so the client falls back to a verified rejoin", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s9");
	sock.fire("session:resume", { token: "tok-never-issued" });
	const reply = sock.emits.find((e) => e.event === "session:resumed");
	assert.equal(reply.payload.ok, false);
	assert.equal(reply.payload.reason, "unknown_session");
});

test("a missing token is refused without throwing", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s9");
	assert.doesNotThrow(() => sock.fire("session:resume", {}));
	assert.equal(sock.emits.find((e) => e.event === "session:resumed").payload.ok, false);
});

// ── Disconnect grace ─────────────────────────────────────────────────────────

test("a disconnect does not immediately remove the player from the turn order", () => {
	// This is the behaviour change: a brief drop used to eject the player from
	// initiative and announce that they left, before they had even noticed.
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	h.system.handleDisconnecting(sock);
	assert.deepEqual(h.removed, []);
	assert.ok(h.lobby.initiative.includes("Ayla"));
});

test("a disconnect puts the session into grace rather than ending it", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", sock);
	h.system.handleDisconnecting(sock);
	assert.equal(h.sessions.byToken(token).state, "grace");
});

test("the table is told the player is reconnecting, not that they left", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	h.system.handleDisconnecting(sock);
	const announced = h.roomEmits.find((e) => e.event === "player:reconnecting");
	assert.ok(announced, "a grace disconnect should read as reconnecting");
	assert.equal(announced.payload.player, "Ayla");
});

test("sweeping before the grace elapses changes nothing", () => {
	const h = makeSystem({ graceMs: 5_000 });
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	h.system.handleDisconnecting(sock);
	h.advance(4_000);
	h.system.sweep();
	assert.deepEqual(h.removed, []);
});

test("sweeping after the grace elapses finally removes the player", () => {
	const h = makeSystem({ graceMs: 5_000 });
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	h.system.handleDisconnecting(sock);
	h.advance(5_000);
	h.system.sweep();
	assert.deepEqual(h.removed, ["Ayla"]);
});

test("an expiring player is announced as having left", () => {
	const h = makeSystem({ graceMs: 5_000 });
	const sock = h.makeSocket("s1");
	h.system.openSession("lob1", "Ayla", sock);
	h.system.handleDisconnecting(sock);
	h.advance(5_000);
	h.system.sweep();
	assert.ok(h.roomEmits.some((e) => e.event === "player:left" && e.payload.player === "Ayla"));
});

test("a player who returns inside the grace window is never removed", () => {
	const h = makeSystem({ graceMs: 5_000 });
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);
	h.system.handleDisconnecting(first);
	h.advance(3_000);
	h.makeSocket("s2").fire("session:resume", { token });
	h.advance(10_000);
	h.system.sweep();
	assert.deepEqual(h.removed, []);
});

test("a late teardown for a replaced socket does not evict the reconnected player", () => {
	// Socket.IO can deliver the old socket's disconnect after the new one is live.
	const h = makeSystem();
	const first = h.makeSocket("s1");
	const { token } = h.system.openSession("lob1", "Ayla", first);
	h.makeSocket("s2").fire("session:resume", { token });
	h.system.handleDisconnecting(first);
	assert.equal(h.sessions.byToken(token).state, "active");
	assert.deepEqual(h.removed, []);
});

// ── Catching up ──────────────────────────────────────────────────────────────

test("a client that missed events is sent exactly those events", () => {
	const h = makeSystem();
	h.bus.emit("lob1", "hp:update", { n: 1 });
	h.bus.emit("lob1", "gold:update", { n: 2 });
	h.bus.emit("lob1", "xp:update", { n: 3 });

	const sock = h.makeSocket("s1");
	let ack;
	sock.fire("sync:request", { lobbyId: "lob1", haveSeq: 1, haveEpoch: 4242 }, (r) => { ack = r; });
	assert.equal(ack.mode, "replay");
	assert.deepEqual(ack.events.map((e) => e.name), ["gold:update", "xp:update"]);
});

test("a client from a previous server process is sent a snapshot instead", () => {
	const h = makeSystem();
	h.bus.emit("lob1", "hp:update", {});
	const sock = h.makeSocket("s1");
	let ack;
	sock.fire("sync:request", { lobbyId: "lob1", haveSeq: 1, haveEpoch: 1 }, (r) => { ack = r; });
	assert.equal(ack.mode, "snapshot");
});

test("a sync request for an unknown lobby is denied rather than answered", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	let ack;
	sock.fire("sync:request", { lobbyId: "nope", haveSeq: 0, haveEpoch: 4242 }, (r) => { ack = r; });
	assert.equal(ack.mode, "denied");
});

test("a malformed sync request is denied without throwing", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	let ack;
	assert.doesNotThrow(() => sock.fire("sync:request", { lobbyId: "lob1", haveSeq: "abc" }, (r) => { ack = r; }));
	assert.equal(ack.mode, "denied");
});

test("a sync request with no callback does not throw", () => {
	const h = makeSystem();
	const sock = h.makeSocket("s1");
	assert.doesNotThrow(() => sock.fire("sync:request", { lobbyId: "lob1", haveSeq: 0, haveEpoch: 4242 }));
});
