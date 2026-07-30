/**
 * scoreRun — evidence from one game becomes a grade and a verdict.
 *
 * Two separate judgements come out of here, and conflating them is what makes
 * most model comparisons useless:
 *
 *   - **grade** is mechanical: the weighted dimension scores, banded A–F. It
 *     answers "how good was the output".
 *   - **verdict** is operational: could you actually run a table on this. It
 *     answers a different question and is allowed to be harsher than the grade,
 *     because two facts are fatal in ways an average hides — a blocker (the game
 *     loop breaks) and a low clean-parse rate (every turn silently costs a second
 *     model call for repair, so the table is twice the price and half the speed).
 *
 * A model can therefore grade B and still be `marginal`. That is the honest
 * answer, and collapsing it into one number would recommend models nobody should
 * pay for.
 *
 * Pure and synchronous, so the whole rubric is unit-testable without a network.
 */

import { REQUIRED_KEYS } from "./dmReply.js";
import { analyseCombat } from "./combatTrace.js";

/** Dimension weights, out of 100. Renormalised over whatever is applicable. */
export const WEIGHTS = {
	jsonDiscipline: 30,
	schemaConformance: 20,
	combatLifecycle: 20,
	stateEvents: 10,
	judgement: 10,
	narrationHygiene: 5,
	reliability: 5,
};

/**
 * How much each combat violation costs, relative to one combat turn.
 *
 * `unresolved` is discounted heavily because a run truncated by its own turn
 * budget produces it innocently; the other three are always the model's fault.
 */
const COMBAT_SEVERITY = { prematureEnd: 1, oneTurnWipe: 1, rosterDrop: 1, missingVerdict: 0.5, unresolved: 0.25 };

/**
 * What one wrongly-refused plausible action costs, in units of missed absurdities.
 *
 * `actionFeasibility.js` states the asymmetry directly: a false rejection tells a
 * new player their reasonable idea is impossible, and three of those end their
 * turn. Letting one absurd action through merely produces a silly beat.
 */
const FALSE_REJECT_WEIGHT = 3;

/** Score floors for each letter. */
const GRADE_BANDS = [[90, "A"], [80, "B"], [70, "C"], [60, "D"], [0, "F"]];

/** Verdicts, worst to best, so a cap can be applied by index. */
const VERDICTS = ["unusable", "marginal", "usable", "recommended"];

/** Score floors for each verdict, before caps. */
const VERDICT_BANDS = [[85, "recommended"], [70, "usable"], [55, "marginal"], [0, "unusable"]];

/** Below this share of first-try parses, no model is better than `usable`. */
const REPAIR_CAP_USABLE = 0.5;

/** Below this share, no model is better than `marginal`. */
const REPAIR_CAP_MARGINAL = 0.25;

/** A model failing more than this share of parses cannot run the loop at all. */
const MIN_PARSE_RATE = 0.95;

/** Below this mean schema conformance the appliers get too little to work with. */
const MIN_SCHEMA_RATE = 0.5;

/** Below this share of requested turns actually played, the run did not happen. */
const MIN_COMPLETION_RATE = 0.8;

/**
 * @description Reports whether a value is a plain, non-array object.
 * @param {*} v - Any value.
 * @returns {boolean} True for `{}`-shaped values only.
 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @description Clamps a ratio into the unit interval, mapping anything non-finite to 0.
 * @param {number} n - The candidate value.
 * @returns {number} A number in [0, 1].
 */
function unit(n) {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

/**
 * @description Reads a percentile out of an unsorted sample without disturbing it.
 * @param {number[]} values - The sample.
 * @param {number} p - The percentile, 0–1.
 * @returns {number|null} The value at that percentile, or null for an empty sample.
 */
function percentile(values, p) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index];
}

/**
 * @description Builds one dimension entry.
 * @param {string} key - The dimension name, used to look up its weight.
 * @param {number} score - Its unit score.
 * @param {string} detail - Human-readable evidence for the report.
 * @param {boolean} [applicable=true] - False when this run could not measure it.
 * @returns {object} The dimension.
 */
function dimension(key, score, detail, applicable = true) {
	return { score: applicable ? unit(score) : 0, weight: WEIGHTS[key], detail, applicable };
}

/**
 * @description Formats a ratio as a whole-number percentage for report copy.
 * @param {number} n - A unit ratio.
 * @returns {string} e.g. "87%".
 */
const pct = (n) => `${Math.round(unit(n) * 100)}%`;

/**
 * @description Builds the report returned when evidence is unusable as input.
 * @param {string} reason - Why nothing could be scored.
 * @param {object} [identity] - Provider and model, when known.
 * @returns {object} A zeroed report carrying the blocker.
 */
function refuse(reason, identity = {}) {
	return {
		provider: identity.provider ?? null,
		model: identity.model ?? null,
		turns: 0,
		dimensions: Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, dimension(k, 0, "not measured", false)])),
		score: 0,
		grade: "F",
		verdict: "unusable",
		blockers: [reason],
		latency: { medianMs: null, p90Ms: null },
	};
}

/**
 * Grades one model's run.
 *
 * @description Scores each dimension over the turns that could carry it,
 *   renormalises the weights across whatever was measurable, then applies the
 *   blockers and caps that a weighted average cannot express.
 * @param {object} evidence - The run record.
 * @param {string} evidence.provider - Provider id.
 * @param {string} evidence.model - Model id.
 * @param {object[]} evidence.inspections - Per-turn output of `inspectDMReply`, in play order.
 * @param {number[]} evidence.latencies - Per-turn DM call duration in milliseconds.
 * @param {object} [evidence.gate] - Feasibility-gate tallies: `badSubmitted`,
 *   `badRejected`, `plausibleSubmitted`, `plausibleRejected`.
 * @param {object} [evidence.ops] - Operational tallies: `requested`, `completed`,
 *   `stalls`, `providerErrors`.
 * @param {boolean} [evidence.expectCombat=true] - False for a screen that never
 *   reaches a fight, which excludes the combat dimension instead of scoring it zero.
 * @returns {object} The graded report: dimensions, score out of 100, letter grade,
 *   operational verdict, blockers, and latency percentiles. Never throws.
 */
export function scoreRun(evidence) {
	if (!isPlainObject(evidence)) return refuse("evidence was not an object, so nothing could be scored");

	const identity = { provider: evidence.provider ?? null, model: evidence.model ?? null };
	const inspections = Array.isArray(evidence.inspections) ? evidence.inspections.filter(isPlainObject) : [];
	const turns = inspections.length;
	if (turns === 0) return refuse("no turns were played", identity);

	const latencies = (Array.isArray(evidence.latencies) ? evidence.latencies : []).filter(Number.isFinite);
	const gate = isPlainObject(evidence.gate) ? evidence.gate : {};
	const ops = isPlainObject(evidence.ops) ? evidence.ops : {};
	const expectCombat = evidence.expectCombat !== false;

	const parsedTurns = inspections.filter((i) => i.parsed);
	const parseRate = parsedTurns.length / turns;
	const cleanRate = inspections.filter((i) => i.cleanParse).length / turns;

	// ── Dimensions ──
	const dimensions = {};

	dimensions.jsonDiscipline = dimension("jsonDiscipline", 0.6 * parseRate + 0.4 * cleanRate,
		`${pct(parseRate)} parsed, ${pct(cleanRate)} on the first try without repair`);

	// Conformance is only meaningful where there was an object to inspect. A reply
	// that never parsed is already fully charged to jsonDiscipline; counting it here
	// too would double-charge one failure.
	const schemaScores = parsedTurns.map((i) =>
		unit(1 - ((i.missingKeys?.length ?? 0) + (i.typeErrors?.length ?? 0)) / REQUIRED_KEYS.length));
	const schemaRate = schemaScores.length ? schemaScores.reduce((a, b) => a + b, 0) / schemaScores.length : 0;
	const keyFaults = new Set();
	for (const i of parsedTurns) {
		for (const k of i.missingKeys ?? []) keyFaults.add(`${k} missing`);
		for (const k of i.typeErrors ?? []) keyFaults.add(`${k} mistyped`);
	}
	dimensions.schemaConformance = dimension("schemaConformance", schemaRate,
		keyFaults.size ? [...keyFaults].sort().join(", ") : "every required key present and well typed");

	const trace = analyseCombat(inspections);
	if (!expectCombat) {
		dimensions.combatLifecycle = dimension("combatLifecycle", 0, "not exercised by this run", false);
	} else if (trace.combatTurns === 0) {
		dimensions.combatLifecycle = dimension("combatLifecycle", 0,
			"never ran an encounter across the whole game");
	} else {
		const penalty = Object.entries(trace.counts)
			.reduce((sum, [kind, n]) => sum + n * (COMBAT_SEVERITY[kind] ?? 1), 0) / trace.combatTurns;
		const faults = Object.entries(trace.counts).filter(([, n]) => n > 0)
			.map(([kind, n]) => `${kind}×${n}`);
		dimensions.combatLifecycle = dimension("combatLifecycle", 1 - penalty,
			`${trace.encounters} encounter(s) over ${trace.combatTurns} combat turn(s); `
			+ (faults.length ? faults.join(", ") : "no violations"));
	}

	const malformed = parsedTurns.filter((i) => (i.malformedEvents?.length ?? 0) > 0);
	const malformedKinds = new Set(malformed.flatMap((i) => i.malformedEvents ?? []));
	dimensions.stateEvents = dimension("stateEvents",
		parsedTurns.length ? 1 - malformed.length / parsedTurns.length : 0,
		malformedKinds.size
			? `malformed on ${malformed.length}/${parsedTurns.length} turn(s): ${[...malformedKinds].sort().join(", ")}`
			: "every state event carried the fields the appliers read");

	const badSubmitted = Number(gate.badSubmitted) || 0;
	if (badSubmitted === 0) {
		dimensions.judgement = dimension("judgement", 0, "no implausible actions were submitted to judge", false);
	} else {
		const recall = (Number(gate.badRejected) || 0) / badSubmitted;
		const plausibleSubmitted = Number(gate.plausibleSubmitted) || 0;
		const falseRate = plausibleSubmitted ? (Number(gate.plausibleRejected) || 0) / plausibleSubmitted : 0;
		dimensions.judgement = dimension("judgement", recall - FALSE_REJECT_WEIGHT * falseRate,
			`refused ${pct(recall)} of absurd actions; wrongly refused ${pct(falseRate)} of plausible ones`);
	}

	const leaky = parsedTurns.filter((i) => i.jsonInText || i.markdownInText);
	dimensions.narrationHygiene = dimension("narrationHygiene",
		parsedTurns.length ? 1 - leaky.length / parsedTurns.length : 0,
		leaky.length ? `markup or raw JSON leaked into the narration on ${leaky.length}/${parsedTurns.length} turn(s)`
			: "narration stayed free of markdown and JSON");

	const requested = Number(ops.requested) || 0;
	const completed = Number(ops.completed) || 0;
	const completionRate = requested > 0 ? completed / requested : 1;
	const stalls = Number(ops.stalls) || 0;
	const providerErrors = Number(ops.providerErrors) || 0;
	const opsBase = Math.max(requested, turns, 1);
	dimensions.reliability = dimension("reliability",
		completionRate - 0.5 * (stalls / opsBase) - 0.5 * (providerErrors / opsBase),
		`${completed}/${requested || turns} turns completed, ${stalls} stall(s), ${providerErrors} provider error(s)`);

	// ── Weighted score over whatever was measurable ──
	const applicable = Object.values(dimensions).filter((d) => d.applicable);
	const availableWeight = applicable.reduce((a, d) => a + d.weight, 0);
	const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
	const earned = applicable.reduce((a, d) => a + d.score * d.weight, 0);
	const score = availableWeight > 0 ? Math.round((earned / availableWeight) * 100) : 0;

	// Renormalise so a report always shows weights adding to the declared total,
	// rather than leaving a reader to work out why the columns do not sum.
	if (availableWeight > 0 && availableWeight !== totalWeight) {
		for (const d of applicable) d.weight = (d.weight / availableWeight) * totalWeight;
	}

	// ── Blockers: the things a weighted average must not be allowed to absorb ──
	const blockers = [];
	if (parseRate < MIN_PARSE_RATE) {
		blockers.push(`only ${pct(parseRate)} of replies could be parsed as JSON — the game loop cannot run on this`);
	}
	if (schemaRate < MIN_SCHEMA_RATE) {
		blockers.push(`mean schema conformance ${pct(schemaRate)} — the response schema is not being followed`);
	}
	if (completionRate < MIN_COMPLETION_RATE) {
		blockers.push(`completed only ${completed} of ${requested} requested turns`);
	}

	const grade = GRADE_BANDS.find(([floor]) => score >= floor)[1];
	let verdict = blockers.length
		? "unusable"
		: VERDICT_BANDS.find(([floor]) => score >= floor)[1];

	// A model that is always repaired is affordable only on paper.
	if (!blockers.length) {
		const cap = cleanRate < REPAIR_CAP_MARGINAL ? "marginal" : cleanRate < REPAIR_CAP_USABLE ? "usable" : null;
		if (cap && VERDICTS.indexOf(verdict) > VERDICTS.indexOf(cap)) verdict = cap;
	}

	return {
		...identity,
		turns,
		dimensions,
		score,
		grade,
		verdict,
		blockers,
		latency: { medianMs: percentile(latencies, 0.5), p90Ms: percentile(latencies, 0.9) },
	};
}
