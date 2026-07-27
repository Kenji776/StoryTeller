/**
 * Unit tests for LLM request error typing.
 *
 * The point of this module is that a failed AI call can be explained to the
 * player who supplied the key: "your key was rejected" and "that provider is
 * rate limiting you" need different messages and different UI affordances, and
 * only one of them is worth retrying.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LLMRequestError, classifyHttpStatus } from "./errors.js";

// ── Classification ──────────────────────────────────────────────────────────

for (const [status, kind] of [
	[400, "bad_request"],
	[401, "auth"],
	[402, "quota"],
	[403, "auth"],
	[404, "not_found"],
	[422, "bad_request"],
	[429, "rate_limit"],
	[500, "server"],
	[502, "server"],
	[503, "server"],
]) {
	test(`classifyHttpStatus maps ${status} to "${kind}"`, () => {
		assert.equal(classifyHttpStatus(status), kind);
	});
}

test("classifyHttpStatus treats an unrecognised status as unknown", () => {
	assert.equal(classifyHttpStatus(418), "unknown");
});

test("classifyHttpStatus treats a 2xx status as unknown rather than an error kind", () => {
	// Callers only classify statuses they have already decided are failures;
	// a success reaching here is a caller bug, not a category of failure.
	assert.equal(classifyHttpStatus(200), "unknown");
});

test("classifyHttpStatus tolerates a null status", () => {
	assert.equal(classifyHttpStatus(null), "unknown");
});

test("classifyHttpStatus maps any unlisted 5xx to server", () => {
	assert.equal(classifyHttpStatus(599), "server");
});

// ── Error construction ──────────────────────────────────────────────────────

test("LLMRequestError records provider, status, and derived kind", () => {
	const err = new LLMRequestError("Invalid API key", { provider: "openai", status: 401 });

	assert.equal(err.name, "LLMRequestError");
	assert.equal(err.message, "Invalid API key");
	assert.equal(err.provider, "openai");
	assert.equal(err.status, 401);
	assert.equal(err.kind, "auth");
	assert.ok(err instanceof Error);
});

test("LLMRequestError derives kind from status when no kind is supplied", () => {
	const err = new LLMRequestError("Slow down", { provider: "anthropic", status: 429 });

	assert.equal(err.kind, "rate_limit");
});

test("LLMRequestError honours an explicit kind over the status-derived one", () => {
	// A transport failure has no status but is still a known category.
	const err = new LLMRequestError("socket hang up", { provider: "ollama", kind: "network" });

	assert.equal(err.kind, "network");
	assert.equal(err.status, null);
});

test("LLMRequestError defaults to unknown when given neither kind nor status", () => {
	const err = new LLMRequestError("something broke", { provider: "openai" });

	assert.equal(err.kind, "unknown");
});

test("LLMRequestError preserves an underlying cause", () => {
	const cause = new Error("ECONNREFUSED");
	const err = new LLMRequestError("Could not reach provider", { provider: "ollama", kind: "network", cause });

	assert.equal(err.cause, cause);
});

test("LLMRequestError requires a provider for attribution", () => {
	// Without the provider the operator cannot tell which of several configured
	// endpoints failed, which is the whole point of the field.
	assert.throws(() => new LLMRequestError("boom", {}), /provider/i);
});

// ── Retryability ────────────────────────────────────────────────────────────

for (const [kind, retryable] of [
	["rate_limit", true],
	["server",     true],
	["network",    true],
	["auth",       false],
	["quota",      false],
	["bad_request", false],
	["not_found",  false],
	["unknown",    false],
]) {
	test(`LLMRequestError reports kind "${kind}" as ${retryable ? "" : "not "}retryable`, () => {
		const err = new LLMRequestError("x", { provider: "openai", kind });
		assert.equal(err.retryable, retryable);
	});
}

// ── Player-facing messaging ─────────────────────────────────────────────────

test("userMessage explains an auth failure in terms of the player's own key", () => {
	const err = new LLMRequestError("Incorrect API key provided", { provider: "openai", status: 401 });

	const msg = err.userMessage();
	assert.match(msg, /key/i);
	assert.match(msg, /OpenAI|openai/);
});

test("userMessage explains a rate limit as temporary", () => {
	const err = new LLMRequestError("Rate limit reached", { provider: "anthropic", status: 429 });

	assert.match(err.userMessage(), /too many|rate limit|slow/i);
});

test("userMessage explains a not_found as a bad model or endpoint", () => {
	const err = new LLMRequestError("model not found", { provider: "openai", status: 404 });

	assert.match(err.userMessage(), /model|endpoint/i);
});

test("userMessage falls back to the raw message for an unknown failure", () => {
	const err = new LLMRequestError("the vibes were off", { provider: "openai" });

	assert.match(err.userMessage(), /the vibes were off/);
});

test("userMessage never leaks an API key that appeared in the provider message", () => {
	// Provider error bodies occasionally echo the submitted key back.
	const key = "test-key-DO-NOT-USE-abcdefghij";
	const err = new LLMRequestError(`Incorrect API key provided: ${key}`, { provider: "openai", status: 401 });

	assert.equal(err.userMessage().includes(key), false);
});
