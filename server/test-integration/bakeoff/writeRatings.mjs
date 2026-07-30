/**
 * writeRatings.mjs — turns bake-off results into the picker's badges.
 *
 * Reads graded results plus the operator-maintained price table and writes
 * `client/config/model_ratings.json`, which the browser fetches the same way it already
 * fetches `llm_models.json` and `music_moods.json`. Refreshing the badges after a sweep is
 * therefore a data change, not a code change.
 *
 *   node server/test-integration/bakeoff/writeRatings.mjs \
 *       --in server/logs/bakeoff-rescored.json
 *
 * Costs nothing and needs no key or server.
 *
 * @throws {Error} If the results file is missing or is not a bake-off result file.
 */

import fs from "node:fs";
import path from "node:path";
import { chooseBestValue } from "../../services/bakeoff/value.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

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

const IN = path.resolve(arg("in", path.join(ROOT, "server", "logs", "bakeoff-rescored.json")));
const PRICES = path.resolve(arg("prices", path.join(ROOT, "server", "data", "model-prices.json")));
const OUT = path.resolve(arg("out", path.join(ROOT, "client", "config", "model_ratings.json")));

if (!fs.existsSync(IN)) throw new Error(`no such results file: ${IN}`);
const results = JSON.parse(fs.readFileSync(IN, "utf8"));
if (!Array.isArray(results?.reports)) throw new Error(`${IN} is not a bake-off result file`);

const priceDoc = fs.existsSync(PRICES) ? JSON.parse(fs.readFileSync(PRICES, "utf8")) : {};
const prices = priceDoc.prices ?? {};

const winner = chooseBestValue(results.reports, prices);

const models = {};
for (const r of results.reports) {
	if (!r?.provider || !r?.model) continue;
	const key = `${r.provider}/${r.model}`;
	models[key] = {
		verdict: r.verdict,
		score: r.score ?? null,
		medianMs: r.latency?.medianMs ?? null,
		turns: r.turns ?? 0,
		lowSample: r.lowSample === true,
		// The first blocker is the most severe and is already written as a sentence a
		// person can act on, so it doubles as the badge's explanation.
		note: Array.isArray(r.blockers) && r.blockers.length ? r.blockers[0] : "",
	};
}

// The winner's note explains *why* it is the default, which is the one badge a host is
// most likely to want justified.
if (winner && models[winner.key]) models[winner.key].note = winner.reason;

const out = {
	_comment: "GENERATED from bake-off results — do not hand-edit. Regenerate with"
		+ " `node server/test-integration/bakeoff/writeRatings.mjs`. Prices come from"
		+ " server/data/model-prices.json, which IS hand-maintained. Keys are provider/model,"
		+ " because a rating earned through one provider is not evidence about another.",
	generatedOn: new Date().toISOString().slice(0, 10),
	generatedFrom: path.relative(ROOT, IN).replace(/\\/g, "/"),
	pricesVerifiedOn: priceDoc.pricesVerifiedOn ?? null,
	stage: results.stage ?? "screen",
	recommended: winner?.key ?? null,
	recommendedReason: winner?.reason ?? null,
	models,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, "\t")}\n`);

const counts = {};
for (const m of Object.values(models)) counts[m.verdict] = (counts[m.verdict] ?? 0) + 1;
console.log(`${Object.keys(models).length} model(s) rated → ${path.relative(ROOT, OUT)}`);
console.log(`verdicts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`priced: ${Object.keys(prices).length} model(s)${priceDoc.pricesVerifiedOn ? "" : " (prices NOT verified)"}`);
console.log(`default: ${winner ? `${winner.key} — ${winner.reason}` : "none could be chosen"}`);
