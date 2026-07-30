/**
 * writeReport.mjs — renders one or more bake-off result files into a markdown report.
 *
 *   node server/test-integration/bakeoff/writeReport.mjs \
 *       --in server/logs/bakeoff-screen-hosted.json,server/logs/bakeoff-screen-local.json \
 *       --out docs/audits/model-bakeoff-screen.md
 *
 * Merging several files is the normal case rather than the exception: the local
 * models are screened in their own run at concurrency 1, because they share one GPU
 * and running them alongside the hosted field measures contention rather than
 * capability. They still belong in one report.
 *
 * @throws {Error} If an input file is missing or is not a bake-off result file.
 */

import fs from "node:fs";
import path from "node:path";
import { renderReport } from "../../services/bakeoff/report.js";

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

const inputs = (arg("in") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const out = arg("out");
if (!inputs.length || !out) {
	console.error("usage: writeReport.mjs --in a.json[,b.json] --out report.md");
	process.exit(1);
}

const merged = { reports: [], actions: null, durationSec: 0, stage: "screen" };
for (const file of inputs) {
	const resolved = path.resolve(file);
	if (!fs.existsSync(resolved)) throw new Error(`no such results file: ${resolved}`);
	const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
	if (!Array.isArray(parsed?.reports)) throw new Error(`${resolved} is not a bake-off result file`);
	merged.reports.push(...parsed.reports);
	merged.durationSec += Number(parsed.durationSec) || 0;
	// Any full run makes the whole document a full-stage document; a screen grade must
	// never be presented under a heading claiming a full game produced it.
	if (parsed.stage === "full") merged.stage = "full";
	if (merged.actions === null) merged.actions = parsed.actions ?? null;
	else if (merged.actions !== parsed.actions) merged.actions = "mixed";
}

const markdown = renderReport(merged);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(path.resolve(out), markdown);
console.log(`${merged.reports.length} model(s) from ${inputs.length} file(s) → ${out}`);
