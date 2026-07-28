import { test } from "node:test";
import assert from "node:assert/strict";

import { openaiImageProvider, nearestSupportedSize } from "./openaiImages.js";
import { LLMRequestError } from "../../llm/errors.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const FAKE_KEY = "test-token-DO-NOT-USE-openai";
const config = { providerId: "openai", apiKey: FAKE_KEY, model: null, baseUrl: "https://api.openai.com/v1" };

/** A one-pixel PNG, so a fixture never carries anything resembling real image data. */
const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

/**
 * Builds a fetch double that answers each call from a script.
 *
 * @param {Array<object>|object} script - One response spec, or one per call in order.
 * @returns {Function} A fetch-shaped function carrying a `calls` array.
 */
function makeFetch(script = { status: 200, body: { data: [{ b64_json: FAKE_PNG_B64 }] } }) {
	const queue = Array.isArray(script) ? [...script] : null;
	const calls = [];
	const impl = async (url, init) => {
		const spec = queue ? queue.shift() ?? { status: 200, body: {} } : script;
		calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
		if (spec.throws) throw spec.throws;
		const status = spec.status ?? 200;
		return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(spec.body ?? {}) };
	};
	impl.calls = calls;
	return impl;
}

/**
 * Generates through the adapter with test defaults, on a fresh model preference.
 *
 * @param {Function} fetchImpl - The fetch double.
 * @param {object} [overrides] - Request fields to replace.
 * @returns {Promise<object>} The adapter's result.
 */
function generate(fetchImpl, overrides = {}) {
	openaiImageProvider.resetPreference();
	return openaiImageProvider.generate({ prompt: "a dwarven paladin", config, fetchImpl, ...overrides });
}

// ── nearestSupportedSize ─────────────────────────────────────────────────────

test("a square request maps to the square supported size", () => {
	assert.equal(nearestSupportedSize({ width: 1024, height: 1024 }), "1024x1024");
});

test("a portrait request maps to a portrait supported size", () => {
	const chosen = nearestSupportedSize({ width: 896, height: 1152 });
	const [w, h] = chosen.split("x").map(Number);
	assert.ok(h > w, `expected a portrait size, got ${chosen}`);
});

test("a landscape request maps to a landscape supported size", () => {
	const chosen = nearestSupportedSize({ width: 1536, height: 1024 });
	const [w, h] = chosen.split("x").map(Number);
	assert.ok(w > h, `expected a landscape size, got ${chosen}`);
});

test("an absent size defaults to portrait, matching what character art needs", () => {
	const [w, h] = nearestSupportedSize().split("x").map(Number);
	assert.ok(h > w);
});

// ── Generating ───────────────────────────────────────────────────────────────

test("the prompt is posted to the images endpoint with the supplied key", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl);

	assert.match(fetchImpl.calls[0].url, /\/images\/generations$/);
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
	assert.equal(fetchImpl.calls[0].payload.prompt, "a dwarven paladin");
});

test("the generated image comes back with the model that made it", async () => {
	const result = await generate(makeFetch());

	assert.equal(result.b64, FAKE_PNG_B64);
	assert.ok(result.model, "the model that produced the image should be reported");
	assert.equal(result.contentType, "image/png");
});

test("the caller's key is used rather than any ambient credential", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { config: { ...config, apiKey: "test-token-DO-NOT-USE-other" } });

	assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer test-token-DO-NOT-USE-other");
});

test("a blank prompt is refused before a request is made", async () => {
	const fetchImpl = makeFetch();
	await assert.rejects(() => generate(fetchImpl, { prompt: "  " }), /prompt/i);
	assert.equal(fetchImpl.calls.length, 0);
});

test("a missing key is refused before a request is made", async () => {
	const fetchImpl = makeFetch();
	await assert.rejects(() => generate(fetchImpl, { config: { ...config, apiKey: null } }), /key/i);
	assert.equal(fetchImpl.calls.length, 0);
});

// ── The model ladder ─────────────────────────────────────────────────────────

test("the first model that answers is the one used", async () => {
	const fetchImpl = makeFetch([{ status: 200, body: { data: [{ b64_json: FAKE_PNG_B64 }] } }]);
	const result = await generate(fetchImpl);

	assert.equal(fetchImpl.calls.length, 1);
	assert.equal(result.model, fetchImpl.calls[0].payload.model);
});

test("a model the account cannot call is stepped over rather than failing the request", async () => {
	const fetchImpl = makeFetch([
		{ status: 403, body: { error: { message: "model not available to this org" } } },
		{ status: 200, body: { data: [{ b64_json: FAKE_PNG_B64 }] } },
	]);

	const result = await generate(fetchImpl);
	assert.equal(fetchImpl.calls.length, 2);
	assert.equal(result.b64, FAKE_PNG_B64);
	assert.notEqual(fetchImpl.calls[0].payload.model, fetchImpl.calls[1].payload.model);
});

test("every model failing surfaces one error naming what was tried", async () => {
	const fetchImpl = makeFetch({ status: 403, body: { error: { message: "no access" } } });
	openaiImageProvider.resetPreference();

	await assert.rejects(
		() => openaiImageProvider.generate({ prompt: "x", config, fetchImpl }),
		(err) => {
			assert.ok(err instanceof LLMRequestError);
			assert.match(err.message, /no image model|tried/i);
			return true;
		},
	);
	assert.ok(fetchImpl.calls.length > 1, "the ladder should have tried more than one model");
});

test("a model known to work is tried first on the next call", async () => {
	const failThenPass = makeFetch([
		{ status: 403, body: { error: { message: "no access" } } },
		{ status: 200, body: { data: [{ b64_json: FAKE_PNG_B64 }] } },
	]);
	await generate(failThenPass);
	const winner = failThenPass.calls[1].payload.model;

	// No resetPreference: the point is that the memo survives to the next call.
	const second = makeFetch();
	await openaiImageProvider.generate({ prompt: "again", config, fetchImpl: second });

	assert.equal(second.calls[0].payload.model, winner);
	assert.equal(second.calls.length, 1, "a remembered model should not re-walk the ladder");
});

test("an explicitly chosen model is used instead of the ladder", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { config: { ...config, model: "gpt-image-1" } });

	assert.equal(fetchImpl.calls[0].payload.model, "gpt-image-1");
	assert.equal(fetchImpl.calls.length, 1);
});

// ── Per-family request differences ───────────────────────────────────────────

test("dall-e-3 is sent the response format it requires", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { config: { ...config, model: "dall-e-3" } });

	assert.equal(fetchImpl.calls[0].payload.response_format, "b64_json");
});

test("the gpt-image family is not sent a response format, which it rejects", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { config: { ...config, model: "gpt-image-2" } });

	assert.equal(Object.hasOwn(fetchImpl.calls[0].payload, "response_format"), false);
});

// ── Responses that are not images ────────────────────────────────────────────

test("a response carrying no image data is a failure", async () => {
	await assert.rejects(
		() => generate(makeFetch({ status: 200, body: { data: [] } })),
		/no image/i,
	);
});

test("an authentication failure is reported as such and not retried down the ladder", async () => {
	const fetchImpl = makeFetch({ status: 401, body: { error: { message: "invalid key" } } });
	openaiImageProvider.resetPreference();

	await assert.rejects(
		() => openaiImageProvider.generate({ prompt: "x", config, fetchImpl }),
		(err) => {
			assert.equal(err.kind, "auth");
			return true;
		},
	);
	assert.equal(fetchImpl.calls.length, 1, "a rejected key is not fixed by trying another model");
});

test("no failure message echoes the key back", async () => {
	const fetchImpl = makeFetch({ status: 401, body: { error: { message: `bad key ${FAKE_KEY}` } } });
	openaiImageProvider.resetPreference();

	await assert.rejects(
		() => openaiImageProvider.generate({ prompt: "x", config, fetchImpl }),
		(err) => {
			assert.ok(!err.userMessage().includes(FAKE_KEY), "the key reached a player-facing message");
			return true;
		},
	);
});

// ── Descriptor ───────────────────────────────────────────────────────────────

test("the adapter declares itself remote and needing a key", () => {
	assert.equal(openaiImageProvider.isLocal, false);
	assert.equal(openaiImageProvider.requiresApiKey, true);
	assert.equal(openaiImageProvider.requiresBaseUrl, false);
	assert.match(openaiImageProvider.keyUrl, /openai\.com/);
});
