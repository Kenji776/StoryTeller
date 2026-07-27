/**
 * Unit tests for the generic OpenAI-compatible provider adapter.
 *
 * This is the escape hatch: OpenRouter, Groq, Together, vLLM, LM Studio, and
 * most self-hosted gateways all speak the OpenAI chat-completions shape at a
 * different address. The player supplies a base URL and, usually, a key.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { openaiCompatibleProvider } from "./openaiCompatible.js";
import { LLMRequestError } from "../errors.js";

const FAKE_KEY = "test-key-DO-NOT-USE";

const CONFIG = {
	providerId: "openai-compatible",
	apiKey: FAKE_KEY,
	model: "meta-llama/llama-3.3-70b",
	baseUrl: "https://openrouter.ai/api/v1",
};

/**
 * @description Builds a fetch stand-in that records calls and returns a scripted
 *   JSON payload.
 * @param {*} payload - The value the fake endpoint should return as JSON.
 * @param {number} [status=200] - HTTP status to report.
 * @returns {Function} A fetch-compatible function with a `.calls` array.
 */
function fakeFetch(payload, status = 200) {
	const impl = async (url, init) => {
		impl.calls.push({ url, init });
		return {
			ok: status >= 200 && status < 300,
			status,
			async text() { return JSON.stringify(payload); },
		};
	};
	impl.calls = [];
	return impl;
}

/**
 * @description Builds a minimal successful chat-completions payload.
 * @param {string} content - The assistant message content to return.
 * @returns {object} An OpenAI-shaped response body.
 */
function completion(content) {
	return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

/**
 * @description Reads the JSON body of the first recorded request.
 * @param {Function} fetchImpl - A fake fetch with recorded calls.
 * @returns {object} The parsed request body.
 */
function sentBody(fetchImpl) {
	return JSON.parse(fetchImpl.calls[0].init.body);
}

// ── Descriptor ──────────────────────────────────────────────────────────────

test("openaiCompatibleProvider requires a base URL and offers no default", () => {
	// There is no sensible default address for "somebody else's gateway".
	assert.equal(openaiCompatibleProvider.id, "openai-compatible");
	assert.equal(openaiCompatibleProvider.requiresBaseUrl, true);
	assert.equal(openaiCompatibleProvider.defaultBaseUrl, null);
});

test("openaiCompatibleProvider does not require an API key", () => {
	// A local vLLM or LM Studio instance typically has no auth at all.
	assert.equal(openaiCompatibleProvider.requiresApiKey, false);
});

test("openaiCompatibleProvider does not advertise image support", () => {
	assert.equal(openaiCompatibleProvider.supportsImages, false);
});

// ── chat ────────────────────────────────────────────────────────────────────

test("chat posts to the chat-completions path under the supplied base URL", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(fetchImpl.calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
});

test("chat sends bearer auth when a key is configured", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
});

test("chat omits the Authorization header entirely when no key is configured", async () => {
	// Sending "Bearer null" to an unauthenticated local endpoint is a good way
	// to get a confusing 401 from a server that would otherwise have worked.
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiCompatibleProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, apiKey: null },
		fetchImpl,
	});

	assert.equal("Authorization" in fetchImpl.calls[0].init.headers, false);
});

test("chat requests a JSON object response when json is set", async () => {
	const fetchImpl = fakeFetch(completion('{"text":"hi"}'));

	await openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, json: true, fetchImpl });

	assert.deepEqual(sentBody(fetchImpl).response_format, { type: "json_object" });
});

test("chat strips the name field, which many gateways reject", async () => {
	// Unlike OpenAI proper, a large share of compatible gateways 400 on `name`.
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiCompatibleProvider.chat({
		messages: [{ role: "user", content: "I attack", name: "Reginald" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).messages, [{ role: "user", content: "I attack" }]);
});

test("chat returns the assistant text", async () => {
	const fetchImpl = fakeFetch(completion("The tavern falls silent."));

	const result = await openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The tavern falls silent.");
	assert.equal(result.model, "meta-llama/llama-3.3-70b");
});

test("chat raises a bad_response error when the gateway returns no choices", async () => {
	const fetchImpl = fakeFetch({ choices: [] });

	await assert.rejects(
		() => openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("chat attributes failures to this provider, not to OpenAI", async () => {
	// The player configured "custom endpoint"; blaming OpenAI would send them
	// looking at the wrong dashboard.
	const fetchImpl = fakeFetch({ error: { message: "no such model" } }, 404);

	await assert.rejects(
		() => openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err.provider === "openai-compatible" && err.kind === "not_found"
	);
});

test("chat surfaces an unreachable endpoint as a network failure", async () => {
	const impl = async () => { throw new Error("connect ECONNREFUSED"); };

	await assert.rejects(
		() => openaiCompatibleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl: impl }),
		(err) => err.kind === "network" && /reach/i.test(err.userMessage())
	);
});

test("chat rejects an empty message list before making a request", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await assert.rejects(
		() => openaiCompatibleProvider.chat({ messages: [], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

// ── listModels ──────────────────────────────────────────────────────────────

test("listModels reads the standard models endpoint", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "llama-3.3-70b" }] });

	const models = await openaiCompatibleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.equal(fetchImpl.calls[0].url, "https://openrouter.ai/api/v1/models");
	assert.deepEqual(models, [{ id: "llama-3.3-70b", label: "llama-3.3-70b" }]);
});

test("listModels does not filter by model name", async () => {
	// The OpenAI filter assumes OpenAI's naming. A gateway may legitimately
	// serve a chat model called "tts-tuned-mistral", and guessing would hide it.
	const fetchImpl = fakeFetch({ data: [{ id: "tts-tuned-mistral" }, { id: "embedding-chat-v2" }] });

	const models = await openaiCompatibleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models.map(m => m.id), ["tts-tuned-mistral", "embedding-chat-v2"]);
});

test("listModels prefers a human-readable name when the gateway supplies one", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "meta-llama/llama-3.3-70b", name: "Llama 3.3 70B" }] });

	const models = await openaiCompatibleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "meta-llama/llama-3.3-70b", label: "Llama 3.3 70B" }]);
});

test("listModels tolerates a gateway that does not implement the endpoint", async () => {
	// Some minimal servers only implement /chat/completions. A missing model
	// list must degrade to "type the name yourself", not break configuration.
	const fetchImpl = fakeFetch({ error: { message: "not found" } }, 404);

	assert.deepEqual(await openaiCompatibleProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels still reports an authentication failure", async () => {
	// A 401 is actionable by the player; a 404 is not. Only the latter degrades.
	const fetchImpl = fakeFetch({ error: { message: "bad key" } }, 401);

	await assert.rejects(
		() => openaiCompatibleProvider.listModels({ config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "auth"
	);
});

test("listModels tolerates a response with no data field", async () => {
	const fetchImpl = fakeFetch({});

	assert.deepEqual(await openaiCompatibleProvider.listModels({ config: CONFIG, fetchImpl }), []);
});
