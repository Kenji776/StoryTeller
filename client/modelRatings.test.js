/**
 * Unit tests for model ratings — turning bake-off results into picker badges.
 *
 * The picker is where a host chooses what narrates their game, so a wrong badge is
 * worse than no badge: it either steers someone onto a model that cannot close a JSON
 * brace, or warns them off one that works. These pin the mapping.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRatings, rateModel, annotateModels, pickRecommended, FLAGS } from "./modelRatings.js";

/**
 * @description Builds a ratings document.
 * @param {object} [over] - Fields to override.
 * @returns {object} A ratings document as the JSON file carries it.
 */
const doc = (over = {}) => ({
	generatedOn: "2026-07-30",
	recommended: "openai/gpt-4o-mini",
	models: {
		"openai/gpt-4o-mini": { verdict: "recommended", score: 100, medianMs: 2900, turns: 18 },
		"openai/gpt-4o": { verdict: "recommended", score: 87, medianMs: 2700, turns: 99 },
		"anthropic/claude-opus-5": { verdict: "unusable", score: 98, medianMs: 17100, turns: 16, lowSample: true, note: "dropped the JSON envelope on 1 of 16 turns" },
		"ollama/qwen2.5vl:7b": { verdict: "unusable", score: 87, medianMs: 8100, turns: 13, note: "omits combat_over and updates every turn" },
		"openai/gpt-3.5-turbo": { verdict: "unusable", score: 20, medianMs: 900, turns: 40 },
		"anthropic/claude-opus-4-7": { verdict: "not evaluated", score: 0, medianMs: null, turns: 5 },
	},
	...over,
});

// ── Parsing ──────────────────────────────────────────────────────────────────

test("a well-formed document parses and keeps its models", () => {
	const r = parseRatings(doc());
	assert.equal(r.recommended, "openai/gpt-4o-mini");
	assert.equal(r.generatedOn, "2026-07-30");
	assert.ok(Object.keys(r.models).length >= 6);
});

test("a malformed document degrades to empty rather than throwing", () => {
	// A config file can be hand-edited, and a bad one should cost the badges, not the picker.
	for (const bad of [null, undefined, 42, "ratings", [], {}, { models: 7 }]) {
		const r = parseRatings(bad);
		assert.deepEqual(r.models, {});
		assert.equal(r.recommended, null);
	}
});

test("individual malformed entries are dropped, the rest survive", () => {
	const r = parseRatings({
		models: {
			"openai/good": { verdict: "recommended", score: 100 },
			"openai/bad": "not an object",
			"openai/alsobad": { verdict: 42 },
		},
	});
	assert.ok(r.models["openai/good"]);
	assert.ok(!r.models["openai/bad"]);
	assert.ok(!r.models["openai/alsobad"]);
});

// ── Flag mapping ─────────────────────────────────────────────────────────────

test("a working model is flagged as working", () => {
	const r = parseRatings(doc());
	assert.equal(rateModel(r, "openai", "gpt-4o").flag, FLAGS.WORKS);
});

test("the best-value model is flagged recommended, not merely working", () => {
	const r = parseRatings(doc());
	assert.equal(rateModel(r, "openai", "gpt-4o-mini").flag, FLAGS.RECOMMENDED);
});

test("a model proven not to run the game is flagged avoid", () => {
	const r = parseRatings(doc());
	assert.equal(rateModel(r, "ollama", "qwen2.5vl:7b").flag, FLAGS.AVOID);
	assert.equal(rateModel(r, "openai", "gpt-3.5-turbo").flag, FLAGS.AVOID);
});

test("an unusable verdict from a thin sample is a caution, not a condemnation", () => {
	// claude-opus-5 failed on 1 of 16 turns. The defect is real and the frequency is not
	// established, and the audit says so — telling a host the flagship "does not work"
	// would overclaim what 16 turns can show.
	const r = parseRatings(doc());
	const rating = rateModel(r, "anthropic", "claude-opus-5");
	assert.equal(rating.flag, FLAGS.CAUTION);
	assert.match(rating.note, /1 of 16/);
});

test("a model the provider never let us test is untested, not broken", () => {
	const r = parseRatings(doc());
	assert.equal(rateModel(r, "anthropic", "claude-opus-4-7").flag, FLAGS.UNTESTED);
});

test("a model with no entry at all is untested", () => {
	const r = parseRatings(doc());
	assert.equal(rateModel(r, "openai", "some-future-model").flag, FLAGS.UNTESTED);
	assert.equal(rateModel(r, "google", "gemini-3").flag, FLAGS.UNTESTED);
});

test("rating lookups tolerate junk", () => {
	const r = parseRatings(doc());
	for (const [p, m] of [[null, null], [undefined, "x"], [42, {}], ["openai", ""]]) {
		assert.equal(rateModel(r, p, m).flag, FLAGS.UNTESTED);
	}
	assert.equal(rateModel(null, "openai", "gpt-4o").flag, FLAGS.UNTESTED);
});

test("every rating carries a label and a note a person can read", () => {
	const r = parseRatings(doc());
	for (const id of ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo", "unknown-model"]) {
		const rating = rateModel(r, "openai", id);
		assert.equal(typeof rating.label, "string");
		assert.ok(rating.label.length > 0, `${id} has no label`);
		assert.equal(typeof rating.note, "string");
	}
});

// ── Annotating a picker list ─────────────────────────────────────────────────

test("annotating adds a rating to every model and keeps the originals intact", () => {
	const r = parseRatings(doc());
	const models = [{ id: "gpt-4o-mini", label: "GPT-4o Mini" }, { id: "gpt-3.5-turbo", label: "GPT-3.5" }];
	const out = annotateModels(r, "openai", models);
	assert.equal(out.length, 2);
	assert.equal(out[0].label, "GPT-4o Mini", "the original label must survive");
	assert.equal(out[0].rating.flag, FLAGS.RECOMMENDED);
	assert.equal(out[1].rating.flag, FLAGS.AVOID);
});

test("annotating does not mutate the list it was given", () => {
	const r = parseRatings(doc());
	const models = [{ id: "gpt-4o-mini", label: "GPT-4o Mini" }];
	const before = JSON.stringify(models);
	annotateModels(r, "openai", models);
	assert.equal(JSON.stringify(models), before);
});

test("annotating tolerates a missing or malformed list", () => {
	const r = parseRatings(doc());
	for (const bad of [null, undefined, 42, {}, "models"]) {
		assert.deepEqual(annotateModels(r, "openai", bad), []);
	}
});

test("working models sort above unknown ones, and avoid sinks to the bottom", () => {
	// A host scanning a long dropdown should meet the good ones first.
	const r = parseRatings(doc());
	const models = [
		{ id: "gpt-3.5-turbo" }, { id: "some-future-model" }, { id: "gpt-4o" }, { id: "gpt-4o-mini" },
	];
	const out = annotateModels(r, "openai", models, { sort: true });
	assert.deepEqual(out.map((m) => m.id), ["gpt-4o-mini", "gpt-4o", "some-future-model", "gpt-3.5-turbo"]);
});

test("without the sort option the caller's order is preserved", () => {
	const r = parseRatings(doc());
	const models = [{ id: "gpt-3.5-turbo" }, { id: "gpt-4o-mini" }];
	assert.deepEqual(annotateModels(r, "openai", models).map((m) => m.id), ["gpt-3.5-turbo", "gpt-4o-mini"]);
});

// ── Choosing the default ─────────────────────────────────────────────────────

test("the recommended model is chosen as the default when it is on offer", () => {
	const r = parseRatings(doc());
	const models = [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-3.5-turbo" }];
	assert.equal(pickRecommended(r, "openai", models), "gpt-4o-mini");
});

test("when the recommended model is not on offer, the best working one is chosen", () => {
	const r = parseRatings(doc());
	const models = [{ id: "gpt-3.5-turbo" }, { id: "gpt-4o" }];
	assert.equal(pickRecommended(r, "openai", models), "gpt-4o", "never default to a model known to fail");
});

test("a provider with nothing rated falls back to its first model", () => {
	const r = parseRatings(doc());
	assert.equal(pickRecommended(r, "google", [{ id: "gemini-3" }, { id: "gemini-2" }]), "gemini-3");
});

test("an empty list yields no default rather than undefined behaviour", () => {
	const r = parseRatings(doc());
	assert.equal(pickRecommended(r, "openai", []), null);
	assert.equal(pickRecommended(r, "openai", null), null);
});

test("the recommended model of another provider is never chosen", () => {
	const r = parseRatings(doc());
	// gpt-4o-mini is the global pick, but this is the Anthropic dropdown.
	const chosen = pickRecommended(r, "anthropic", [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }]);
	assert.notEqual(chosen, "gpt-4o-mini");
});

// ── Properties ───────────────────────────────────────────────────────────────

test("every flag the mapping can emit is a declared flag", () => {
	const r = parseRatings(doc());
	const declared = new Set(Object.values(FLAGS));
	for (const key of Object.keys(doc().models)) {
		const [provider, model] = key.split("/");
		assert.ok(declared.has(rateModel(r, provider, model).flag), `undeclared flag for ${key}`);
	}
});

test("rating is deterministic", () => {
	const r = parseRatings(doc());
	assert.deepEqual(rateModel(r, "openai", "gpt-4o-mini"), rateModel(r, "openai", "gpt-4o-mini"));
});
