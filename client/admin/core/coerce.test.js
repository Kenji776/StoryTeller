import test from "node:test";
import assert from "node:assert/strict";
import { coerceField, buildRepairPayload, LIST_FIELDS } from "./coerce.js";

/** Builds a `read` function over a plain object of raw field values. */
const reader = (values) => (field) => values[field] ?? "";

test("a numeric-looking value is sent as a number, not a string", () => {
	assert.deepEqual(coerceField("hp", "12"), { present: true, value: 12 });
	assert.deepEqual(coerceField("used", "0"), { present: true, value: 0 });
	assert.deepEqual(coerceField("hp", "-3"), { present: true, value: -3 });
	assert.deepEqual(coerceField("hp", "2.5"), { present: true, value: 2.5 });
});

test("surrounding whitespace does not stop a value being recognised as a number", () => {
	assert.deepEqual(coerceField("hp", "  12  "), { present: true, value: 12 });
});

test("a non-numeric value is sent as trimmed text", () => {
	assert.deepEqual(coerceField("player", "  Mira  "), { present: true, value: "Mira" });
	assert.deepEqual(coerceField("player", "Sir Blade 2"), { present: true, value: "Sir Blade 2" });
});

test("a player name that happens to be digits stays text for a text field", () => {
	// "player" is not a list field and not a number field; a character called "7"
	// must not arrive at the server as the number 7, which would match nothing.
	assert.deepEqual(coerceField("player", "7"), { present: true, value: "7" });
});

test("a blank scalar field is absent, so the server keeps its current value", () => {
	assert.deepEqual(coerceField("hp", ""), { present: false, value: null });
	assert.deepEqual(coerceField("hp", "   "), { present: false, value: null });
});

test("a list field splits on commas and trims each entry", () => {
	assert.deepEqual(coerceField("conditions", "poisoned, prone ,blinded"),
		{ present: true, value: ["poisoned", "prone", "blinded"] });
});

test("a list field drops empty entries left by stray commas", () => {
	assert.deepEqual(coerceField("conditions", "poisoned,,prone,"),
		{ present: true, value: ["poisoned", "prone"] });
});

test("a blank list field is present and empty, which is how conditions get cleared", () => {
	// Regression: the old panel skipped every blank box, so "Replace conditions"
	// could never be given the empty list its own catalogue note describes, and the
	// server refused it with "Conditions must be a list".
	assert.deepEqual(coerceField("conditions", ""), { present: true, value: [] });
	assert.deepEqual(coerceField("conditions", "   "), { present: true, value: [] });
	assert.deepEqual(coerceField("conditions", " , , "), { present: true, value: [] });
});

test("list fields are declared rather than guessed", () => {
	assert.equal(LIST_FIELDS.has("conditions"), true);
	assert.equal(LIST_FIELDS.has("hp"), false);
});

test("coerceField tolerates absent raw input", () => {
	assert.deepEqual(coerceField("hp", undefined), { present: false, value: null });
	assert.deepEqual(coerceField("hp", null), { present: false, value: null });
	assert.deepEqual(coerceField("conditions", undefined), { present: true, value: [] });
});

test("builds a payload from the fields a repair declares", () => {
	const payload = buildRepairPayload(["player", "hp"], reader({ player: "Mira", hp: "18" }));
	assert.deepEqual({ ...payload }, { player: "Mira", hp: 18 });
});

test("a blank scalar is omitted from the payload entirely", () => {
	const payload = buildRepairPayload(["player", "hp"], reader({ player: "Mira", hp: "" }));
	assert.deepEqual({ ...payload }, { player: "Mira" });
	assert.equal("hp" in payload, false);
});

test("a blank list survives into the payload as an empty array", () => {
	const payload = buildRepairPayload(["player", "conditions"], reader({ player: "Mira", conditions: "" }));
	assert.deepEqual({ ...payload }, { player: "Mira", conditions: [] });
});

test("a repair with no fields produces an empty payload", () => {
	assert.deepEqual({ ...buildRepairPayload([], reader({})) }, {});
	assert.deepEqual({ ...buildRepairPayload(null, reader({})) }, {});
	assert.deepEqual({ ...buildRepairPayload(undefined, reader({})) }, {});
});

test("the payload has no prototype, so a catalogue field cannot be swallowed by one", () => {
	// On a plain object, `payload["__proto__"] = v` sets the prototype instead of
	// creating an own key, and the field vanishes from the socket frame silently.
	// The raw values are built on a null prototype for the same reason — in a plain
	// object literal `__proto__` would never become an own key to begin with.
	const values = Object.create(null);
	values.__proto__ = "Mira";
	const payload = buildRepairPayload(["__proto__"], (field) => values[field] ?? "");

	assert.equal(Object.getPrototypeOf(payload), null);
	assert.deepEqual(Object.keys(payload), ["__proto__"]);
	assert.equal(payload.__proto__, "Mira");
});

test("buildRepairPayload rejects a reader it cannot call", () => {
	assert.throws(() => buildRepairPayload(["hp"], null), { name: "TypeError", message: /read/ });
	assert.throws(() => buildRepairPayload(["hp"], "nope"), { name: "TypeError", message: /read/ });
});

test("the payload has no inherited keys, so a field named toString is safe", () => {
	const payload = buildRepairPayload(["player"], reader({ player: "Mira" }));
	assert.deepEqual(Object.keys(payload), ["player"]);
});
