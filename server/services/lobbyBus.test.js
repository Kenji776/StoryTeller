import { test } from "node:test";
import assert from "node:assert/strict";

import { createLobbyBus } from "./lobbyBus.js";
import { EventJournal } from "./eventJournal.js";

/**
 * Builds a bus wired to a real journal and a recording stand-in for Socket.IO.
 *
 * @description The `io` double records every broadcast as `{room, args}` so tests can
 *   assert on argument *arity* as well as content — the distinction between a
 *   sequenced and a volatile emit is that the former carries a third `meta`
 *   argument, and nothing else about the call differs.
 * @param {object} [opts] - Overrides.
 * @param {number} [opts.capacity] - Journal retention.
 * @param {object} [opts.snapshot] - What `buildSnapshot` should return.
 * @returns {{bus: object, sent: Array<object>, journal: EventJournal, snapshots: Array<string>}}
 *   The bus plus its recorded traffic.
 */
function makeBus(opts = {}) {
	const sent = [];
	const snapshots = [];
	const io = {
		to(room) {
			return { emit: (...args) => sent.push({ room, args }) };
		},
	};
	const journal = new EventJournal({ capacity: opts.capacity ?? 256, now: () => 5_000 });
	const bus = createLobbyBus({
		io,
		journal,
		epoch: opts.epoch ?? 777,
		buildSnapshot: (lobbyId) => {
			snapshots.push(lobbyId);
			return opts.snapshot ?? { phase: "running" };
		},
	});
	return { bus, sent, journal, snapshots };
}

// ── Sequenced broadcasts ─────────────────────────────────────────────────────

test("a durable event is broadcast to the lobby room", () => {
	const { bus, sent } = makeBus();
	bus.emit("lob1", "hp:update", { player: "Ayla", hp: 7 });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].room, "lob1");
	assert.equal(sent[0].args[0], "hp:update");
	assert.deepEqual(sent[0].args[1], { player: "Ayla", hp: 7 });
});

test("a durable event carries its envelope as a third argument", () => {
	const { bus, sent } = makeBus();
	bus.emit("lob1", "hp:update", {});
	const meta = sent[0].args[2];
	assert.deepEqual(meta, { lid: "lob1", seq: 1, epoch: 777, ts: 5_000 });
});

test("sequence numbers advance across durable events", () => {
	const { bus, sent } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "gold:update", {});
	assert.equal(sent[1].args[2].seq, 2);
});

test("emit returns the envelope it stamped", () => {
	const { bus } = makeBus();
	assert.equal(bus.emit("lob1", "hp:update", {}).seq, 1);
});

test("a snapshot event is sequenced and broadcast with its real payload", () => {
	const { bus, sent } = makeBus();
	bus.emit("lob1", "state:update", { phase: "running", history: [1, 2, 3] });
	assert.deepEqual(sent[0].args[1], { phase: "running", history: [1, 2, 3] });
	assert.equal(sent[0].args[2].seq, 1);
});

// ── Volatile broadcasts ──────────────────────────────────────────────────────

test("an ephemeral event is broadcast without an envelope", () => {
	const { bus, sent } = makeBus();
	bus.emit("lob1", "sfx:play", { effects: [] });
	assert.equal(sent[0].args.length, 2, "no meta argument");
});

test("an ephemeral event consumes no sequence number", () => {
	const { bus, sent } = makeBus();
	bus.emit("lob1", "sfx:play", {});
	bus.emit("lob1", "hp:update", {});
	assert.equal(sent[1].args[2].seq, 1, "the durable event is still the first sequenced one");
});

test("emit returns null for an ephemeral event", () => {
	const { bus } = makeBus();
	assert.equal(bus.emit("lob1", "toast", { message: "hi" }), null);
});

// ── seqOf ────────────────────────────────────────────────────────────────────

test("seqOf reports zero before anything is sequenced", () => {
	const { bus } = makeBus();
	assert.equal(bus.seqOf("lob1"), 0);
});

test("seqOf tracks the latest sequenced event", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "sfx:play", {});
	assert.equal(bus.seqOf("lob1"), 1);
});

// ── sliceSince: replay ───────────────────────────────────────────────────────

test("a client with a recoverable gap is given the events it missed", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", { n: 1 });
	bus.emit("lob1", "gold:update", { n: 2 });
	bus.emit("lob1", "xp:update", { n: 3 });
	const res = bus.sliceSince("lob1", 1, 777);
	assert.equal(res.mode, "replay");
	assert.deepEqual(res.events.map((e) => e.name), ["gold:update", "xp:update"]);
});

test("a replay reports the range it covers", () => {
	const { bus } = makeBus();
	for (let i = 0; i < 3; i++) bus.emit("lob1", "hp:update", {});
	const res = bus.sliceSince("lob1", 1, 777);
	assert.equal(res.fromSeq, 2);
	assert.equal(res.toSeq, 3);
});

test("each replayed event carries the envelope it originally shipped with", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "gold:update", { g: 5 });
	const [ev] = bus.sliceSince("lob1", 1, 777).events;
	assert.deepEqual(ev.meta, { lid: "lob1", seq: 2, epoch: 777, ts: 5_000 });
	assert.deepEqual(ev.payload, { g: 5 });
});

test("a client that is already current gets an empty replay", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	const res = bus.sliceSince("lob1", 1, 777);
	assert.equal(res.mode, "replay");
	assert.deepEqual(res.events, []);
});

test("a replay never includes ephemeral events, which were never journaled", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "sfx:play", {});
	bus.emit("lob1", "gold:update", {});
	const res = bus.sliceSince("lob1", 1, 777);
	assert.deepEqual(res.events.map((e) => e.name), ["gold:update"]);
});

// ── sliceSince: snapshot ─────────────────────────────────────────────────────

test("a first-time client is given a full snapshot rather than a replay", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	const res = bus.sliceSince("lob1", 0, 777);
	assert.equal(res.mode, "snapshot");
	assert.deepEqual(res.state, { phase: "running" });
});

test("a snapshot is watermarked with the sequence it was built at", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "gold:update", {});
	assert.equal(bus.sliceSince("lob1", 0, 777).seq, 2);
});

test("a client from a previous server process is given a snapshot", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	const res = bus.sliceSince("lob1", 1, 111);
	assert.equal(res.mode, "snapshot");
});

test("a gap older than the journal retains is answered with a snapshot", () => {
	const { bus } = makeBus({ capacity: 2 });
	for (let i = 0; i < 5; i++) bus.emit("lob1", "hp:update", {});
	assert.equal(bus.sliceSince("lob1", 1, 777).mode, "snapshot");
});

test("a client holding a sequence this process never issued is given a snapshot", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	assert.equal(bus.sliceSince("lob1", 99, 777).mode, "snapshot");
});

test("a snapshot taken inside the missed range forces a full resync", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	// state:update carries equipment, initiative and pinned moments that no delta
	// repeats, so replaying only the deltas around it would lose them.
	bus.emit("lob1", "state:update", { phase: "running" });
	bus.emit("lob1", "gold:update", {});
	assert.equal(bus.sliceSince("lob1", 1, 777).mode, "snapshot");
});

test("a snapshot the client has already passed does not force a resync", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "state:update", { phase: "running" });
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "gold:update", {});
	assert.equal(bus.sliceSince("lob1", 2, 777).mode, "replay");
});

test("the journal stores a tombstone for a snapshot rather than its full payload", () => {
	const { bus, journal } = makeBus();
	bus.emit("lob1", "state:update", { history: new Array(500).fill("long entry") });
	const stored = journal.since("lob1", 0).events[0];
	assert.ok(!stored.payload.history, "the bulky payload is not retained");
});

test("building a snapshot delegates to the injected builder", () => {
	const { bus, snapshots } = makeBus();
	bus.sliceSince("lob1", 0, 777);
	assert.deepEqual(snapshots, ["lob1"]);
});

test("a replay does not build a snapshot", () => {
	const { bus, snapshots } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "gold:update", {});
	bus.sliceSince("lob1", 1, 777);
	assert.deepEqual(snapshots, []);
});

test("every response reports the current epoch so the client can pin it", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	assert.equal(bus.sliceSince("lob1", 0, 777).epoch, 777);
	assert.equal(bus.sliceSince("lob1", 1, 777).epoch, 777);
});

// ── Teardown ─────────────────────────────────────────────────────────────────

test("dropLobby forgets the lobby's journal", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.dropLobby("lob1");
	assert.equal(bus.seqOf("lob1"), 0);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("emit rejects a missing lobby id", () => {
	const { bus } = makeBus();
	assert.throws(() => bus.emit("", "hp:update", {}), /lobbyId/);
});

test("emit rejects a missing lobby id even for an ephemeral event", () => {
	const { bus } = makeBus();
	assert.throws(() => bus.emit("", "sfx:play", {}), /lobbyId/);
});

test("emit rejects a non-string event name", () => {
	const { bus } = makeBus();
	assert.throws(() => bus.emit("lob1", 42, {}), /event/);
});

test("sliceSince rejects a non-integer sequence", () => {
	const { bus } = makeBus();
	assert.throws(() => bus.sliceSince("lob1", "2", 777), /haveSeq/);
});

test("sliceSince rejects a negative sequence", () => {
	const { bus } = makeBus();
	assert.throws(() => bus.sliceSince("lob1", -1, 777), /haveSeq/);
});

test("createLobbyBus requires a snapshot builder", () => {
	assert.throws(
		() => createLobbyBus({ io: {}, journal: new EventJournal(), epoch: 1 }),
		/buildSnapshot/,
	);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("replayed events are exactly those a client missed, in order", () => {
	const { bus } = makeBus({ capacity: 100 });
	const names = [];
	for (let i = 0; i < 10; i++) {
		const name = i % 2 ? "gold:update" : "hp:update";
		bus.emit("lob1", name, { i });
		names.push(name);
	}
	const res = bus.sliceSince("lob1", 4, 777);
	assert.deepEqual(res.events.map((e) => e.payload.i), [4, 5, 6, 7, 8, 9]);
	assert.deepEqual(res.events.map((e) => e.name), names.slice(4));
});

test("lobbies do not share a sequence counter", () => {
	const { bus } = makeBus();
	bus.emit("lob1", "hp:update", {});
	bus.emit("lob1", "hp:update", {});
	assert.equal(bus.emit("lob2", "hp:update", {}).seq, 1);
});
