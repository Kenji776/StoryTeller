/**
 * Tests for the seeded random source.
 *
 * @description An arena has to be reproducible from its seed for three separate reasons, and
 *   the first is a project rule: `TDD-8` forbids unseeded randomness in anything tested. The
 *   second is that a lobby reloaded from disk must lay out the same room, or a saved game
 *   rearranges its own furniture. The third is that a bad arena can then be reported,
 *   reproduced and fixed by seed alone.
 *
 *   The project's existing convention is to take `rng` as a parameter — see `loot.js` — so
 *   this produces a function of that shape rather than an object nobody else expects.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createRng, pick, weightedPick, shuffled, seedFrom } from "./random.js";

test("a seed produces the same sequence every time", () => {
	const first = Array.from({ length: 8 }, createRng(1234));
	const second = Array.from({ length: 8 }, createRng(1234));
	assert.deepEqual(first, second);
});

test("different seeds produce different sequences", () => {
	assert.notDeepEqual(
		Array.from({ length: 8 }, createRng(1)),
		Array.from({ length: 8 }, createRng(2)));
});

test("every value sits in the half-open unit interval", () => {
	// The shape `Math.random` promises, so this can be passed anywhere the project already
	// takes an rng — a value of exactly 1 would push an index off the end of an array.
	const rng = createRng(99);
	for (let i = 0; i < 500; i++) {
		const value = rng();
		assert.ok(value >= 0 && value < 1, `${value} is out of range`);
	}
});

test("the sequence does not immediately repeat itself", () => {
	// A weak generator that returns a constant would satisfy every test above.
	const rng = createRng(7);
	const seen = new Set(Array.from({ length: 200 }, rng));
	assert.ok(seen.size > 190, `only ${seen.size} distinct values in 200 draws`);
});

test("a nonsense seed still gives a usable generator", () => {
	// The seed arrives from a stored lobby, so it may be missing or corrupt. Throwing here
	// would take out the encounter rather than the map.
	for (const bad of [undefined, null, NaN, "abc", -1, 1.5, Infinity]) {
		const rng = createRng(bad);
		const value = rng();
		assert.ok(value >= 0 && value < 1, `seed ${String(bad)} produced ${value}`);
	}
});

test("seedFrom turns a string into a stable number", () => {
	assert.equal(seedFrom("crypt"), seedFrom("crypt"));
	assert.notEqual(seedFrom("crypt"), seedFrom("cavern"));
	assert.ok(Number.isInteger(seedFrom("anything")));
});

// ── Choosing things ─────────────────────────────────────────────────────────

test("pick returns a member of the list", () => {
	const rng = createRng(5);
	const options = ["a", "b", "c"];
	for (let i = 0; i < 50; i++) assert.ok(options.includes(pick(rng, options)));
});

test("pick on an empty or malformed list returns nothing rather than throwing", () => {
	const rng = createRng(5);
	assert.equal(pick(rng, []), null);
	assert.equal(pick(rng, null), null);
});

test("pick eventually returns every member", () => {
	// Guards against an off-by-one that can never reach the last element — the classic
	// `Math.floor(rng() * (n - 1))`.
	const rng = createRng(11);
	const seen = new Set(Array.from({ length: 200 }, () => pick(rng, ["a", "b", "c"])));
	assert.equal(seen.size, 3);
});

test("weightedPick favours the heavier option", () => {
	// Not an exact count — that would pin the generator's internals. The assertion is the
	// direction of the bias, which is what the caller depends on.
	const rng = createRng(3);
	const options = [{ kind: "pillar", weight: 9 }, { kind: "rubble", weight: 1 }];
	let pillars = 0;
	for (let i = 0; i < 400; i++) if (weightedPick(rng, options).kind === "pillar") pillars++;
	assert.ok(pillars > 300, `expected the heavy option to dominate, got ${pillars}/400`);
});

test("weightedPick still returns something when every weight is zero or missing", () => {
	// Otherwise a palette somebody forgot to weight would place no scenery at all, and an
	// empty arena looks like a working one.
	const rng = createRng(3);
	assert.ok(weightedPick(rng, [{ kind: "a" }, { kind: "b" }]));
	assert.ok(weightedPick(rng, [{ kind: "a", weight: 0 }]));
	assert.equal(weightedPick(rng, []), null);
});

test("shuffled keeps every element and leaves the original alone", () => {
	const rng = createRng(21);
	const source = [1, 2, 3, 4, 5, 6, 7, 8];
	const result = shuffled(rng, source);
	assert.deepEqual([...result].sort((a, b) => a - b), source);
	assert.deepEqual(source, [1, 2, 3, 4, 5, 6, 7, 8], "the input must not be mutated");
});

test("shuffled actually reorders, and does so the same way for the same seed", () => {
	const source = Array.from({ length: 20 }, (_, i) => i);
	assert.notDeepEqual(shuffled(createRng(21), source), source);
	assert.deepEqual(shuffled(createRng(21), source), shuffled(createRng(21), source));
});
