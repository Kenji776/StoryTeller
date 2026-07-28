import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseModelCatalogue, modelsFor, describeModel } from "./models.js";

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
	// `server/services/llmService.js` resolves "openai" and "claude"; a provider id
	// here that it does not know would offer a switch that silently does nothing.
	const shipped = JSON.parse(readFileSync(new URL("../../config/llm_models.json", import.meta.url), "utf8"));
	const parsed = parseModelCatalogue(shipped);

	assert.ok(parsed.length > 0, "the shipped catalogue has no usable providers");
	for (const provider of parsed) {
		assert.ok(["openai", "claude"].includes(provider.id), `server does not resolve provider "${provider.id}"`);
		assert.ok(provider.models.length > 0, `${provider.id} offers no models`);
	}
});
