/**
 * Unit tests for the injectable JSON/HTTP layer shared by every provider adapter.
 *
 * `fetch` is injected rather than reached for, so these tests exercise real
 * request construction and real error mapping with no network (CQ-5, TDD-8).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { requestJson } from "./http.js";
import { LLMRequestError } from "./errors.js";

/**
 * @description Builds a minimal stand-in for a WHATWG `Response`, sufficient
 *   for the fields `requestJson` actually reads.
 * @param {object} options - Response fields.
 * @param {number} [options.status=200] - HTTP status code.
 * @param {*} [options.json] - Body to serialise as JSON. Mutually exclusive with `text`.
 * @param {string} [options.text] - Raw body text, for non-JSON responses.
 * @returns {object} A Response-like object.
 */
function fakeResponse({ status = 200, json, text } = {}) {
	const bodyText = text !== undefined ? text : JSON.stringify(json ?? {});
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() { return bodyText; },
	};
}

/**
 * @description Builds a fetch stand-in that records its calls and returns a
 *   scripted response.
 * @param {object|Error} result - The response to return, or an error to reject with.
 * @returns {Function} A fetch-compatible function with a `.calls` array.
 */
function fakeFetch(result) {
	const impl = async (url, init) => {
		impl.calls.push({ url, init });
		if (result instanceof Error) throw result;
		return result;
	};
	impl.calls = [];
	return impl;
}

const FAKE_KEY = "test-key-DO-NOT-USE";

// ── Happy path ──────────────────────────────────────────────────────────────

test("requestJson returns the parsed JSON body on success", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ json: { data: [{ id: "gpt-4o" }] } }));

	const result = await requestJson("https://api.example.com/v1/models", { provider: "openai", fetchImpl });

	assert.deepEqual(result, { data: [{ id: "gpt-4o" }] });
});

test("requestJson issues a GET with no body by default", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ json: {} }));

	await requestJson("https://api.example.com/v1/models", { provider: "openai", fetchImpl });

	const { url, init } = fetchImpl.calls[0];
	assert.equal(url, "https://api.example.com/v1/models");
	assert.equal(init.method, "GET");
	assert.equal(init.body, undefined);
});

test("requestJson serialises a POST body and sets the JSON content type", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ json: { ok: true } }));

	await requestJson("https://api.example.com/v1/chat", {
		provider: "openai",
		method: "POST",
		body: { model: "gpt-4o", messages: [] },
		fetchImpl,
	});

	const { init } = fetchImpl.calls[0];
	assert.equal(init.method, "POST");
	assert.equal(init.headers["Content-Type"], "application/json");
	assert.deepEqual(JSON.parse(init.body), { model: "gpt-4o", messages: [] });
});

test("requestJson forwards caller headers such as Authorization", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ json: {} }));

	await requestJson("https://api.example.com/v1/models", {
		provider: "openai",
		headers: { Authorization: `Bearer ${FAKE_KEY}` },
		fetchImpl,
	});

	assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
});

test("requestJson forwards an abort signal", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ json: {} }));
	const controller = new AbortController();

	await requestJson("https://api.example.com/v1/models", { provider: "openai", fetchImpl, signal: controller.signal });

	assert.equal(fetchImpl.calls[0].init.signal, controller.signal);
});

test("requestJson accepts an empty response body as an empty object", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ text: "" }));

	const result = await requestJson("https://api.example.com/v1/ping", { provider: "openai", fetchImpl });

	assert.deepEqual(result, {});
});

// ── Error mapping ───────────────────────────────────────────────────────────

test("requestJson maps a 401 to an auth LLMRequestError carrying the provider message", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ status: 401, json: { error: { message: "Incorrect API key provided" } } }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/chat", { provider: "openai", fetchImpl }),
		(err) => {
			assert.ok(err instanceof LLMRequestError);
			assert.equal(err.status, 401);
			assert.equal(err.kind, "auth");
			assert.equal(err.provider, "openai");
			assert.match(err.message, /Incorrect API key provided/);
			return true;
		}
	);
});

test("requestJson extracts a string-shaped error field", async () => {
	// Ollama and several OpenAI-compatible gateways use { error: "..." }.
	const fetchImpl = fakeFetch(fakeResponse({ status: 404, json: { error: "model 'llama9' not found" } }));

	await assert.rejects(
		() => requestJson("http://localhost:11434/api/chat", { provider: "ollama", fetchImpl }),
		(err) => err.kind === "not_found" && /llama9/.test(err.message)
	);
});

test("requestJson falls back to raw body text when the error body is not JSON", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ status: 502, text: "<html>Bad Gateway</html>" }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/chat", { provider: "openai", fetchImpl }),
		(err) => err.kind === "server" && /Bad Gateway/.test(err.message)
	);
});

test("requestJson reports the status when the error body is empty", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ status: 500, text: "" }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/chat", { provider: "openai", fetchImpl }),
		(err) => err.status === 500 && /500/.test(err.message)
	);
});

test("requestJson truncates an oversized error body", async () => {
	// Some gateways return an entire HTML error page; that must not end up
	// verbatim in a toast or a log line.
	const fetchImpl = fakeFetch(fakeResponse({ status: 500, text: "x".repeat(5000) }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/chat", { provider: "openai", fetchImpl }),
		(err) => err.message.length < 600
	);
});

test("requestJson maps a transport failure to a network error preserving the cause", async () => {
	const cause = new Error("connect ECONNREFUSED 127.0.0.1:11434");
	const fetchImpl = fakeFetch(cause);

	await assert.rejects(
		() => requestJson("http://localhost:11434/api/chat", { provider: "ollama", fetchImpl }),
		(err) => {
			assert.ok(err instanceof LLMRequestError);
			assert.equal(err.kind, "network");
			assert.equal(err.status, null);
			assert.equal(err.cause, cause);
			return true;
		}
	);
});

test("requestJson maps an unparseable success body to a bad_response error", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ status: 200, text: "not json at all" }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/chat", { provider: "openai", fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("requestJson never includes the request body in an error message", async () => {
	// The request body is safe, but the headers holding the key are adjacent;
	// this pins the rule that we echo only the response side back.
	const fetchImpl = fakeFetch(fakeResponse({ status: 400, json: { error: { message: "bad model" } } }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/chat", {
			provider: "openai",
			method: "POST",
			body: { secretish: FAKE_KEY },
			headers: { Authorization: `Bearer ${FAKE_KEY}` },
			fetchImpl,
		}),
		(err) => err.message.includes(FAKE_KEY) === false
	);
});

// ── Invalid input ───────────────────────────────────────────────────────────

test("requestJson requires a provider id", async () => {
	const fetchImpl = fakeFetch(fakeResponse({ json: {} }));

	await assert.rejects(
		() => requestJson("https://api.example.com/v1/models", { fetchImpl }),
		/provider/i
	);
});

test("requestJson requires a fetch implementation when the runtime has none", async () => {
	await assert.rejects(
		() => requestJson("https://api.example.com/v1/models", { provider: "openai", fetchImpl: null }),
		/fetch/i
	);
});
