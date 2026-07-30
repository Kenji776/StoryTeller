/**
 * Unit tests for renderReport — graded runs become the document an operator reads.
 *
 * The property that matters is that nothing is silently dropped: a model that was
 * evaluated must appear, and a screen-only grade must be labelled as one so it is
 * never quoted as though a full game produced it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, groupByVerdict } from "./report.js";

/**
 * @description Builds a graded report entry.
 * @param {object} over - Fields to override.
 * @returns {object} A report shaped like `scoreRun`'s output.
 */
const report = (over = {}) => ({
	provider: "openai", model: "gpt-4o", turns: 12, score: 90, grade: "A",
	verdict: "recommended", blockers: [],
	latency: { medianMs: 2000, p90Ms: 4000 },
	dimensions: {
		jsonDiscipline: { score: 1, weight: 30, detail: "100% parsed", applicable: true },
		combatLifecycle: { score: 0, weight: 20, detail: "not exercised", applicable: false },
	},
	run: { lobbyId: "abc123", endedBy: "budget", actionsCompleted: 12, wallClockSec: 40, calls: { repair: 0 } },
	...over,
});

// ── Grouping ─────────────────────────────────────────────────────────────────

test("models are grouped by verdict, best tier first", () => {
	const groups = groupByVerdict([
		report({ verdict: "unusable", model: "a" }),
		report({ verdict: "recommended", model: "b" }),
		report({ verdict: "marginal", model: "c" }),
		report({ verdict: "usable", model: "d" }),
	]);
	assert.deepEqual(Object.keys(groups), ["recommended", "usable", "marginal", "unusable", "not evaluated"]);
	assert.deepEqual(groups.recommended.map((r) => r.model), ["b"]);
	assert.deepEqual(groups.unusable.map((r) => r.model), ["a"]);
});

test("every input appears in exactly one group", () => {
	const inputs = ["recommended", "usable", "marginal", "unusable", "recommended"].map((v, i) => report({ verdict: v, model: `m${i}` }));
	const groups = groupByVerdict(inputs);
	const total = Object.values(groups).reduce((a, g) => a + g.length, 0);
	assert.equal(total, inputs.length);
});

test("an unrecognised verdict is bucketed as unusable rather than vanishing", () => {
	const groups = groupByVerdict([report({ verdict: "excellent", model: "weird" })]);
	assert.deepEqual(groups.unusable.map((r) => r.model), ["weird"]);
});

test("a model the provider never let us ask is kept apart from one that failed", () => {
	// Collapsing these would report our own rate limit as the model's incompetence.
	const groups = groupByVerdict([
		report({ verdict: "not evaluated", model: "throttled" }),
		report({ verdict: "unusable", model: "genuinely-bad" }),
	]);
	assert.deepEqual(groups["not evaluated"].map((r) => r.model), ["throttled"]);
	assert.deepEqual(groups.unusable.map((r) => r.model), ["genuinely-bad"]);
});

test("the not-evaluated tier renders with its reason and is not called a failure", () => {
	const md = renderReport({
		stage: "screen",
		reports: [report({
			verdict: "not evaluated", grade: "—", score: 0, turns: 0,
			blockers: ["the provider never let the model answer: 4 rate-limited"],
		})],
	});
	assert.ok(md.includes("the provider never let the model answer: 4 rate-limited"));
	assert.match(md, /not evaluated/);
});

test("within a tier, models are ordered by score descending", () => {
	const groups = groupByVerdict([
		report({ verdict: "usable", model: "low", score: 71 }),
		report({ verdict: "usable", model: "high", score: 84 }),
	]);
	assert.deepEqual(groups.usable.map((r) => r.model), ["high", "low"]);
});

// ── Rendering ────────────────────────────────────────────────────────────────

test("the document names every model that was evaluated", () => {
	const md = renderReport({ stage: "screen", reports: [report({ model: "gpt-4o" }), report({ model: "claude-opus-5", provider: "anthropic" })] });
	assert.ok(md.includes("gpt-4o"));
	assert.ok(md.includes("claude-opus-5"));
});

test("the document carries a generated banner, so nobody hand-edits it", () => {
	const md = renderReport({ stage: "screen", reports: [report()] });
	assert.match(md, /GENERATED — DO NOT EDIT/, "DOC-8 requires generated output to say so");
});

test("a screen-only result is labelled as a screen", () => {
	const md = renderReport({ stage: "screen", reports: [report()] });
	assert.match(md, /screen/i);
});

test("a blocker is quoted rather than summarised away", () => {
	const md = renderReport({
		stage: "full",
		reports: [report({ verdict: "unusable", score: 20, blockers: ["only 40% of replies could be parsed as JSON"] })],
	});
	assert.ok(md.includes("only 40% of replies could be parsed as JSON"));
});

test("the lobby id is carried through, so a grade can be traced to its transcript", () => {
	const md = renderReport({ stage: "full", reports: [report({ run: { lobbyId: "trace-me", endedBy: "budget" } })] });
	assert.ok(md.includes("trace-me"));
});

test("a dimension marked inapplicable is not printed as a zero", () => {
	const md = renderReport({ stage: "screen", reports: [report()] });
	assert.ok(!/combatLifecycle\D+0\.00/.test(md), "an unexercised dimension must not read as a failure");
});

test("an empty result set produces a document that says so rather than a broken table", () => {
	const md = renderReport({ stage: "screen", reports: [] });
	assert.ok(md.length > 0);
	assert.match(md, /no models/i);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("malformed input yields a document instead of an exception", () => {
	for (const bad of [null, undefined, 42, "results", [], {}]) {
		const md = renderReport(bad);
		assert.equal(typeof md, "string", `input ${JSON.stringify(bad)}`);
		assert.ok(md.length > 0);
	}
});

test("entries missing their dimensions or run block still render", () => {
	const md = renderReport({ stage: "full", reports: [{ provider: "p", model: "m", score: 0, grade: "F", verdict: "unusable", blockers: [] }] });
	assert.ok(md.includes("m"));
});

test("grouping tolerates non-array input", () => {
	for (const bad of [null, undefined, 42, {}]) {
		const groups = groupByVerdict(bad);
		assert.equal(Object.values(groups).reduce((a, g) => a + g.length, 0), 0);
	}
});

// ── Properties ───────────────────────────────────────────────────────────────

test("rendering is deterministic and does not mutate its input", () => {
	const results = { stage: "full", reports: [report({ model: "b" }), report({ model: "a", score: 95 })] };
	const before = JSON.stringify(results);
	assert.equal(renderReport(results), renderReport(results));
	assert.equal(JSON.stringify(results), before);
});
