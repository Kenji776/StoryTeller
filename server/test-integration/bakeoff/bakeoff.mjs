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
			const { selected, excluded } = selectCandidates(providerId, listed.map((m) => m.id));
			log(`${providerId}: ${selected.length} candidates of ${listed.length} listed (${excluded.length} excluded)`);
			all.push(...selected);
		} catch (err) {
			log(`SKIP ${providerId}: ${err.kind ?? "error"} — ${err.message}`);
		}
	}
	return ONLY.length ? all.filter((c) => ONLY.includes(c.model)) : all;
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

	const candidates = await discoverCandidates();
	if (!candidates.length) throw new Error("no candidate models resolved — check keys and --models/--providers filters");

	log(`${candidates.length} candidates | ${ACTIONS} actions each | concurrency ${CONCURRENCY} | out ${OUT}`);
	const reports = await pool(candidates, CONCURRENCY, evaluate);

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
