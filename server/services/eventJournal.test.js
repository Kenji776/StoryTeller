import { test } from "node:test";
import assert from "node:assert/strict";

import { EventJournal } from "./eventJournal.js";

/**
 * Builds a journal with a deterministic clock so timestamps are assertable.
 *
 * @description The journal takes its clock as a dependency (`TDD-8`) so tests never
 *   read the real time. The returned `tick` advances the fake clock by one millisecond
 *   per call, which is enough to prove timestamps are read at record time rather than
 *   at construction time.
 * @param {object} [opts] - Overrides forwarded to the `EventJournal` constructor.
 * @param {number} [opts.capacity] - Retained events per lobby.
 * @returns {{journal: EventJournal, tick: function(): void, at: function(): number}}
 *   The journal plus controls for its fake clock.
 */
function makeJournal(opts = {}) {
	let clock = 1_000;
	const journal = new EventJournal({ now: () => clock, ...opts });
	return {
		journal,
		tick: () => { clock += 1; },
		at: () => clock,
	};
}

// ── Sequencing: the happy path ───────────────────────────────────────────────

test("record assigns sequence number 1 to the first event in a lobby", () => {
	const { journal } = makeJournal();
	const env = journal.record("lob1", "hp:update", { player: "Ayla", hp: 7 });
	assert.equal(env.seq, 1);
});

test("record increments the sequence number on each subsequent event", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	journal.record("lob1", "gold:update", {});
	const third = journal.record("lob1", "turn:update", {});
	assert.equal(third.seq, 3);
});

test("record keeps sequence numbers independent across lobbies", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	journal.record("lob1", "hp:update", {});
	const other = journal.record("lob2", "hp:update", {});
	assert.equal(other.seq, 1);
});

test("record returns an envelope carrying the event name, payload and clock reading", () => {
	const { journal, tick, at } = makeJournal();
	tick();
	const payload = { player: "Ayla", delta: -3 };
	const env = journal.record("lob1", "hp:update", payload);
	assert.deepEqual(env, { seq: 1, event: "hp:update", payload, at: at() });
});

test("record reads the clock at record time, not at construction time", () => {
	const { journal, tick } = makeJournal();
	const first = journal.record("lob1", "hp:update", {});
	tick();
	const second = journal.record("lob1", "hp:update", {});
	assert.equal(second.at, first.at + 1);
});

// ── Replay ───────────────────────────────────────────────────────────────────

test("since returns every retained event when the caller has seen nothing", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", { n: 1 });
	journal.record("lob1", "gold:update", { n: 2 });
	const result = journal.since("lob1", 0);
	assert.equal(result.ok, true);
	assert.deepEqual(result.events.map((e) => e.seq), [1, 2]);
});

test("since returns only events newer than the caller's last seen sequence", () => {
	const { journal } = makeJournal();
	for (let i = 0; i < 4; i++) journal.record("lob1", "hp:update", { n: i });
	const result = journal.since("lob1", 2);
	assert.deepEqual(result.events.map((e) => e.seq), [3, 4]);
});

test("since returns an empty list when the caller is already current", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	const result = journal.since("lob1", 1);
	assert.equal(result.ok, true);
	assert.deepEqual(result.events, []);
});

test("since reports the latest sequence so a caller can confirm it caught up", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	journal.record("lob1", "hp:update", {});
	assert.equal(journal.since("lob1", 0).latestSeq, 2);
});

test("since treats an unknown lobby as empty rather than failing", () => {
	const { journal } = makeJournal();
	const result = journal.since("never-existed", 0);
	assert.deepEqual(result, { ok: true, events: [], latestSeq: 0 });
});

// ── Gap detection: the cases that force a full resync ─────────────────────────

test("since reports a gap when the requested history has already been evicted", () => {
	const { journal } = makeJournal({ capacity: 2 });
	for (let i = 0; i < 4; i++) journal.record("lob1", "hp:update", { n: i });
	const result = journal.since("lob1", 1);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "gap_too_old");
});

test("since succeeds at the exact boundary where the next event is still retained", () => {
	const { journal } = makeJournal({ capacity: 2 });
	for (let i = 0; i < 4; i++) journal.record("lob1", "hp:update", { n: i });
	// Events 3 and 4 are retained, so a caller that has seen 2 can still be caught up.
	const result = journal.since("lob1", 2);
	assert.equal(result.ok, true);
	assert.deepEqual(result.events.map((e) => e.seq), [3, 4]);
});

test("since reports the caller is ahead when its sequence exceeds the server's", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	// Happens after a server restart: the client holds sequence numbers from the
	// previous process, which the fresh in-memory journal knows nothing about.
	const result = journal.since("lob1", 99);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "ahead");
});

test("since reports the caller is ahead for an unknown lobby with a non-zero sequence", () => {
	const { journal } = makeJournal();
	const result = journal.since("never-existed", 5);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "ahead");
});

test("a failed since still reports the latest sequence so the caller can resync to it", () => {
	const { journal } = makeJournal({ capacity: 2 });
	for (let i = 0; i < 4; i++) journal.record("lob1", "hp:update", {});
	const result = journal.since("lob1", 1);
	assert.equal(result.ok, false);
	assert.equal(result.latestSeq, 4);
});

// ── Bounded retention ────────────────────────────────────────────────────────

test("the journal evicts the oldest events once capacity is exceeded", () => {
	const { journal } = makeJournal({ capacity: 3 });
	for (let i = 0; i < 5; i++) journal.record("lob1", "hp:update", { n: i });
	assert.deepEqual(journal.since("lob1", 2).events.map((e) => e.seq), [3, 4, 5]);
});

test("eviction does not reset or reuse sequence numbers", () => {
	const { journal } = makeJournal({ capacity: 2 });
	for (let i = 0; i < 5; i++) journal.record("lob1", "hp:update", {});
	assert.equal(journal.latestSeq("lob1"), 5);
});

test("a capacity of one retains only the newest event", () => {
	const { journal } = makeJournal({ capacity: 1 });
	journal.record("lob1", "hp:update", {});
	journal.record("lob1", "gold:update", {});
	const result = journal.since("lob1", 1);
	assert.deepEqual(result.events.map((e) => e.event), ["gold:update"]);
});

// ── latestSeq ────────────────────────────────────────────────────────────────

test("latestSeq is zero for a lobby that has never recorded an event", () => {
	const { journal } = makeJournal();
	assert.equal(journal.latestSeq("never-existed"), 0);
});

test("latestSeq tracks the most recently assigned sequence number", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	journal.record("lob1", "hp:update", {});
	assert.equal(journal.latestSeq("lob1"), 2);
});

// ── drop ─────────────────────────────────────────────────────────────────────

test("drop forgets a lobby entirely so its sequence restarts", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	journal.drop("lob1");
	assert.equal(journal.latestSeq("lob1"), 0);
	assert.equal(journal.record("lob1", "hp:update", {}).seq, 1);
});

test("drop leaves other lobbies untouched", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	journal.record("lob2", "hp:update", {});
	journal.drop("lob1");
	assert.equal(journal.latestSeq("lob2"), 1);
});

test("drop is silent for a lobby that was never recorded", () => {
	const { journal } = makeJournal();
	assert.doesNotThrow(() => journal.drop("never-existed"));
});

// ── Invalid input: validated at the boundary per CQ-6 ────────────────────────

test("record rejects a missing lobby id", () => {
	const { journal } = makeJournal();
	assert.throws(
		() => journal.record("", "hp:update", {}),
		/lobbyId/,
	);
});

test("record rejects a non-string event name", () => {
	const { journal } = makeJournal();
	assert.throws(
		() => journal.record("lob1", 42, {}),
		/event/,
	);
});

test("record rejects an empty event name", () => {
	const { journal } = makeJournal();
	assert.throws(
		() => journal.record("lob1", "", {}),
		/event/,
	);
});

test("since rejects a non-numeric sequence", () => {
	const { journal } = makeJournal();
	assert.throws(
		() => journal.since("lob1", "3"),
		/afterSeq/,
	);
});

test("since rejects a negative sequence", () => {
	const { journal } = makeJournal();
	assert.throws(
		() => journal.since("lob1", -1),
		/afterSeq/,
	);
});

test("since rejects a fractional sequence", () => {
	const { journal } = makeJournal();
	assert.throws(
		() => journal.since("lob1", 1.5),
		/afterSeq/,
	);
});

test("the constructor rejects a capacity below one", () => {
	assert.throws(
		() => new EventJournal({ capacity: 0 }),
		/capacity/,
	);
});

test("the constructor rejects a non-integer capacity", () => {
	assert.throws(
		() => new EventJournal({ capacity: 2.5 }),
		/capacity/,
	);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("sequence numbers are strictly increasing across many records", () => {
	const { journal } = makeJournal({ capacity: 500 });
	const seqs = [];
	for (let i = 0; i < 200; i++) seqs.push(journal.record("lob1", "hp:update", {}).seq);
	for (let i = 1; i < seqs.length; i++) {
		assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} must exceed ${seqs[i - 1]}`);
	}
});

test("replayed events are contiguous and strictly newer than the requested sequence", () => {
	const { journal } = makeJournal({ capacity: 50 });
	for (let i = 0; i < 20; i++) journal.record("lob1", "hp:update", {});
	const { events } = journal.since("lob1", 7);
	assert.equal(events[0].seq, 8);
	events.forEach((e, i) => assert.equal(e.seq, 8 + i));
});

test("replaying from the sequence a caller just received leaves it with nothing to apply", () => {
	const { journal } = makeJournal();
	journal.record("lob1", "hp:update", {});
	const latest = journal.record("lob1", "gold:update", {});
	assert.deepEqual(journal.since("lob1", latest.seq).events, []);
});

test("the journal does not retain a reference a caller can mutate after recording", () => {
	const { journal } = makeJournal();
	const payload = { player: "Ayla", hp: 7 };
	journal.record("lob1", "hp:update", payload);
	payload.hp = 999;
	assert.equal(journal.since("lob1", 0).events[0].payload.hp, 7);
});
