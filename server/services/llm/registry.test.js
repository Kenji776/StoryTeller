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

	assert.deepEqual(ids, ["anthropic", "google", "ollama", "openai", "openai-compatible"]);
});

test("listProviders hides the canned-response provider by default", () => {
	// Test Mode is a development affordance. Offering it on a public instance
	// would look like a broken game rather than a free one.
	assert.equal(listProviders().some(p => p.id === "test"), false);
});

test("listProviders includes the test provider when dev mode asks for it", () => {
	assert.equal(listProviders({ includeTest: true }).some(p => p.id === "test"), true);
});

test("getProvider resolves the test provider regardless of listing policy", () => {
	// A lobby already configured for Test Mode must keep working even though
	// the provider is hidden from the picker.
	assert.equal(getProvider("test").id, "test");
});

test("every registered provider exposes the full adapter contract", () => {
	for (const { id } of listProviders({ includeTest: true })) {
		const provider = getProvider(id);
		assert.equal(typeof provider.chat, "function", `${id} must implement chat`);
		assert.equal(typeof provider.listModels, "function", `${id} must implement listModels`);
		assert.equal(typeof provider.label, "string", `${id} must have a label`);
		assert.equal(typeof provider.requiresApiKey, "boolean", `${id} must declare requiresApiKey`);
		assert.equal(typeof provider.requiresBaseUrl, "boolean", `${id} must declare requiresBaseUrl`);
		assert.equal(typeof provider.supportsImages, "boolean", `${id} must declare supportsImages`);
	}
});

test("a provider that requires a base URL either supplies a default or demands one", () => {
	// Otherwise normalizeLLMConfig would reject every config for it.
	for (const p of listProviders({ includeTest: true })) {
		if (p.requiresBaseUrl) continue;
		assert.ok(
			p.defaultBaseUrl === null || typeof p.defaultBaseUrl === "string",
			`${p.id} has a malformed defaultBaseUrl`
		);
	}
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
	const before = listProviders().length;
	listProviders().pop();

	assert.equal(listProviders().length, before);
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
