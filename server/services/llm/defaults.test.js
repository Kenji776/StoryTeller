/**
 * Unit tests for the settings a brand-new lobby is stamped with.
 *
 * This decides what narrates every game nobody has configured, so the precedence
 * between the operator's environment and the bake-off's recommendation is pinned
 * rather than left to be discovered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultLLMSettings, readRecommendedDefault } from "./defaults.js";

/** A recommendation as `readRecommendedDefault` returns one. */
const RECOMMENDED = { provider: "openai", model: "gpt-4o-mini" };

// ── Precedence ───────────────────────────────────────────────────────────────

test("the operator's environment wins over the recommendation", () => {
	// Never silently override an explicit choice: an operator who set this meant it.
	const settings = getDefaultLLMSettings(
		{ DEFAULT_LLM_PROVIDER: "anthropic", DEFAULT_LLM_MODEL: "claude-sonnet-5" },
		RECOMMENDED,
	);
	assert.deepEqual(settings, { provider: "anthropic", model: "claude-sonnet-5" });
});

test("the recommendation is used when the environment says nothing", () => {
	assert.deepEqual(getDefaultLLMSettings({}, RECOMMENDED), RECOMMENDED);
});

test("with neither, a hardcoded fallback still yields a usable pair", () => {
	const settings = getDefaultLLMSettings({}, null);
	assert.equal(typeof settings.provider, "string");
	assert.ok(settings.provider.length > 0);
	assert.equal(typeof settings.model, "string");
	assert.ok(settings.model.length > 0);
});

test("a legacy provider id is canonicalised, recommendation or not", () => {
	assert.equal(getDefaultLLMSettings({ DEFAULT_LLM_PROVIDER: "claude" }, RECOMMENDED).provider, "anthropic");
});

test("a provider set without a model takes the model from the recommendation", () => {
	// Half-configured is the common real case, and pairing a provider with another
	// provider's model is exactly the mismatch the narrator panel exists to prevent.
	const settings = getDefaultLLMSettings({ DEFAULT_LLM_PROVIDER: "openai" }, RECOMMENDED);
	assert.equal(settings.provider, "openai");
	assert.equal(settings.model, "gpt-4o-mini");
});

test("OPENAI_MODEL is still honoured as the older name for the model", () => {
	assert.equal(getDefaultLLMSettings({ OPENAI_MODEL: "gpt-4-turbo" }, RECOMMENDED).model, "gpt-4-turbo");
});

// ── Reading the recommendation ───────────────────────────────────────────────

/**
 * @description Builds a filesystem stub returning the given text.
 * @param {string} text - File contents.
 * @returns {object} A stub with `readFileSync`.
 */
const fsWith = (text) => ({ readFileSync: () => text });

test("the recommendation is read from the ratings file", () => {
	const fake = fsWith(JSON.stringify({ recommended: "openai/gpt-4o-mini", models: {} }));
	assert.deepEqual(readRecommendedDefault(fake, "ignored"), RECOMMENDED);
});

test("a model id containing a slash is split only on the first one", () => {
	// Some gateways serve ids like "meta/llama-3/70b"; the provider is the first segment.
	const fake = fsWith(JSON.stringify({ recommended: "ollama/library/qwen:7b" }));
	assert.deepEqual(readRecommendedDefault(fake, "x"), { provider: "ollama", model: "library/qwen:7b" });
});

test("a missing or unreadable ratings file yields no recommendation rather than throwing", () => {
	const exploding = { readFileSync: () => { throw new Error("ENOENT"); } };
	assert.equal(readRecommendedDefault(exploding, "x"), null);
});

test("a ratings file with no recommendation yields null", () => {
	for (const body of ["{}", '{"recommended":null}', '{"recommended":""}', '{"recommended":"no-slash"}', "not json"]) {
		assert.equal(readRecommendedDefault(fsWith(body), "x"), null, `body ${body}`);
	}
});

// ── Properties ───────────────────────────────────────────────────────────────

test("reading defaults never mutates the environment it was given", () => {
	const env = { DEFAULT_LLM_PROVIDER: "openai" };
	const before = JSON.stringify(env);
	getDefaultLLMSettings(env, RECOMMENDED);
	assert.equal(JSON.stringify(env), before);
});

test("the result is always a complete pair of strings", () => {
	const cases = [{}, { DEFAULT_LLM_PROVIDER: "openai" }, { DEFAULT_LLM_MODEL: "x" }, { OPENAI_MODEL: "y" }];
	for (const env of cases) {
		for (const rec of [RECOMMENDED, null]) {
			const settings = getDefaultLLMSettings(env, rec);
			assert.ok(settings.provider && settings.model, `incomplete for ${JSON.stringify({ env, rec })}`);
		}
	}
});
