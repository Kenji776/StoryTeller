import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseModelCatalogue, modelsFor, ratedModelsFor, describeModel } from "./models.js";
import { listProviders } from "../../../server/services/llm/registry.js";

/** A well-formed catalogue. */
const catalogue = () => ({
	providers: [
		{ id: "openai", label: "OpenAI", models: [{ id: "gpt-4o", label: "GPT-4o" }] },
		{ id: "claude", label: "Claude", models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }] },
	],
});

test("a well-formed catalogue parses to its providers", () => {
	const parsed = parseModelCatalogue(catalogue());
	assert.deepEqual(parsed.map((p) => p.id), ["openai", "claude"]);
	assert.deepEqual(parsed[0].models, [{ id: "gpt-4o", label: "GPT-4o" }]);
});

test("a provider with no label falls back to its id", () => {
	const [provider] = parseModelCatalogue({ providers: [{ id: "ollama", models: [{ id: "llama3" }] }] });
	assert.equal(provider.label, "ollama");
	assert.equal(provider.models[0].label, "llama3");
});

test("a malformed model is dropped, not the whole provider", () => {
	const [provider] = parseModelCatalogue({
		providers: [{ id: "openai", models: [{ id: "gpt-4o" }, { label: "no id" }, null, "nope"] }],
	});
	assert.deepEqual(provider.models.map((m) => m.id), ["gpt-4o"]);
});

test("a provider with no usable models is dropped", () => {
	// Offering a provider you cannot pick a model for is a dead end.
	const parsed = parseModelCatalogue({
		providers: [{ id: "openai", models: [{ id: "gpt-4o" }] }, { id: "broken", models: [] }],
	});
	assert.deepEqual(parsed.map((p) => p.id), ["openai"]);
});

test("a provider with no id is dropped", () => {
	const parsed = parseModelCatalogue({ providers: [{ label: "Nameless", models: [{ id: "x" }] }] });
	assert.deepEqual(parsed, []);
});

test("a catalogue that is not a catalogue is refused", () => {
	for (const bad of [null, undefined, [], "providers", 7, {}, { providers: "openai" }]) {
		assert.throws(() => parseModelCatalogue(bad), { name: "TypeError", message: /catalogue|providers/i },
			`${JSON.stringify(bad)} should be refused`);
	}
});

test("models are looked up by provider", () => {
	const parsed = parseModelCatalogue(catalogue());
	assert.deepEqual(modelsFor(parsed, "claude").map((m) => m.id), ["claude-sonnet-4-6"]);
});

test("an unknown provider has no models rather than throwing", () => {
	const parsed = parseModelCatalogue(catalogue());
	assert.deepEqual(modelsFor(parsed, "gemini"), []);
	assert.deepEqual(modelsFor(parsed, null), []);
	assert.deepEqual(modelsFor(null, "openai"), []);
});

test("a configured model is described with its labels", () => {
	assert.equal(describeModel(parseModelCatalogue(catalogue()), "claude", "claude-sonnet-4-6"),
		"Claude · Claude Sonnet 4.6");
});

test("a model the catalogue does not list is still named", () => {
	// A lobby can be running something removed from the config; showing "not set"
	// would be a lie about what is actually answering.
	assert.equal(describeModel(parseModelCatalogue(catalogue()), "openai", "gpt-3.5-turbo"),
		"OpenAI · gpt-3.5-turbo");
	assert.equal(describeModel(parseModelCatalogue(catalogue()), "ollama", "llama3"), "ollama · llama3");
});

test("an unconfigured lobby says so", () => {
	const parsed = parseModelCatalogue(catalogue());
	assert.equal(describeModel(parsed, null, null), "not set");
	assert.equal(describeModel(parsed, undefined, undefined), "not set");
});

// ── the shipped file ──────────────────────────────────────────────────────────

test("the shipped catalogue is valid and offers only providers the server understands", () => {
	// The registry is asked rather than restated. This assertion used to carry the literal list
	// `["openai", "claude"]` and cite `server/services/llmService.js`, a module that no longer
	// exists — so it went on passing after the registry renamed the provider to "anthropic", and
	// it was defending the very bug it was written to prevent: the catalogue offered "claude",
	// nothing could resolve it, and a lobby switched to it failed on every subsequent turn.
	//
	// A test that restates a fact cannot notice the fact changing. This one imports the authority.
	const shipped = JSON.parse(readFileSync(new URL("../../config/llm_models.json", import.meta.url), "utf8"));
	const parsed = parseModelCatalogue(shipped);
	const known = new Set(listProviders().map((p) => p.id));

	assert.ok(parsed.length > 0, "the shipped catalogue has no usable providers");
	for (const provider of parsed) {
		assert.ok(known.has(provider.id),
			`the registry does not know provider "${provider.id}" — it knows ${[...known].join(", ")}`);
		assert.ok(provider.models.length > 0, `${provider.id} offers no models`);
	}
});

// ── Ratings in the console's picker ──────────────────────────────────────────

/** Ratings shaped as `client/config/model_ratings.json` carries them. */
const RATINGS = {
	recommended: "openai/gpt-4o-mini",
	models: {
		"openai/gpt-4o-mini": { verdict: "recommended", score: 100, medianMs: 2900, turns: 18 },
		"openai/gpt-4o": { verdict: "recommended", score: 87, medianMs: 2700, turns: 99 },
		"openai/gpt-3.5-turbo": { verdict: "unusable", score: 20, turns: 40 },
	},
};

const RATED = [{
	id: "openai", label: "OpenAI",
	models: [
		{ id: "gpt-3.5-turbo", label: "GPT-3.5" },
		{ id: "gpt-4o", label: "GPT-4o" },
		{ id: "gpt-4o-mini", label: "GPT-4o Mini" },
	],
}];

test("the console's models carry ratings and lead with the best", () => {
	const models = ratedModelsFor(RATED, "openai", RATINGS);
	assert.deepEqual(models.map((m) => m.id), ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"]);
	assert.equal(models[0].rating.flag, "recommended");
	assert.equal(models.at(-1).rating.flag, "avoid");
});

test("an operator sees the same mark the lobby picker shows", () => {
	// The two pickers must not word this differently — an operator comparing them would
	// have no way to tell which one to believe.
	const models = ratedModelsFor(RATED, "openai", RATINGS);
	assert.equal(models[0].rating.label, "Recommended");
	assert.equal(models.at(-1).rating.label, "Known not to work");
});

test("without ratings the console still lists every model, unmarked", () => {
	const models = ratedModelsFor(RATED, "openai", null);
	assert.equal(models.length, 3);
	for (const model of models) assert.equal(model.rating.flag, "untested");
});

test("a provider the catalogue does not carry yields nothing rather than throwing", () => {
	assert.deepEqual(ratedModelsFor(RATED, "google", RATINGS), []);
	assert.deepEqual(ratedModelsFor(null, "openai", RATINGS), []);
});

test("labels from the catalogue survive annotation", () => {
	assert.equal(ratedModelsFor(RATED, "openai", RATINGS)[0].label, "GPT-4o Mini");
});
