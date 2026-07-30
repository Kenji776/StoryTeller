/**
 * bakeoff.mjs — plays a game per model and grades every one of them.
 *
 * Two stages, for the reason set out in ADR 0028: a cheap screen over the whole
 * field, then full games only for the survivors. Both use the same driver against
 * the same server, differing only in `--actions`, so a screen is literally the
 * opening of the same game.
 *
 *   # screen the whole field cheaply
 *   node server/test-integration/bakeoff/bakeoff.mjs --url http://localhost:3099 \
 *       --actions 6 --concurrency 6 --out server/logs/bakeoff-screen.json
 *
 *   # full games, 20 turns per player, for a named shortlist
 *   node server/test-integration/bakeoff/bakeoff.mjs --url http://localhost:3099 \
 *       --actions 80 --concurrency 4 --models claude-opus-5,gpt-5.2 \
 *       --out server/logs/bakeoff-full.json
 *
 * Needs a live server and real keys, and it costs money. Prefer a dev-mode instance
 * on its own port so narration and image spend are off.
 *
 * @throws {Error} If the server is unreachable or no candidate models resolve.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { runGame } from "./runGame.mjs";
import { getProvider } from "../../services/llm/registry.js";
import { selectCandidates } from "../../services/bakeoff/candidates.js";
import { orderRungsNewestFirst } from "../../services/bakeoff/generations.js";
import { collectEvidence } from "../../services/bakeoff/journal.js";
import { scoreRun } from "../../services/bakeoff/scoreRun.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
dotenv.config({ path: path.join(ROOT, "server", ".env") });

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

const URL = arg("url", "http://localhost:3099");
// Converted here, at the CLI boundary, because `buildActionScript` deliberately
// refuses a string rather than coercing one (CQ-6).
const ACTIONS = Number(arg("actions", "6"));
const CONCURRENCY = Number(arg("concurrency", "4"));
const OUT = path.resolve(arg("out", path.join(ROOT, "server", "logs", "bakeoff-results.json")));
const ONLY = arg("models", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const ONLY_PROVIDERS = arg("providers", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
// Walk generations newest to oldest and stop once a whole generation fails, instead of
// paying for every model in the catalogue.
const DESCEND = argv.includes("--descend");
const LOG_DIR = path.join(ROOT, "server", "logs");

/** How many times a model may be re-asked after the provider throttled us. */
const MAX_ATTEMPTS = Number(arg("attempts", "3"));

/** Base backoff between attempts; multiplied by the attempt number. */
const RETRY_BACKOFF_MS = Number(arg("backoff", "45")) * 1000;

/** @description Sleeps. @param {number} ms - Duration. @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which env var holds each provider's key. `CLAUDE_API_KEY` is the legacy name. */
const KEY_VARS = {
	openai: ["OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
	ollama: [],
};

const t0 = Date.now();

/**
 * @description Writes one timestamped progress line.
 * @param {string} msg - The message.
 * @returns {void}
 */
function log(msg) {
	console.log(`[${String(((Date.now() - t0) / 1000).toFixed(0)).padStart(5)}s] ${msg}`);
}

/**
 * Discovers every model worth evaluating, per provider.
 *
 * @description Asks each provider's own `listModels` rather than carrying a
 *   hardcoded list, so the field is whatever this machine can actually reach today.
 *   A provider that cannot be reached is reported and skipped rather than aborting
 *   the run: a dead Ollama daemon should not stop the hosted models being graded.
 * @returns {Promise<Array<{provider: string, model: string}>>} The candidates.
 */
async function discoverCandidates() {
	const all = [];
	const catalogue = [];
	for (const [providerId, keyVars] of Object.entries(KEY_VARS)) {
		if (ONLY_PROVIDERS.length && !ONLY_PROVIDERS.includes(providerId)) continue;
		const provider = getProvider(providerId);
		const apiKey = keyVars.map((v) => process.env[v]).find((v) => v && v.trim()) ?? null;
		if (provider.requiresApiKey && !apiKey) {
			log(`SKIP ${providerId}: no key configured (looked for ${keyVars.join(", ")})`);
			continue;
		}
		try {
			const listed = await provider.listModels({
				config: { providerId, apiKey, model: null, baseUrl: provider.defaultBaseUrl ?? null },
			});
			const ids = listed.map((m) => m.id);
			const { selected, excluded } = selectCandidates(providerId, ids);
			log(`${providerId}: ${selected.length} candidates of ${listed.length} listed (${excluded.length} excluded)`);
			all.push(...selected);
			// Kept before `selectCandidates` strips the dated snapshots: those dates are the
			// only honest evidence of release order, which the descending sweep needs.
			catalogue.push(...ids);
		} catch (err) {
			log(`SKIP ${providerId}: ${err.kind ?? "error"} — ${err.message}`);
		}
	}
	const candidates = ONLY.length ? all.filter((c) => ONLY.includes(c.model)) : all;
	return { candidates, catalogue };
}

/**
 * @description Reports whether a graded report counts as a failure for sweep purposes.
 *   `not evaluated` deliberately does not: the provider refused us, which is not evidence
 *   about the model and must never be allowed to terminate the sweep early.
 * @param {object} report - A graded report.
 * @returns {boolean} True when the model genuinely could not run the game.
 */
const isFailure = (report) => report?.verdict === "unusable";

/**
 * Walks generations newest to oldest, stopping once an entire generation fails.
 *
 * @description The premise is that nothing older than a completely dead generation will
 *   do better, so once every model in one rung fails there is no point paying for the
 *   rest. Everything below is recorded as `assumed failure` — explicitly *not* as a
 *   measured result, because it was never run.
 * @param {Array<{provider: string, model: string}>} candidates - Models to consider.
 * @param {string[]} catalogue - Full provider catalogue, for release dates.
 * @returns {Promise<object[]>} Reports for the rungs actually run, plus placeholder
 *   entries for the rungs skipped by the stopping rule.
 */
async function descendingSweep(candidates, catalogue) {
	const rungs = orderRungsNewestFirst(candidates, catalogue);
	log(`descending sweep over ${rungs.length} generation(s): ${rungs.map((r) => r.rung).join(" > ")}`);

	const reports = [];
	let sawFailure = false;

	for (let i = 0; i < rungs.length; i++) {
		const rung = rungs[i];
		log(`── generation ${rung.rung} (${rung.releasedAt ?? "undated"}): ${rung.models.map((m) => m.model).join(", ")}`);
		const graded = await pool(rung.models, CONCURRENCY, evaluate);
		reports.push(...graded.map((r) => ({ ...r, generation: rung.rung, releasedAt: rung.releasedAt })));

		const judged = graded.filter((r) => r.verdict !== "not evaluated");
		const failures = judged.filter(isFailure);
		if (failures.length) sawFailure = true;

		// Stop only when a whole generation is dead. That is what gives the rule its
		// "test one rung before the failure" behaviour: the first failing model does not
		// end the sweep, it just means the next generation down has to be proven too.
		const wholeRungFailed = judged.length > 0 && failures.length === judged.length;
		if (wholeRungFailed && sawFailure) {
			const skipped = rungs.slice(i + 1);
			const skippedModels = skipped.flatMap((r) => r.models);
			log(`✋ every model in ${rung.rung} failed — assuming the ${skippedModels.length} older model(s) `
				+ `in ${skipped.length} generation(s) would too, and stopping`);
			for (const r of skipped) {
				for (const m of r.models) {
					reports.push({
						provider: m.provider, model: m.model,
						generation: r.rung, releasedAt: r.releasedAt,
						turns: 0, dimensions: {}, score: 0, grade: "—", verdict: "assumed failure",
						blockers: [`not run: every model in the newer ${rung.rung} generation failed, `
							+ `so this older generation was assumed to fail too`],
						latency: { medianMs: null, p90Ms: null },
						run: { endedBy: "not-run" },
					});
				}
			}
			break;
		}
	}
	return reports;
}

/**
 * @description Reads a lobby's call journal, tolerating a partially-written last line.
 * @param {string} lobbyId - The lobby whose journal to read.
 * @returns {object[]} Parsed entries, oldest first.
 */
function readJournal(lobbyId) {
	const file = path.join(LOG_DIR, `llm-${lobbyId}.jsonl`);
	if (!lobbyId || !fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => { try { return JSON.parse(line); } catch { return null; } })
		.filter(Boolean);
}

/**
 * Plays and grades one candidate.
 *
 * @description Any thrown failure is caught and turned into a graded report, because
 *   a model that crashes the harness is a finding about that model and must still
 *   appear in the results rather than taking the batch down with it.
 * @param {{provider: string, model: string}} candidate - What to evaluate.
 * @returns {Promise<object>} The report, with the run record attached as evidence.
 */
async function evaluate(candidate, _index, attempt = 1) {
	const label = `${candidate.provider}/${candidate.model}`;
	const startedAt = Date.now();
	log(`▶ ${label}${attempt > 1 ? ` (retry ${attempt}/${MAX_ATTEMPTS})` : ""}`);
	try {
		const run = await runGame({ url: URL, ...candidate, actions: ACTIONS, log });
		const journal = readJournal(run.lobbyId);
		const evidence = collectEvidence(journal);

		// A run the provider refused says nothing about the model. Back off and ask again
		// rather than recording a verdict we would not stand behind — this is the failure
		// mode a sweep at too much concurrency creates for itself, and grading it would
		// report our own concurrency setting as a property of the model.
		const throttled = evidence.ops.rateLimited > 0 || evidence.ops.providerUnavailable > 0;
		if (evidence.ops.inconclusive && throttled && attempt < MAX_ATTEMPTS) {
			const backoffMs = RETRY_BACKOFF_MS * attempt;
			log(`… ${label} was throttled by the provider — backing off ${backoffMs / 1000}s and retrying`);
			await sleep(backoffMs);
			return evaluate(candidate, _index, attempt + 1);
		}
		if (evidence.ops.inconclusive) {
			log(`? ${label} → INCONCLUSIVE (${evidence.ops.providerErrors} provider error(s), no reply to grade)`);
			return {
				provider: candidate.provider, model: candidate.model,
				turns: 0, dimensions: {}, score: 0, grade: "—", verdict: "not evaluated",
				blockers: [`the provider never let the model answer: `
					+ `${evidence.ops.rateLimited} rate-limited, ${evidence.ops.providerUnavailable} unavailable, `
					+ `${evidence.ops.authFailed} auth — this is not a verdict about the model`],
				latency: { medianMs: null, p90Ms: null },
				run: {
					lobbyId: run.lobbyId, endedBy: run.endedBy, error: run.error,
					calls: evidence.calls, attempts: attempt,
					wallClockSec: Math.round((Date.now() - startedAt) / 1000),
				},
			};
		}

		// A run cut short by a total party kill did what it was asked; charging it for
		// the turns it never reached would mark a model down for running a lethal game.
		const requested = run.endedBy === "tpk" ? run.ops.completed : run.ops.requested;

		const report = scoreRun({
			provider: candidate.provider,
			model: candidate.model,
			inspections: evidence.inspections,
			latencies: evidence.latencies,
			gate: run.gate,
			ops: { ...run.ops, requested, providerErrors: run.ops.providerErrors + evidence.ops.providerErrors },
			// A screen never reaches a fight; scoring combat zero would libel the model.
			expectCombat: ACTIONS >= 24,
		});

		report.run = {
			lobbyId: run.lobbyId, code: run.code, endedBy: run.endedBy, error: run.error,
			actionsRequested: run.ops.requested, actionsCompleted: run.ops.completed,
			stalls: run.ops.stalls, calls: evidence.calls,
			wallClockSec: Math.round((Date.now() - startedAt) / 1000),
		};
		log(`✔ ${label} → ${report.score}/100 ${report.grade} ${report.verdict}`
			+ ` (${report.turns} turns, ${run.endedBy}${report.blockers.length ? `, BLOCKED: ${report.blockers[0]}` : ""})`);
		return report;
	} catch (err) {
		log(`✖ ${label} → harness failure: ${err.message}`);
		return {
			provider: candidate.provider, model: candidate.model,
			turns: 0, dimensions: {}, score: 0, grade: "F", verdict: "unusable",
			blockers: [`the harness could not complete a run: ${err.message}`],
			latency: { medianMs: null, p90Ms: null },
			run: { endedBy: "harness-error", error: err.message },
		};
	}
}

/**
 * @description Runs tasks with a bounded number in flight, preserving input order in
 *   the results. Concurrency is what makes the full field affordable in wall clock:
 *   each model gets its own lobby, so nothing is shared but the server process.
 * @param {Array<*>} items - Work items.
 * @param {number} limit - Maximum in flight.
 * @param {Function} worker - Async function applied to each item.
 * @returns {Promise<Array<*>>} Results, in the order of `items`.
 */
async function pool(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * @description Executes the bake-off end to end.
 * @returns {Promise<void>}
 * @throws {Error} If the server is unreachable or nothing resolves to evaluate.
 */
async function main() {
	const probe = await fetch(URL).catch((err) => { throw new Error(`${URL} is unreachable: ${err.message}`); });
	if (!probe.ok) throw new Error(`${URL} answered ${probe.status}`);

	const { candidates, catalogue } = await discoverCandidates();
	if (!candidates.length) throw new Error("no candidate models resolved — check keys and --models/--providers filters");

	log(`${candidates.length} candidates | ${ACTIONS} actions each | concurrency ${CONCURRENCY} `
		+ `| ${DESCEND ? "descending sweep" : "exhaustive"} | out ${OUT}`);
	const reports = DESCEND
		? await descendingSweep(candidates, catalogue)
		: await pool(candidates, CONCURRENCY, evaluate);

	const ranked = [...reports].sort((a, b) => b.score - a.score);
	fs.writeFileSync(OUT, JSON.stringify({
		startedAt: new Date(t0).toISOString(),
		url: URL, actions: ACTIONS, stage: ACTIONS >= 24 ? "full" : "screen",
		durationSec: Math.round((Date.now() - t0) / 1000),
		reports: ranked,
	}, null, 2));

	log("");
	log("=== RESULTS ===");
	for (const r of ranked) {
		log(`${String(r.score).padStart(3)}/100 ${r.grade} ${r.verdict.padEnd(12)} ${r.provider}/${r.model}`
			+ (r.blockers.length ? `  ← ${r.blockers[0]}` : ""));
	}
	log("");
	log(`written to ${OUT}`);
}

main().then(
	() => process.exit(0),
	(err) => { log(`FATAL: ${err.message}`); process.exit(1); },
);
