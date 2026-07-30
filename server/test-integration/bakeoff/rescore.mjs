/**
 * rescore.mjs — grades every game already on disk, without spending anything.
 *
 * The gateway journals every call it makes, and the whole scoring layer is pure. So a run
 * that has already happened can be re-graded at any time under a corrected rubric — and
 * that is worth a great deal, because the rubric was corrected four times while it was
 * being built and because provider quota is finite.
 *
 * It also recovers runs whose orchestrator was interrupted. A killed sweep never writes
 * its results file, but its journals are all there.
 *
 *   node server/test-integration/bakeoff/rescore.mjs --out server/logs/rescored.json
 *
 * Costs nothing and needs no key or server.
 *
 * @throws {Error} If the log directory cannot be read.
 */

import fs from "node:fs";
import path from "node:path";
import { collectEvidence, reconstructGate, CALL_KINDS } from "../../services/bakeoff/journal.js";
import { scoreRun } from "../../services/bakeoff/scoreRun.js";
import { rungKeyOf } from "../../services/bakeoff/generations.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const LOG_DIR = path.join(ROOT, "server", "logs");

const argv = process.argv.slice(2);
/**
 * @description Reads a named CLI argument.
 * @param {string} name - Flag name without dashes.
 * @param {string} [fallback] - Value when absent.
 * @returns {string|undefined} The value.
 */
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(arg("out", path.join(LOG_DIR, "bakeoff-rescored.json")));
/** Journals with fewer graded replies than this are abandoned setups, not games. */
const MIN_TURNS = Number(arg("min-turns", "5"));

/**
 * @description Reads one journal, tolerating a partially-written final line.
 * @param {string} file - Absolute path.
 * @returns {object[]} Parsed entries.
 */
function readJournal(file) {
	return fs.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => { try { return JSON.parse(line); } catch { return null; } })
		.filter(Boolean);
}

const files = fs.readdirSync(LOG_DIR).filter((f) => /^llm-.*\.jsonl$/.test(f));
console.log(`${files.length} journal(s) in ${LOG_DIR}`);

/** Best report per model: a model may have been run several times. */
const best = new Map();
let skipped = 0;

for (const file of files) {
	const lobbyId = /^llm-(.*)\.jsonl$/.exec(file)[1];
	const entries = readJournal(path.join(LOG_DIR, file));
	const evidence = collectEvidence(entries);
	if (!evidence.model || evidence.inspections.length < MIN_TURNS) { skipped++; continue; }

	const gate = reconstructGate(entries);
	const turns = evidence.inspections.length;
	const report = scoreRun({
		provider: evidence.provider,
		model: evidence.model,
		inspections: evidence.inspections,
		latencies: evidence.latencies,
		gate,
		// Completion cannot be recovered from a journal — it was a socket-level fact — so it
		// is reported as "every reply that happened, happened" and the reliability dimension
		// only reflects the provider errors the journal does record. Overstating what a
		// journal can prove would be worse than admitting the gap.
		ops: { requested: turns, completed: turns, stalls: 0, providerErrors: evidence.ops.providerErrors },
		expectCombat: turns >= 24,
	});
	report.generation = rungKeyOf(evidence.model);
	report.run = {
		lobbyId,
		endedBy: "rescored-from-journal",
		calls: evidence.calls,
		gateReconstructed: true,
		providerFaults: {
			rateLimited: evidence.ops.rateLimited,
			unavailable: evidence.ops.providerUnavailable,
			auth: evidence.ops.authFailed,
		},
		// The roll-storm bug re-submitted one roll many times before it was fixed. Those
		// extra replies are real model output, but they oversample a single prompt, so a
		// journal with far more DM turns than a 12-action screen should have is flagged
		// rather than quietly averaged.
		oversampled: evidence.calls[CALL_KINDS.DM_TURN] > 40 && turns > 40,
	};

	const existing = best.get(report.model);
	// Prefer the longest run for a model: more replies is a better estimate, and it is
	// also the run least likely to have died to a provider fault.
	if (!existing || report.turns > existing.turns) best.set(report.model, report);
}

const reports = [...best.values()].sort((a, b) => b.score - a.score);
fs.writeFileSync(OUT, JSON.stringify({
	stage: "screen",
	source: "rescored from call journals",
	actions: "mixed",
	reports,
}, null, 2));

console.log(`${reports.length} model(s) recovered, ${skipped} journal(s) skipped (fewer than ${MIN_TURNS} graded replies)`);
for (const r of reports) {
	console.log(`${String(r.score).padStart(3)}/100 ${r.grade} ${String(r.verdict).padEnd(14)} `
		+ `${r.provider}/${r.model} (${r.turns} replies${r.lowSample ? ", thin sample" : ""}`
		+ `${r.run.oversampled ? ", oversampled" : ""})`
		+ (r.blockers.length ? `\n      ← ${r.blockers[0]}` : ""));
}
console.log(`\nwritten to ${OUT}`);
