/**
 * Unit tests for the provider registry.
 *
 * The registry is the only place that knows which providers exist. Everything
 * else — the socket handlers, the model-listing endpoint, the client UI — asks
 * it rather than carrying its own list, so that adding a provider is a
 * one-file change.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getProvider, listProviders, resolveLLMConfig } from "./registry.js";
import { LLMConfigError } from "./config.js";

const FAKE_KEY = "test-key-DO-NOT-USE";

// ── getProvider ─────────────────────────────────────────────────────────────

test("getProvider returns the OpenAI descriptor", () => {
	assert.equal(getProvider("openai").id, "openai");
});

test("getProvider returns the Anthropic descriptor", () => {
	assert.equal(getProvider("anthropic").id, "anthropic");
});

test("getProvider tolerates surrounding whitespace and mixed case", () => {
	// The id can arrive from hand-edited localStorage.
	assert.equal(getProvider("  OpenAI  ").id, "openai");
});

test("getProvider rejects an unknown provider by name", () => {
	assert.throws(
		() => getProvider("skynet"),
		(err) => err instanceof LLMConfigError && err.field === "providerId" && /skynet/.test(err.message)
	);
});

for (const [label, value] of [["null", null], ["undefined", undefined], ["an empty string", ""], ["a number", 3]]) {
	test(`getProvider rejects ${label}`, () => {
		assert.throws(() => getProvider(value), (err) => err instanceof LLMConfigError);
	});
}

// ── listProviders ───────────────────────────────────────────────────────────

test("listProviders describes every registered provider", () => {
	const ids = listProviders().map(p => p.id).sort();

	assert.deepEqual(ids, ["anthropic", "openai"]);
});

test("listProviders exposes what the configuration UI needs", () => {
	const openai = listProviders().find(p => p.id === "openai");

	assert.equal(openai.label, "OpenAI");
	assert.equal(openai.requiresApiKey, true);
	assert.equal(openai.requiresBaseUrl, false);
	assert.equal(openai.defaultBaseUrl, "https://api.openai.com/v1");
	assert.equal(openai.supportsImages, true);
	assert.equal(typeof openai.keyUrl, "string");
});

test("listProviders omits the adapter functions so the result is serialisable", () => {
	// This list is sent to the browser; functions would be silently dropped by
	// JSON and their presence here would invite someone to call them.
	const [first] = listProviders();

	assert.equal("chat" in first, false);
	assert.equal("listModels" in first, false);
	assert.deepEqual(JSON.parse(JSON.stringify(listProviders())), listProviders());
});

test("listProviders returns a fresh array that callers cannot use to mutate the registry", () => {
	listProviders().pop();

	assert.equal(listProviders().length, 2);
});

// ── resolveLLMConfig ────────────────────────────────────────────────────────

test("resolveLLMConfig pairs a normalized config with its provider", () => {
	const { provider, config } = resolveLLMConfig({ providerId: "openai", apiKey: FAKE_KEY, model: "gpt-4o" });

	assert.equal(provider.id, "openai");
	assert.equal(typeof provider.chat, "function");
	assert.deepEqual(config, {
		providerId: "openai",
		apiKey: FAKE_KEY,
		model: "gpt-4o",
		baseUrl: "https://api.openai.com/v1",
	});
});

test("resolveLLMConfig applies the provider default base URL", () => {
	const { config } = resolveLLMConfig({ providerId: "anthropic", apiKey: FAKE_KEY, model: "claude-sonnet-4-6" });

	assert.equal(config.baseUrl, "https://api.anthropic.com/v1");
});

test("resolveLLMConfig rejects an unknown provider", () => {
	assert.throws(
		() => resolveLLMConfig({ providerId: "skynet", apiKey: FAKE_KEY }),
		(err) => err instanceof LLMConfigError && err.field === "providerId"
	);
});

test("resolveLLMConfig surfaces a missing API key as a config error", () => {
	assert.throws(
		() => resolveLLMConfig({ providerId: "openai" }),
		(err) => err instanceof LLMConfigError && err.field === "apiKey"
	);
});

test("resolveLLMConfig rejects a non-object config", () => {
	assert.throws(() => resolveLLMConfig(null), (err) => err instanceof LLMConfigError);
});

test("resolveLLMConfig normalises the provider id it was given", () => {
	const { config } = resolveLLMConfig({ providerId: "  OpenAI ", apiKey: FAKE_KEY });

	assert.equal(config.providerId, "openai");
});
