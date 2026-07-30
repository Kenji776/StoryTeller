/**
 * Unit tests for createOnceOnly — answer a re-delivered durable event exactly once.
 *
 * `roll:required` is DURABLE in `eventTaxonomy.js`, so the sequenced bus re-delivers
 * it. A handler that answers every delivery submits the same roll over and over: one
 * screen run turned 12 player actions into 191 DM calls that way, which both burns
 * money and inflates the evidence the model is graded on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOnceOnly } from "./onceOnly.js";

// ── Happy path ───────────────────────────────────────────────────────────────

test("the first delivery is answered and the identical redelivery is not", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("roll", { seq: 7 }), true);
	assert.equal(once.claim("roll", { seq: 7 }), false);
	assert.equal(once.claim("roll", { seq: 7 }), false);
});

test("a genuinely new event with a later sequence is answered", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("roll", { seq: 1 }), true);
	assert.equal(once.claim("roll", { seq: 2 }), true);
});

test("different event names do not shadow each other", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("roll", { seq: 1 }), true);
	assert.equal(once.claim("rest", { seq: 1 }), true);
});

// ── No sequence number ───────────────────────────────────────────────────────

test("without a sequence number, an identical payload is still deduplicated", () => {
	const once = createOnceOnly();
	const payload = { player: "Dorn", sides: 20, dc: 10 };
	assert.equal(once.claim("roll", undefined, payload), true);
	assert.equal(once.claim("roll", undefined, payload), false);
});

test("without a sequence number, a different payload is answered", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("roll", null, { player: "Dorn", sides: 20, dc: 10 }), true);
	assert.equal(once.claim("roll", null, { player: "Dorn", sides: 20, dc: 15 }), true);
});

test("key order in the payload does not make the same request look new", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("roll", null, { player: "Dorn", dc: 10 }), true);
	assert.equal(once.claim("roll", null, { dc: 10, player: "Dorn" }), false,
		"the bus may reserialise a payload; only its content identifies it");
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("sequence zero is a real sequence, not a missing one", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("roll", { seq: 0 }), true);
	assert.equal(once.claim("roll", { seq: 0 }), false);
});

test("an unserialisable payload is allowed through rather than silently swallowed", () => {
	const once = createOnceOnly();
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(once.claim("roll", null, cyclic), true);
	assert.equal(once.claim("roll", null, cyclic), true,
		"failing open is right here: dropping a real roll request deadlocks the table");
});

test("a missing event name is tolerated", () => {
	const once = createOnceOnly();
	assert.equal(once.claim(undefined, { seq: 1 }), true);
	assert.equal(once.claim(undefined, { seq: 1 }), false);
});

test("no payload and no meta still dedupes on the event name alone", () => {
	const once = createOnceOnly();
	assert.equal(once.claim("narration:start"), true);
	assert.equal(once.claim("narration:start"), false);
});

// ── Memory ───────────────────────────────────────────────────────────────────

test("the ledger is bounded, so a long game cannot grow it without limit", () => {
	const once = createOnceOnly({ limit: 4 });
	for (let seq = 0; seq < 20; seq++) once.claim("roll", { seq });
	assert.equal(once.size() <= 4, true, `ledger grew to ${once.size()}`);
});

test("evicting old entries never re-answers the most recent ones", () => {
	const once = createOnceOnly({ limit: 3 });
	for (let seq = 0; seq < 10; seq++) once.claim("roll", { seq });
	// The newest are what a redelivery would repeat, and they must still be blocked.
	assert.equal(once.claim("roll", { seq: 9 }), false);
	assert.equal(once.claim("roll", { seq: 8 }), false);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("two instances keep independent ledgers, so one player cannot mask another", () => {
	const a = createOnceOnly();
	const b = createOnceOnly();
	assert.equal(a.claim("roll", { seq: 1 }), true);
	assert.equal(b.claim("roll", { seq: 1 }), true);
});

test("claim is the only thing that mutates state", () => {
	const once = createOnceOnly();
	once.claim("roll", { seq: 1 });
	const before = once.size();
	once.size();
	assert.equal(once.size(), before);
});
