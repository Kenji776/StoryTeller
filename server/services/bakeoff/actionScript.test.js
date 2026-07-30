/**
 * Unit tests for buildActionScript — the identical input every model faces.
 *
 * Comparability is the whole point: if two models are asked different questions,
 * their grades cannot be set side by side. These tests pin determinism and the
 * category tagging the judgement score is computed from.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActionScript, ACTION_CATEGORIES } from "./actionScript.js";

// ── Happy path ───────────────────────────────────────────────────────────────

test("a script of the requested length is produced", () => {
	assert.equal(buildActionScript(80).length, 80);
	assert.equal(buildActionScript(4).length, 4);
});

test("every entry carries text and a category", () => {
	for (const step of buildActionScript(40)) {
		assert.equal(typeof step.text, "string");
		assert.ok(step.text.trim().length > 0);
		assert.ok(Object.values(ACTION_CATEGORIES).includes(step.category), `bad category ${step.category}`);
	}
});

test("both categories appear in a run long enough to hold them", () => {
	const cats = new Set(buildActionScript(40).map((s) => s.category));
	assert.ok(cats.has(ACTION_CATEGORIES.PLAUSIBLE));
	assert.ok(cats.has(ACTION_CATEGORIES.ABSURD));
});

test("absurd actions stay a small minority so the run mostly plays the game", () => {
	const script = buildActionScript(80);
	const absurd = script.filter((s) => s.category === ACTION_CATEGORIES.ABSURD).length;
	assert.ok(absurd >= 4, `too few absurd probes to measure judgement: ${absurd}`);
	assert.ok(absurd <= 16, `too many absurd probes, the game never progresses: ${absurd}`);
});

test("the opening action is plausible, so a run does not begin on a refusal", () => {
	assert.equal(buildActionScript(80)[0].category, ACTION_CATEGORIES.PLAUSIBLE);
});

// ── Determinism ──────────────────────────────────────────────────────────────

test("the same length always yields exactly the same script", () => {
	assert.deepEqual(buildActionScript(80), buildActionScript(80));
});

test("a shorter script is a prefix of a longer one, so a screen matches the full run", () => {
	const long = buildActionScript(80);
	const short = buildActionScript(6);
	assert.deepEqual(short, long.slice(0, 6));
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("zero and negative lengths yield an empty script", () => {
	for (const n of [0, -1, -100]) assert.deepEqual(buildActionScript(n), []);
});

test("a length of one yields exactly one plausible action", () => {
	const script = buildActionScript(1);
	assert.equal(script.length, 1);
	assert.equal(script[0].category, ACTION_CATEGORIES.PLAUSIBLE);
});

test("non-numeric lengths yield an empty script rather than throwing", () => {
	for (const bad of [null, undefined, NaN, "80", {}, []]) {
		assert.deepEqual(buildActionScript(bad), [], `input ${JSON.stringify(bad)}`);
	}
});

test("a fractional length is floored rather than producing holes", () => {
	const script = buildActionScript(5.7);
	assert.equal(script.length, 5);
	assert.ok(script.every((s) => typeof s.text === "string"));
});

// ── Properties ───────────────────────────────────────────────────────────────

test("no absurd action names a spell or ability, which code would refuse before the model saw it", () => {
	// `actionFeasibility.hardChecks` rejects unknown spells and abilities in pure code.
	// An absurd probe that trips those measures the gate's cheap stage, not the model's
	// judgement, and would credit every model equally.
	for (const step of buildActionScript(80).filter((s) => s.category === ACTION_CATEGORIES.ABSURD)) {
		assert.ok(!/\bcast\b/i.test(step.text), `absurd probe would hit a hard check: "${step.text}"`);
	}
});

test("the script does not mutate between calls", () => {
	const a = buildActionScript(10);
	a[0].text = "mutated";
	assert.notEqual(buildActionScript(10)[0].text, "mutated");
});
