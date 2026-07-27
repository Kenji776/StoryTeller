/**
 * Unit tests for LLM configuration normalization and redaction.
 *
 * These cover the boundary-validation contract (CQ-6): every player-supplied
 * AI configuration passes through `normalizeLLMConfig` exactly once, and
 * everything downstream may assume the result is well-formed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLLMConfig, redactLLMConfig, LLMConfigError } from "./config.js";

/**
 * @description Builds a provider descriptor for a provider that needs an API
 *   key but no base URL — the shape of OpenAI, Anthropic, and Google.
 * @param {object} [overrides] - Fields to override on the descriptor.
 * @returns {object} A provider descriptor suitable for `normalizeLLMConfig`.
 */
function keyedProvider(overrides = {}) {
	return {
		id: "openai",
		label: "OpenAI",
		requiresApiKey: true,
		requiresBaseUrl: false,
		defaultBaseUrl: "https://api.openai.com/v1",
		...overrides,
	};
}

/**
 * @description Builds a provider descriptor for a keyless, base-URL-driven
 *   provider — the shape of a local Ollama or LM Studio instance.
 * @param {object} [overrides] - Fields to override on the descriptor.
 * @returns {object} A provider descriptor suitable for `normalizeLLMConfig`.
 */
function localProvider(overrides = {}) {
	return {
		id: "ollama",
		label: "Ollama",
		requiresApiKey: false,
		requiresBaseUrl: true,
		defaultBaseUrl: "http://localhost:11434",
		...overrides,
	};
}

const FAKE_KEY = "test-key-DO-NOT-USE-abcd";

// ── Happy path ──────────────────────────────────────────────────────────────

test("normalizeLLMConfig returns a clean config for a fully specified input", () => {
	const result = normalizeLLMConfig(
		{ providerId: "openai", apiKey: FAKE_KEY, model: "gpt-4o" },
		keyedProvider()
	);

	assert.deepEqual(result, {
		providerId: "openai",
		apiKey: FAKE_KEY,
		model: "gpt-4o",
		baseUrl: "https://api.openai.com/v1",
	});
});

test("normalizeLLMConfig trims surrounding whitespace from every string field", () => {
	const result = normalizeLLMConfig(
		{ providerId: "  openai  ", apiKey: `  ${FAKE_KEY}\n`, model: "\tgpt-4o " },
		keyedProvider()
	);

	assert.equal(result.providerId, "openai");
	assert.equal(result.apiKey, FAKE_KEY);
	assert.equal(result.model, "gpt-4o");
});

test("normalizeLLMConfig leaves model null when the caller has not chosen one yet", () => {
	// The configuration flow is: pick provider -> enter key -> list models ->
	// pick model. Listing models must work before a model exists.
	const result = normalizeLLMConfig({ providerId: "openai", apiKey: FAKE_KEY }, keyedProvider());

	assert.equal(result.model, null);
});

test("normalizeLLMConfig applies the provider default base URL when none is given", () => {
	const result = normalizeLLMConfig({ providerId: "openai", apiKey: FAKE_KEY }, keyedProvider());

	assert.equal(result.baseUrl, "https://api.openai.com/v1");
});

test("normalizeLLMConfig prefers an explicit base URL over the provider default", () => {
	const result = normalizeLLMConfig(
		{ providerId: "openai", apiKey: FAKE_KEY, baseUrl: "https://proxy.example.com/v1" },
		keyedProvider()
	);

	assert.equal(result.baseUrl, "https://proxy.example.com/v1");
});

test("normalizeLLMConfig strips trailing slashes from the base URL", () => {
	// Adapters build request paths by concatenation, so a trailing slash would
	// produce a double slash and 404 on strict gateways.
	const result = normalizeLLMConfig(
		{ providerId: "ollama", baseUrl: "http://localhost:11434///" },
		localProvider()
	);

	assert.equal(result.baseUrl, "http://localhost:11434");
});

test("normalizeLLMConfig accepts a keyless provider and reports a null apiKey", () => {
	const result = normalizeLLMConfig({ providerId: "ollama" }, localProvider());

	assert.equal(result.apiKey, null);
	assert.equal(result.baseUrl, "http://localhost:11434");
});

test("normalizeLLMConfig accepts an optional apiKey on a keyless provider", () => {
	// Some self-hosted gateways sit behind an auth proxy that still wants a key.
	const result = normalizeLLMConfig({ providerId: "ollama", apiKey: FAKE_KEY }, localProvider());

	assert.equal(result.apiKey, FAKE_KEY);
});

test("normalizeLLMConfig fills a missing providerId from the resolved descriptor", () => {
	// The caller has already looked the descriptor up by id, so the descriptor
	// is the authority; an absent providerId is filled rather than rejected.
	const result = normalizeLLMConfig({ apiKey: FAKE_KEY }, keyedProvider());

	assert.equal(result.providerId, "openai");
});

test("normalizeLLMConfig discards unrecognised fields", () => {
	// Whatever the browser sends is untrusted; only the known shape survives, so
	// stray fields cannot ride along into logs or persisted lobby state.
	const result = normalizeLLMConfig(
		{ providerId: "openai", apiKey: FAKE_KEY, organisationSecret: "leaked", __proto__: {} },
		keyedProvider()
	);

	assert.deepEqual(Object.keys(result).sort(), ["apiKey", "baseUrl", "model", "providerId"]);
});

// ── Properties ──────────────────────────────────────────────────────────────

test("normalizeLLMConfig is idempotent", () => {
	const once  = normalizeLLMConfig({ providerId: "openai", apiKey: ` ${FAKE_KEY} `, model: "gpt-4o" }, keyedProvider());
	const twice = normalizeLLMConfig(once, keyedProvider());

	assert.deepEqual(twice, once);
});

// ── Invalid input ───────────────────────────────────────────────────────────

for (const [label, value] of [
	["null",      null],
	["undefined", undefined],
	["a string",  "openai"],
	["an array",  ["openai"]],
	["a number",  42],
]) {
	test(`normalizeLLMConfig rejects ${label} as the raw config`, () => {
		assert.throws(
			() => normalizeLLMConfig(value, keyedProvider()),
			(err) => err instanceof LLMConfigError && /object/i.test(err.message)
		);
	});
}

test("normalizeLLMConfig rejects a missing provider descriptor", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "openai", apiKey: FAKE_KEY }, null),
		(err) => err instanceof LLMConfigError && /provider/i.test(err.message)
	);
});

test("normalizeLLMConfig rejects a config whose providerId disagrees with the descriptor", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "anthropic", apiKey: FAKE_KEY }, keyedProvider()),
		(err) => err instanceof LLMConfigError && err.field === "providerId"
	);
});

test("normalizeLLMConfig rejects a missing apiKey when the provider requires one", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "openai" }, keyedProvider()),
		(err) => err instanceof LLMConfigError
			&& err.field === "apiKey"
			&& /OpenAI/.test(err.message)
	);
});

test("normalizeLLMConfig rejects a whitespace-only apiKey when the provider requires one", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "openai", apiKey: "   " }, keyedProvider()),
		(err) => err instanceof LLMConfigError && err.field === "apiKey"
	);
});

test("normalizeLLMConfig rejects a non-string apiKey", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "openai", apiKey: 12345 }, keyedProvider()),
		(err) => err instanceof LLMConfigError && err.field === "apiKey"
	);
});

test("normalizeLLMConfig rejects a non-string model", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "openai", apiKey: FAKE_KEY, model: 7 }, keyedProvider()),
		(err) => err instanceof LLMConfigError && err.field === "model"
	);
});

test("normalizeLLMConfig rejects an empty model string rather than silently nulling it", () => {
	// An empty string here means the UI failed to populate the dropdown; that is
	// a bug worth surfacing, not a default worth guessing.
	assert.throws(
		() => normalizeLLMConfig({ providerId: "openai", apiKey: FAKE_KEY, model: "   " }, keyedProvider()),
		(err) => err instanceof LLMConfigError && err.field === "model"
	);
});

test("normalizeLLMConfig rejects a missing base URL when the provider requires one and has no default", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "custom" }, localProvider({ id: "custom", label: "Custom", defaultBaseUrl: null })),
		(err) => err instanceof LLMConfigError && err.field === "baseUrl"
	);
});

test("normalizeLLMConfig rejects a malformed base URL", () => {
	assert.throws(
		() => normalizeLLMConfig({ providerId: "ollama", baseUrl: "not a url" }, localProvider()),
		(err) => err instanceof LLMConfigError && err.field === "baseUrl"
	);
});

for (const scheme of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com"]) {
	test(`normalizeLLMConfig rejects the non-HTTP base URL ${scheme}`, () => {
		// The base URL is player-supplied and is fetched by the server, so
		// anything that is not http(s) is refused outright.
		assert.throws(
			() => normalizeLLMConfig({ providerId: "ollama", baseUrl: scheme }, localProvider()),
			(err) => err instanceof LLMConfigError && err.field === "baseUrl"
		);
	});
}

// ── Redaction ───────────────────────────────────────────────────────────────

test("redactLLMConfig replaces the API key with a masked suffix", () => {
	const redacted = redactLLMConfig({ providerId: "openai", apiKey: FAKE_KEY, model: "gpt-4o", baseUrl: "https://api.openai.com/v1" });

	assert.equal(redacted.apiKey, "****abcd");
	assert.equal(redacted.providerId, "openai");
	assert.equal(redacted.model, "gpt-4o");
});

test("redactLLMConfig never emits any part of a short key", () => {
	// Too short to reveal a suffix without revealing most of the key.
	const redacted = redactLLMConfig({ providerId: "openai", apiKey: "abcd1234", model: null, baseUrl: null });

	assert.equal(redacted.apiKey, "****");
});

test("redactLLMConfig reports a null key as absent rather than masked", () => {
	const redacted = redactLLMConfig({ providerId: "ollama", apiKey: null, model: "llama3", baseUrl: "http://localhost:11434" });

	assert.equal(redacted.apiKey, null);
});

test("redactLLMConfig output contains the raw key nowhere in its serialised form", () => {
	// This is the assertion that actually protects the log files (STY-3): the
	// whole redacted object is what gets JSON-stringified into llm-*.jsonl.
	const redacted = redactLLMConfig({ providerId: "openai", apiKey: FAKE_KEY, model: "gpt-4o", baseUrl: null });

	assert.equal(JSON.stringify(redacted).includes(FAKE_KEY), false);
});

test("redactLLMConfig does not mutate its input", () => {
	const input = { providerId: "openai", apiKey: FAKE_KEY, model: "gpt-4o", baseUrl: null };
	redactLLMConfig(input);

	assert.equal(input.apiKey, FAKE_KEY);
});

test("redactLLMConfig tolerates a null config", () => {
	assert.equal(redactLLMConfig(null), null);
});
