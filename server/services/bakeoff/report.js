/**
 * report — graded runs become the document an operator reads.
 *
 * One rule governs everything here: **nothing is silently dropped.** A model that
 * was evaluated appears, a blocker is quoted rather than paraphrased, an
 * inapplicable dimension is printed as `n/a` rather than as a zero, and the lobby
 * id travels with every grade so any number can be traced back to the raw replies
 * that earned it. A report that loses the evidence is an opinion.
 *
 * Pure and synchronous.
 */

/** Verdict tiers, best first. */
export const TIERS = ["recommended", "usable", "marginal", "unusable"];

/** What each tier means operationally, printed once as the report's key. */
const TIER_MEANING = {
	recommended: "run a table on it",
	usable: "playable, with rough edges",
	marginal: "works, but costs or misbehaves enough to hurt",
	unusable: "cannot run the game loop",
};

/** Dimension print order, so every model's block reads the same way. */
const DIMENSION_ORDER = [
	"jsonDiscipline", "schemaConformance", "combatLifecycle",
	"stateEvents", "judgement", "narrationHygiene", "reliability",
];

/**
 * @description Reports whether a value is a plain, non-array object.
 * @param {*} v - Any value.
 * @returns {boolean} True for `{}`-shaped values only.
 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Buckets graded reports by verdict.
 *
 * @description An unrecognised verdict falls into `unusable` rather than vanishing:
 *   a report that quietly omits a model is worse than one that mis-tiers it, because
 *   only the second is visible.
 * @param {object[]} reports - Graded reports from `scoreRun`.
 * @returns {Object<string, object[]>} Tiers in fixed order, each sorted by score
 *   descending. Never throws.
 */
export function groupByVerdict(reports) {
	const groups = Object.fromEntries(TIERS.map((t) => [t, []]));
	if (!Array.isArray(reports)) return groups;
	for (const r of reports) {
		if (!isPlainObject(r)) continue;
		const tier = TIERS.includes(r.verdict) ? r.verdict : "unusable";
		groups[tier].push(r);
	}
	for (const tier of TIERS) {
		groups[tier].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
	}
	return groups;
}

/**
 * @description Formats milliseconds as seconds for a table cell.
 * @param {*} ms - A duration, possibly null.
 * @returns {string} e.g. "2.6s", or "—".
 */
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "—");

/**
 * @description Renders one model's dimension breakdown as a list.
 * @param {object} report - A graded report.
 * @returns {string[]} Markdown lines.
 */
function dimensionLines(report) {
	const dims = isPlainObject(report.dimensions) ? report.dimensions : {};
	const keys = DIMENSION_ORDER.filter((k) => dims[k]);
	if (!keys.length) return ["  - _no dimension detail recorded_"];
	return keys.map((k) => {
		const d = dims[k];
		// An unexercised dimension is printed as n/a: rendering it as 0.00 would read as
		// a failure the run never actually tested for.
		const score = d.applicable === false ? "n/a" : Number(d.score ?? 0).toFixed(2);
		return `  - \`${k}\` **${score}** — ${d.detail ?? ""}`.trimEnd();
	});
}

/**
 * Renders the whole bake-off as a markdown document.
 *
 * @description Labels which stage produced the grades, because a screen grade is a
 *   floor rather than a measurement — it cannot see context decay, history
 *   summarisation or long-run combat drift — and quoting one as though a full game
 *   produced it would overstate what was proven.
 * @param {object} results - A results file: `{stage, reports, actions, durationSec}`.
 * @returns {string} The document. Always a non-empty string, whatever it is given.
 */
export function renderReport(results) {
	const safe = isPlainObject(results) ? results : {};
	const reports = Array.isArray(safe.reports) ? safe.reports.filter(isPlainObject) : [];
	const stage = safe.stage === "full" ? "full" : "screen";
	const stageNote = stage === "full"
		? `Full games — ${safe.actions ?? "?"} player actions each, so every dimension including combat was exercised.`
		: `**Screen only** — ${safe.actions ?? "?"} player actions each. A screen grade is a floor, not a `
			+ `measurement: it cannot see context decay, history summarisation, or long-run combat drift.`;

	const out = [];
	out.push(`# Model bake-off — ${stage} stage`, "");
	out.push(stageNote, "");

	if (!reports.length) {
		out.push("**No models were evaluated.** Check provider keys and any `--models` / `--providers` filter.", "");
		return out.join("\n");
	}

	out.push(`${reports.length} model(s) evaluated`
		+ (Number.isFinite(safe.durationSec) ? ` in ${Math.round(safe.durationSec / 60)} minutes.` : "."), "");

	const groups = groupByVerdict(reports);

	out.push("## Summary", "");
	out.push("| Verdict | Meaning | Models |", "|---|---|---|");
	for (const tier of TIERS) {
		out.push(`| **${tier}** | ${TIER_MEANING[tier]} | ${groups[tier].length} |`);
	}
	out.push("");

	out.push("| # | Model | Score | Grade | Verdict | Turns | Median | p90 |", "|---|---|---|---|---|---|---|---|");
	reports
		.slice()
		.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
		.forEach((r, i) => {
			out.push(`| ${i + 1} | \`${r.provider}/${r.model}\` | ${r.score ?? 0} | ${r.grade ?? "F"} `
				+ `| ${r.verdict ?? "unusable"} | ${r.turns ?? 0} | ${secs(r.latency?.medianMs)} | ${secs(r.latency?.p90Ms)} |`);
		});
	out.push("");

	for (const tier of TIERS) {
		if (!groups[tier].length) continue;
		out.push(`## ${tier} — ${TIER_MEANING[tier]}`, "");
		for (const r of groups[tier]) {
			out.push(`### \`${r.provider}/${r.model}\` — ${r.score ?? 0}/100 (${r.grade ?? "F"})`, "");
			const run = isPlainObject(r.run) ? r.run : {};
			const facts = [
				`${r.turns ?? 0} graded replies`,
				run.endedBy ? `ended by \`${run.endedBy}\`` : null,
				Number.isFinite(run.wallClockSec) ? `${run.wallClockSec}s wall clock` : null,
				Number.isFinite(run.calls?.repair) ? `${run.calls.repair} JSON repair call(s)` : null,
				run.lobbyId ? `transcript \`server/logs/llm-${run.lobbyId}.jsonl\`` : null,
			].filter(Boolean);
			out.push(facts.join(" · "), "");
			if (Array.isArray(r.blockers) && r.blockers.length) {
				out.push("**Blockers:**", "");
				for (const b of r.blockers) out.push(`  - ${b}`);
				out.push("");
			}
			out.push(...dimensionLines(r), "");
		}
	}

	return out.join("\n");
}
