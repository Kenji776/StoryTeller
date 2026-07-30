/**
 * Unit tests for chooseBestValue — which model becomes the game's default.
 *
 * This decides what narrates every new lobby, so it gets pinned properly. The awkward
 * part is that price is the one input the bake-off cannot measure: it comes from a
 * hand-maintained table, and much of that table is unknown. The rules below are mostly
 * about behaving sensibly when the price is missing rather than guessing at it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseBestValue, blendedPrice } from "./value.js";

/**
 * @description Builds a graded report.
 * @param {string} model - Model id.
 * @param {object} [over] - Fields to override.
 * @returns {object} A report.
 */
const rep = (model, over = {}) => ({
	provider: "openai", model, score: 100, verdict: "recommended",
	latency: { medianMs: 3000 }, turns: 18, blockers: [], ...over,
});

// ── Blended price ────────────────────────────────────────────────────────────

test("a blended price weights output tokens, which a narrator spends most on", () => {
	// The DM writes long passages and reads a moderate prompt, so output dominates cost.
	const cheap = blendedPrice({ input: 0.15, output: 0.6 });
	const dear = blendedPrice({ input: 2.5, output: 10 });
	assert.ok(cheap < dear);
	assert.ok(cheap > 0);
});

test("an unknown price is not treated as free", () => {
	// Returning 0 would make every unpriced model the cheapest thing on offer and win.
	for (const bad of [null, undefined, {}, { input: 1 }, { output: 1 }, 42, { input: "a", output: "b" }]) {
		assert.equal(blendedPrice(bad), null, `input ${JSON.stringify(bad)}`);
	}
});

// ── Choosing ─────────────────────────────────────────────────────────────────

test("the cheapest model that scores perfectly wins", () => {
	const chosen = chooseBestValue(
		[rep("gpt-4o-mini"), rep("gpt-4o", { score: 87 }), rep("expensive-but-perfect")],
		{ "openai/gpt-4o-mini": { input: 0.15, output: 0.6 }, "openai/expensive-but-perfect": { input: 5, output: 20 } },
	);
	assert.equal(chosen.model, "gpt-4o-mini");
});

test("a model that cannot run the game is never chosen, however cheap", () => {
	const chosen = chooseBestValue(
		[rep("free-but-broken", { verdict: "unusable", blockers: ["cannot parse"] }), rep("works-but-costly")],
		{ "openai/free-but-broken": { input: 0.01, output: 0.01 }, "openai/works-but-costly": { input: 5, output: 20 } },
	);
	assert.equal(chosen.model, "works-but-costly");
});

test("an untested or unevaluated model is never chosen as the default", () => {
	const chosen = chooseBestValue(
		[rep("unproven", { verdict: "not evaluated", score: 0 }), rep("proven")],
		{ "openai/proven": { input: 1, output: 4 } },
	);
	assert.equal(chosen.model, "proven");
});

test("with no prices known at all, the fastest working model wins", () => {
	// Latency is the only cost signal left, and a slow narrator is its own kind of expensive.
	const chosen = chooseBestValue([
		rep("slow", { latency: { medianMs: 19000 } }),
		rep("quick", { latency: { medianMs: 2700 } }),
	], {});
	assert.equal(chosen.model, "quick");
});

test("a priced model is preferred over an unpriced one at equal quality", () => {
	// Choosing a model whose cost nobody has established would be a worse default than
	// choosing one we can actually reason about.
	const chosen = chooseBestValue(
		[rep("unpriced", { latency: { medianMs: 1000 } }), rep("priced")],
		{ "openai/priced": { input: 0.15, output: 0.6 } },
	);
	assert.equal(chosen.model, "priced");
});

test("score beats price: a cheap mediocre model does not win", () => {
	const chosen = chooseBestValue(
		[rep("cheap-and-ok", { score: 72, verdict: "usable" }), rep("dearer-and-perfect")],
		{ "openai/cheap-and-ok": { input: 0.01, output: 0.02 }, "openai/dearer-and-perfect": { input: 1, output: 4 } },
	);
	assert.equal(chosen.model, "dearer-and-perfect");
});

test("the winner carries why it won, so a report can explain the default", () => {
	const chosen = chooseBestValue([rep("gpt-4o-mini")], { "openai/gpt-4o-mini": { input: 0.15, output: 0.6 } });
	assert.equal(chosen.key, "openai/gpt-4o-mini");
	assert.equal(typeof chosen.reason, "string");
	assert.ok(chosen.reason.length > 0);
	assert.ok(/score|price|latency|value/i.test(chosen.reason), `unhelpful reason: ${chosen.reason}`);
});

test("a run flagged as a thin sample is not chosen as the default", () => {
	// It may be fine, but the game's default should rest on evidence that has settled.
	const chosen = chooseBestValue(
		[rep("thin", { lowSample: true }), rep("solid", { turns: 80 })],
		{ "openai/thin": { input: 0.01, output: 0.02 }, "openai/solid": { input: 2, output: 8 } },
	);
	assert.equal(chosen.model, "solid");
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("nothing usable on offer yields no choice rather than a bad one", () => {
	assert.equal(chooseBestValue([], {}), null);
	assert.equal(chooseBestValue([rep("broken", { verdict: "unusable", blockers: ["x"] })], {}), null);
});

test("junk input is tolerated", () => {
	for (const bad of [null, undefined, 42, {}, "reports"]) {
		assert.equal(chooseBestValue(bad, {}), null);
	}
	assert.equal(chooseBestValue([rep("fine")], null)?.model, "fine");
});

test("choosing is deterministic and does not mutate its inputs", () => {
	const reports = [rep("a"), rep("b", { score: 99 })];
	const prices = { "openai/a": { input: 1, output: 2 } };
	const before = JSON.stringify({ reports, prices });
	const first = chooseBestValue(reports, prices);
	const second = chooseBestValue(reports, prices);
	assert.deepEqual(first, second);
	assert.equal(JSON.stringify({ reports, prices }), before);
});
