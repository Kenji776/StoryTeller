import test from "node:test";
import assert from "node:assert/strict";

import { rollExpression } from "./dice.js";

/**
 * @description A random source that returns the given values in order, then repeats
 *   the last one. Injected so every case below is deterministic per `TDD-8`.
 * @param {...number} values - Values in [0, 1) to hand out in sequence.
 * @returns {Function} An `rng` suitable for `rollExpression`.
 */
function sequence(...values) {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

/** An rng that always rolls the maximum face. */
const maxRoll = () => 0.999999;
/** An rng that always rolls a 1. */
const minRoll = () => 0;

// ── Reading an expression ────────────────────────────────────────────────────

test("a dice expression rolls each die and adds the modifier", () => {
	// 2d4+2 with both dice showing 3 → 3 + 3 + 2.
	const result = rollExpression("2d4+2", sequence(0.5, 0.5));

	assert.equal(result.total, 8);
	assert.deepEqual(result.rolls, [3, 3]);
	assert.equal(result.modifier, 2);
});

test("a negative modifier subtracts", () => {
	assert.equal(rollExpression("1d6-2", maxRoll).total, 4);
});

test("a count of one may be written or left out", () => {
	assert.equal(rollExpression("1d8", maxRoll).total, 8);
	assert.equal(rollExpression("d8", maxRoll).total, 8);
});

test("whitespace and case in the expression are ignored", () => {
	assert.equal(rollExpression(" 2 D 4 + 2 ", maxRoll).total, 10);
});

test("a bare number is a fixed result with no dice", () => {
	const result = rollExpression("5", maxRoll);

	assert.equal(result.total, 5);
	assert.deepEqual(result.rolls, []);
	assert.equal(result.modifier, 5);
});

// ── Bounds ───────────────────────────────────────────────────────────────────

test("rolls span the full face range and never leave it", () => {
	assert.deepEqual(rollExpression("1d6", minRoll).rolls, [1]);
	assert.deepEqual(rollExpression("1d6", maxRoll).rolls, [6]);

	// Every value the rng can produce must land on a real face.
	for (let i = 0; i <= 100; i++) {
		const [face] = rollExpression("1d6", () => i / 100.0001).rolls;
		assert.ok(face >= 1 && face <= 6, `rng ${i / 100} produced face ${face}`);
	}
});

test("a total is never negative, because healing for less than nothing is a wound", () => {
	assert.equal(rollExpression("1d4-10", minRoll).total, 0);
});

// ── Refusing nonsense ────────────────────────────────────────────────────────

test("an unreadable expression returns null rather than guessing", () => {
	for (const expr of ["", "   ", "banana", "2d", "d", "2d0", "0d6", "1d-4", null, undefined, 42, {}]) {
		assert.equal(rollExpression(expr, maxRoll), null, `${JSON.stringify(expr)} should not parse`);
	}
});

test("an absurd dice count is refused rather than rolled", () => {
	// A model that writes "9999d6" should not be able to spend the event loop.
	assert.equal(rollExpression("9999d6", maxRoll), null);
});

test("the roller defaults to a real random source when none is injected", () => {
	const result = rollExpression("1d6");

	assert.ok(result.total >= 1 && result.total <= 6);
});
