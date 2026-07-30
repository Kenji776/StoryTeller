/**
 * Unit tests for scoreRun — evidence from one game becomes a grade and a verdict.
 *
 * The assertions that matter most are the blockers: a model can score well on
 * prose and still be unusable, and the rubric has to say so rather than averaging
 * a fatal flaw away.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRun, WEIGHTS } from "./scoreRun.js";

/**
 * @description Builds one flawless per-turn inspection.
 * @param {object} [over] - Fields to override.
 * @returns {object} An inspection shaped like `inspectDMReply`'s output.
 */
const perfect = (over = {}) => ({
	parsed: true, cleanParse: true, missingKeys: [], typeErrors: [], malformedEvents: [],
	jsonInText: false, markdownInText: false, activeEnemies: 0, combatOver: true,
	events: { xp: 0, hp: 0, inventory: 0, gold: 0, conditions: 0, abilities: 0, enemies: 0 },
	...over,
});

/**
 * @description Builds a full evidence bundle for a model that did everything right,
 *   including a clean multi-round fight.
 * @param {object} [over] - Top-level overrides.
 * @returns {object} The evidence bundle.
 */
function perfectEvidence(over = {}) {
	const fight = [
		perfect({ activeEnemies: 3, combatOver: false, events: { enemies: 3 } }),
		perfect({ activeEnemies: 1, combatOver: false, events: { enemies: 3 } }),
		perfect({ activeEnemies: 0, combatOver: true, events: { enemies: 3 } }),
	];
	return {
		provider: "openai", model: "test-model",
		inspections: [perfect(), ...fight, perfect()],
		latencies: [1000, 1000, 1000, 1000, 1000],
		gate: { badSubmitted: 3, badRejected: 3, plausibleSubmitted: 10, plausibleRejected: 0 },
		ops: { requested: 5, completed: 5, stalls: 0, providerErrors: 0 },
		...over,
	};
}

// ── Happy path ───────────────────────────────────────────────────────────────

test("a flawless run scores near the ceiling and is recommended", () => {
	const r = scoreRun(perfectEvidence());
	assert.equal(r.blockers.length, 0);
	assert.ok(r.score >= 98, `expected >= 98, got ${r.score}`);
	assert.equal(r.grade, "A");
	assert.equal(r.verdict, "recommended");
});

test("the report carries the identity and turn count it was given", () => {
	const r = scoreRun(perfectEvidence());
	assert.equal(r.provider, "openai");
	assert.equal(r.model, "test-model");
	assert.equal(r.turns, 5);
});

test("latency is reported as median and p90", () => {
	const r = scoreRun(perfectEvidence({ latencies: [100, 200, 300, 400, 5000] }));
	assert.equal(r.latency.medianMs, 300);
	assert.equal(r.latency.p90Ms, 5000);
});

// ── Blockers override the average ────────────────────────────────────────────

test("a model that cannot produce parseable JSON is unusable regardless of the rest", () => {
	const inspections = Array.from({ length: 10 }, (_, i) =>
		perfect({ parsed: i < 5, cleanParse: i < 5 }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(10).fill(500) }));
	assert.equal(r.verdict, "unusable");
	assert.ok(r.blockers.some((b) => /pars/i.test(b)), `got ${JSON.stringify(r.blockers)}`);
});

test("a model that ignores the schema is unusable even when its JSON parses", () => {
	const inspections = Array.from({ length: 10 }, () =>
		perfect({ missingKeys: ["combat_over", "sfx", "suggestions", "roll", "music"] }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(10).fill(500) }));
	assert.equal(r.verdict, "unusable");
	assert.ok(r.blockers.some((b) => /schema/i.test(b)));
});

test("a model that could not finish the requested turns is unusable", () => {
	// Plenty of replies to judge on, a large shortfall, and only a handful of provider
	// errors to explain it — so the model owns the rest. Stated with enough graded replies
	// that the "provider truncated this" rule cannot also apply, or the case is ambiguous.
	const inspections = Array.from({ length: 20 }, () => perfect());
	const r = scoreRun(perfectEvidence({
		inspections, latencies: Array(20).fill(500),
		ops: { requested: 80, completed: 12, stalls: 4, providerErrors: 6 },
	}));
	assert.equal(r.verdict, "unusable");
	assert.ok(r.blockers.some((b) => /complet/i.test(b)), `got ${JSON.stringify(r.blockers)}`);
});

test("a shortfall fully explained by provider errors is not charged to the model", () => {
	// This is what an account hitting its usage cap mid-run looks like: the turns did not
	// happen because the provider stopped answering, not because the model is incapable.
	const r = scoreRun(perfectEvidence({ ops: { requested: 12, completed: 3, stalls: 0, providerErrors: 9 } }));
	assert.ok(!r.blockers.some((b) => /complet/i.test(b)),
		`the model must not be blamed for the provider's refusal: ${JSON.stringify(r.blockers)}`);
});

test("a run cut short by the provider with too little left to judge is not evaluated", () => {
	// claude-sonnet-4-6 was graded "67% parsed" from 3 replies after Anthropic's cap hit,
	// while a longer journal for the same model scored 99. Three replies is not a verdict.
	const inspections = [
		{ parsed: true, cleanParse: true, missingKeys: [], typeErrors: [], malformedEvents: [], jsonInText: false, markdownInText: false, activeEnemies: 0, combatOver: true, events: {} },
		{ parsed: false, cleanParse: false, missingKeys: [], typeErrors: [], malformedEvents: [], jsonInText: false, markdownInText: false, activeEnemies: 0, combatOver: null, events: {} },
		{ parsed: true, cleanParse: true, missingKeys: [], typeErrors: [], malformedEvents: [], jsonInText: false, markdownInText: false, activeEnemies: 0, combatOver: true, events: {} },
	];
	const r = scoreRun(perfectEvidence({
		inspections, latencies: [500, 500, 500],
		ops: { requested: 12, completed: 3, stalls: 0, providerErrors: 9 },
	}));
	assert.equal(r.verdict, "not evaluated");
	assert.ok(r.blockers.some((b) => /provider/i.test(b)));
});

test("a short but clean run with no provider trouble is still judged normally", () => {
	const r = scoreRun(perfectEvidence());
	assert.equal(r.verdict, "recommended");
});

test("a rate-driven blocker on a short run is marked as a thin sample", () => {
	// claude-opus-5 dropped the JSON envelope on 1 of 16 screen turns. That is a real
	// defect and worth blocking on, but "94%" from 16 samples is not a rate anyone should
	// quote — one event flips the verdict. The report has to admit that.
	const inspections = Array.from({ length: 16 }, (_, i) => perfect({ parsed: i !== 0, cleanParse: i !== 0 }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(16).fill(500), ops: { requested: 16, completed: 16, stalls: 0, providerErrors: 0 } }));
	assert.equal(r.verdict, "unusable");
	assert.equal(r.lowSample, true);
	assert.ok(r.blockers.some((b) => /1 of 16|thin|small sample/i.test(b)),
		`the blocker should own its sample size: ${JSON.stringify(r.blockers)}`);
});

test("a long run with the same failure rate is not marked as a thin sample", () => {
	const inspections = Array.from({ length: 80 }, (_, i) => perfect({ parsed: i % 16 !== 0, cleanParse: i % 16 !== 0 }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(80).fill(500), ops: { requested: 80, completed: 80, stalls: 0, providerErrors: 0 } }));
	assert.equal(r.verdict, "unusable");
	assert.equal(r.lowSample, false);
});

test("a clean short run is not flagged, because there is no rate to doubt", () => {
	const r = scoreRun(perfectEvidence());
	assert.equal(r.lowSample, false);
	assert.deepEqual(r.blockers, []);
});

test("a blocked model still reports its dimension scores, so the failure is diagnosable", () => {
	const inspections = Array.from({ length: 10 }, () => perfect({ parsed: false, cleanParse: false }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(10).fill(500) }));
	assert.equal(r.dimensions.jsonDiscipline.score, 0);
	assert.ok(Number.isFinite(r.score));
});

// ── Dimensions ───────────────────────────────────────────────────────────────

test("needing repair on every turn costs json discipline without blocking", () => {
	const inspections = Array.from({ length: 10 }, () => perfect({ parsed: true, cleanParse: false }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(10).fill(500) }));
	assert.equal(r.blockers.length, 0, "it parses, so it is not fatal");
	assert.ok(r.dimensions.jsonDiscipline.score < 0.8);
	assert.ok(r.score < 95);
});

test("premature combat ends are charged to the combat dimension", () => {
	const inspections = [
		perfect({ activeEnemies: 3, combatOver: false, events: { enemies: 3 } }),
		perfect({ activeEnemies: 3, combatOver: true, events: { enemies: 3 } }),
	];
	const r = scoreRun(perfectEvidence({ inspections, latencies: [500, 500], ops: { requested: 2, completed: 2, stalls: 0, providerErrors: 0 } }));
	assert.ok(r.dimensions.combatLifecycle.score < 1);
	assert.ok(r.dimensions.combatLifecycle.detail.includes("prematureEnd"));
});

test("never starting a fight scores zero on combat rather than being ignored", () => {
	const inspections = Array.from({ length: 10 }, () => perfect());
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(10).fill(500) }));
	assert.equal(r.dimensions.combatLifecycle.score, 0);
	assert.ok(/never/i.test(r.dimensions.combatLifecycle.detail));
});

test("combat is excluded from the weighting when the run did not ask for it", () => {
	const inspections = Array.from({ length: 3 }, () => perfect());
	const r = scoreRun(perfectEvidence({
		inspections, latencies: [500, 500, 500],
		ops: { requested: 3, completed: 3, stalls: 0, providerErrors: 0 },
		expectCombat: false,
	}));
	assert.equal(r.dimensions.combatLifecycle.applicable, false);
	assert.ok(r.score >= 98, `a screen with no combat should not be punished, got ${r.score}`);
});

test("false rejections of plausible actions are penalised harder than misses", () => {
	const missed = scoreRun(perfectEvidence({
		gate: { badSubmitted: 4, badRejected: 2, plausibleSubmitted: 10, plausibleRejected: 0 },
	}));
	const overzealous = scoreRun(perfectEvidence({
		gate: { badSubmitted: 4, badRejected: 4, plausibleSubmitted: 10, plausibleRejected: 2 },
	}));
	assert.ok(overzealous.dimensions.judgement.score < missed.dimensions.judgement.score,
		`refusing real actions must cost more: ${overzealous.dimensions.judgement.score} vs ${missed.dimensions.judgement.score}`);
});

test("judgement is not measured when the server's feasibility gate is not enforcing", () => {
	// FEASIBILITY_MODE defaults to "observe", where the gate logs "would reject" and
	// lets everything through. Scoring that as a model failing its judgement would be
	// a configuration artifact reported as a model property — and it would read
	// identically for every model, which is how it was noticed.
	const r = scoreRun(perfectEvidence({
		gate: { enforcing: false, badSubmitted: 2, badRejected: 0, plausibleSubmitted: 10, plausibleRejected: 0 },
	}));
	assert.equal(r.dimensions.judgement.applicable, false);
	assert.match(r.dimensions.judgement.detail, /not enforc/i);
	assert.ok(r.score >= 98, `an unmeasurable dimension must not be charged: got ${r.score}`);
});

test("a permissive model is still charged when the gate demonstrably was enforcing", () => {
	// The gate proved it enforces by refusing the hard-check probe, so allowing every
	// absurd action afterwards is the model's own doing.
	const r = scoreRun(perfectEvidence({
		gate: { enforcing: true, badSubmitted: 2, badRejected: 0, plausibleSubmitted: 10, plausibleRejected: 0, hardChecks: 1 },
	}));
	assert.equal(r.dimensions.judgement.applicable, true);
	assert.equal(r.dimensions.judgement.score, 0);
});

test("an absent enforcing flag is treated as enforcing, so older runs still score", () => {
	const r = scoreRun(perfectEvidence({
		gate: { badSubmitted: 2, badRejected: 2, plausibleSubmitted: 10, plausibleRejected: 0 },
	}));
	assert.equal(r.dimensions.judgement.applicable, true);
});

test("leaked markdown or JSON in the narration costs narration hygiene", () => {
	const inspections = Array.from({ length: 4 }, () => perfect({ markdownInText: true }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(4).fill(500), ops: { requested: 4, completed: 4, stalls: 0, providerErrors: 0 } }));
	assert.equal(r.dimensions.narrationHygiene.score, 0);
});

test("malformed state events cost the state dimension", () => {
	const inspections = Array.from({ length: 4 }, () => perfect({ malformedEvents: ["hp"] }));
	const r = scoreRun(perfectEvidence({ inspections, latencies: Array(4).fill(500), ops: { requested: 4, completed: 4, stalls: 0, providerErrors: 0 } }));
	assert.equal(r.dimensions.stateEvents.score, 0);
	assert.ok(r.dimensions.stateEvents.detail.includes("hp"));
});

// ── Grade bands ──────────────────────────────────────────────────────────────

test("scores and grades decline monotonically as replies get worse", () => {
	const reports = [1, 0.9, 0.75, 0.6, 0.45, 0.2].map((cleanFraction) => {
		const inspections = Array.from({ length: 20 }, (_, i) => perfect({
			cleanParse: i / 20 < cleanFraction,
			markdownInText: i / 20 >= cleanFraction,
			activeEnemies: i === 1 ? 2 : 0,
			combatOver: i !== 1,
			events: { enemies: i === 1 || i === 2 ? 2 : 0 },
		}));
		return scoreRun(perfectEvidence({ inspections, latencies: Array(20).fill(500), ops: { requested: 20, completed: 20, stalls: 0, providerErrors: 0 } }));
	});

	const scores = reports.map((r) => r.score);
	const grades = reports.map((r) => r.grade);
	assert.equal(grades[0], "A");
	// Later letters are worse, so a declining run must never move earlier in the alphabet.
	assert.ok(grades.at(-1) > grades[0], `the worst run must not grade as well as the best: ${grades.join(",")}`);
	assert.ok(new Set(grades).size > 1, `the rubric must discriminate, got ${grades.join(",")}`);
	for (let i = 1; i < scores.length; i++) {
		assert.ok(scores[i] <= scores[i - 1], `score rose from ${scores[i - 1]} to ${scores[i]} as replies got worse`);
	}
});

test("a model repaired on most turns is capped below recommended however well it grades", () => {
	const inspections = Array.from({ length: 20 }, (_, i) => perfect({ cleanParse: i < 4 }));
	const r = scoreRun(perfectEvidence({
		inspections, latencies: Array(20).fill(500),
		ops: { requested: 20, completed: 20, stalls: 0, providerErrors: 0 },
		expectCombat: false,
	}));
	assert.equal(r.blockers.length, 0, "it parses every turn, so nothing is fatal");
	assert.equal(r.verdict, "marginal", `a 20%-clean model must not be recommended (grade was ${r.grade})`);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("a run with no turns at all is unusable rather than a divide by zero", () => {
	const r = scoreRun({ provider: "ollama", model: "x", inspections: [], latencies: [], gate: {}, ops: {} });
	assert.equal(r.verdict, "unusable");
	assert.ok(Number.isFinite(r.score));
	assert.equal(r.turns, 0);
	assert.ok(r.blockers.length > 0);
});

test("missing gate and ops sections do not throw", () => {
	const r = scoreRun({ provider: "p", model: "m", inspections: [perfect()], latencies: [10] });
	assert.ok(Number.isFinite(r.score));
});

test("null and non-object evidence is refused with a blocker, not an exception", () => {
	for (const bad of [null, undefined, 42, "evidence", []]) {
		const r = scoreRun(bad);
		assert.equal(r.verdict, "unusable", `input ${JSON.stringify(bad)}`);
		assert.ok(r.blockers.length > 0);
	}
});

// ── Properties ───────────────────────────────────────────────────────────────

test("the score is always a percentage", () => {
	for (const ev of [perfectEvidence(), { inspections: [], latencies: [] }, perfectEvidence({ gate: {} })]) {
		const r = scoreRun(ev);
		assert.ok(r.score >= 0 && r.score <= 100, `got ${r.score}`);
	}
});

test("applicable weights always sum to the declared total", () => {
	const r = scoreRun(perfectEvidence());
	const applicable = Object.values(r.dimensions).filter((d) => d.applicable);
	const total = applicable.reduce((a, d) => a + d.weight, 0);
	assert.equal(total, Object.values(WEIGHTS).reduce((a, b) => a + b, 0));
});

test("scoring is deterministic and does not mutate its evidence", () => {
	const ev = perfectEvidence();
	const before = JSON.stringify(ev);
	const a = scoreRun(ev);
	const b = scoreRun(ev);
	assert.deepEqual(a, b);
	assert.equal(JSON.stringify(ev), before);
});
