/**
 * Unit tests for the OpenAI provider adapter.
 *
 * The adapter is exercised against a fake `fetch`, so these tests pin the exact
 * request that reaches OpenAI — URL, headers, and body — without a network or a
 * real key (CQ-5, TDD-8).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { openaiProvider } from "./openai.js";
import { LLMRequestError } from "../errors.js";

const FAKE_KEY = "test-key-DO-NOT-USE";

/** A normalized config as `normalizeLLMConfig` would produce it. */
const CONFIG = {
	providerId: "openai",
	apiKey: FAKE_KEY,
	model: "gpt-4o",
	baseUrl: "https://api.openai.com/v1",
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
	return {
		choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 11, completion_tokens: 22 },
	};
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

test("openaiProvider declares its credential requirements", () => {
	assert.equal(openaiProvider.id, "openai");
	assert.equal(openaiProvider.requiresApiKey, true);
	assert.equal(openaiProvider.requiresBaseUrl, false);
	assert.equal(openaiProvider.defaultBaseUrl, "https://api.openai.com/v1");
	assert.equal(openaiProvider.supportsImages, true);
});

// ── chat: request construction ──────────────────────────────────────────────

test("chat posts to the chat-completions endpoint with bearer auth", async () => {
	const fetchImpl = fakeFetch(completion("Once upon a time"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: CONFIG,
		fetchImpl,
	});

	const { url, init } = fetchImpl.calls[0];
	assert.equal(url, "https://api.openai.com/v1/chat/completions");
	assert.equal(init.method, "POST");
	assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
});

test("chat honours a custom base URL", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, baseUrl: "https://gateway.example.com/v1" },
		fetchImpl,
	});

	assert.equal(fetchImpl.calls[0].url, "https://gateway.example.com/v1/chat/completions");
});

test("chat sends the model from the explicit option over the one in config", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: CONFIG,
		model: "gpt-4o-mini",
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).model, "gpt-4o-mini");
});

test("chat falls back to the model stored in config", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(sentBody(fetchImpl).model, "gpt-4o");
});

test("chat requests a JSON object response when json is set", async () => {
	const fetchImpl = fakeFetch(completion('{"text":"hi"}'));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "reply in json" }],
		config: CONFIG,
		json: true,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).response_format, { type: "json_object" });
});

test("chat omits response_format when json is not requested", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("response_format" in sentBody(fetchImpl), false);
});

test("chat sends temperature when it is a finite number", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, temperature: 0.7, fetchImpl });

	assert.equal(sentBody(fetchImpl).temperature, 0.7);
});

test("chat omits temperature entirely when it is null", async () => {
	// Reasoning models reject an explicit temperature, so the caller must be
	// able to leave it off rather than being forced to a default.
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, temperature: null, fetchImpl });

	assert.equal("temperature" in sentBody(fetchImpl), false);
});

test("chat sends max_tokens only when a limit is supplied", async () => {
	const withLimit = fakeFetch(completion("hi"));
	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, maxTokens: 1024, fetchImpl: withLimit });
	assert.equal(sentBody(withLimit).max_tokens, 1024);

	const withoutLimit = fakeFetch(completion("hi"));
	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl: withoutLimit });
	assert.equal("max_tokens" in sentBody(withoutLimit), false);
});

test("chat forwards an abort signal", async () => {
	const fetchImpl = fakeFetch(completion("hi"));
	const controller = new AbortController();

	await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, signal: controller.signal, fetchImpl });

	assert.equal(fetchImpl.calls[0].init.signal, controller.signal);
});

// ── chat: message sanitisation ──────────────────────────────────────────────

test("chat sanitises player names into the identifier shape OpenAI accepts", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "I attack", name: "Sir Reginald <the Bold>" }],
		config: CONFIG,
		fetchImpl,
	});

	const [message] = sentBody(fetchImpl).messages;
	assert.equal(message.name, "Sir_Reginald_the_Bold");
});

test("chat leaves ordinary letters in a player name alone", async () => {
	// Regression guard: a malformed character class once matched the literal
	// letter "s", silently rewriting "Sisyphus" as "Si_yphu_".
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi", name: "Sisyphus" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).messages[0].name, "Sisyphus");
});

test("chat strips control characters from a player name", async () => {
	// Built from char codes rather than escapes so this file stays plain ASCII.
	const name = "Bob" + String.fromCharCode(1) + String.fromCharCode(127) + "Smith";
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi", name }],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).messages[0].name, "Bob_Smith");
});

test("chat preserves hyphens in player names", async () => {
	// OpenAI permits hyphens in `name`, and double-barrelled character names are
	// common. The pre-existing sanitiser kept them; this pins that behaviour so
	// the rewrite does not silently rename someone's character.
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi", name: "Jean-Luc" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).messages[0].name, "Jean-Luc");
});

test("chat truncates an over-long player name to 64 characters", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi", name: "A".repeat(100) }],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).messages[0].name.length, 64);
});

test("chat substitutes a fallback when a name sanitises to nothing", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "user", content: "hi", name: "!!!" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).messages[0].name, "Player");
});

test("chat omits the name field for messages that have none", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [{ role: "system", content: "You are the DM" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal("name" in sentBody(fetchImpl).messages[0], false);
});

test("chat passes system messages through unchanged", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await openaiProvider.chat({
		messages: [
			{ role: "system", content: "You are the DM" },
			{ role: "user", content: "I attack" },
		],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).messages, [
		{ role: "system", content: "You are the DM" },
		{ role: "user", content: "I attack" },
	]);
});

// ── chat: response handling ─────────────────────────────────────────────────

test("chat returns the assistant text with usage and finish reason", async () => {
	const fetchImpl = fakeFetch(completion("The tavern falls silent."));

	const result = await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The tavern falls silent.");
	assert.equal(result.model, "gpt-4o");
	assert.equal(result.finishReason, "stop");
	assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22 });
});

test("chat reports null usage when the provider omits it", async () => {
	const fetchImpl = fakeFetch({ choices: [{ message: { content: "hi" } }] });

	const result = await openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.usage, null);
});

test("chat raises a bad_response error when the reply contains no choices", async () => {
	const fetchImpl = fakeFetch({ choices: [] });

	await assert.rejects(
		() => openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("chat raises a bad_response error when the model returns null content", async () => {
	// A content filter refusal arrives as a well-formed choice with null content.
	const fetchImpl = fakeFetch({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] });

	await assert.rejects(
		() => openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("chat propagates an authentication failure from the HTTP layer", async () => {
	const fetchImpl = fakeFetch({ error: { message: "Incorrect API key provided" } }, 401);

	await assert.rejects(
		() => openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "auth" && err.provider === "openai"
	);
});

test("chat rejects an empty message list before making a request", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await assert.rejects(
		() => openaiProvider.chat({ messages: [], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

test("chat rejects a call with no model from either source", async () => {
	const fetchImpl = fakeFetch(completion("hi"));

	await assert.rejects(
		() => openaiProvider.chat({ messages: [{ role: "user", content: "hi" }], config: { ...CONFIG, model: null }, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

// ── listModels ──────────────────────────────────────────────────────────────

test("listModels fetches the models endpoint with bearer auth", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "gpt-4o", created: 100 }] });

	await openaiProvider.listModels({ config: CONFIG, fetchImpl });

	const { url, init } = fetchImpl.calls[0];
	assert.equal(url, "https://api.openai.com/v1/models");
	assert.equal(init.method, "GET");
	assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
});

test("listModels returns id and label pairs", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "gpt-4o", created: 100 }] });

	const models = await openaiProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "gpt-4o", label: "gpt-4o" }]);
});

test("listModels excludes models that cannot hold a conversation", async () => {
	// The account-wide model list mixes in embeddings, audio, and image models;
	// offering those in a DM picker would guarantee a confusing failure later.
	const fetchImpl = fakeFetch({
		data: [
			{ id: "gpt-4o", created: 500 },
			{ id: "text-embedding-3-large", created: 400 },
			{ id: "whisper-1", created: 300 },
			{ id: "tts-1-hd", created: 300 },
			{ id: "dall-e-3", created: 200 },
			{ id: "omni-moderation-latest", created: 100 },
		],
	});

	const models = await openaiProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models.map(m => m.id), ["gpt-4o"]);
});

test("listModels keeps reasoning models", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "o3-mini", created: 100 }, { id: "gpt-5-chat-latest", created: 200 }] });

	const models = await openaiProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models.map(m => m.id).sort(), ["gpt-5-chat-latest", "o3-mini"]);
});

test("listModels sorts the newest model first", async () => {
	const fetchImpl = fakeFetch({
		data: [
			{ id: "gpt-4-turbo", created: 100 },
			{ id: "gpt-5-chat-latest", created: 300 },
			{ id: "gpt-4o", created: 200 },
		],
	});

	const models = await openaiProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models.map(m => m.id), ["gpt-5-chat-latest", "gpt-4o", "gpt-4-turbo"]);
});

test("listModels returns an empty list when the account exposes no models", async () => {
	const fetchImpl = fakeFetch({ data: [] });

	assert.deepEqual(await openaiProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels tolerates a response with no data field", async () => {
	const fetchImpl = fakeFetch({});

	assert.deepEqual(await openaiProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels propagates an authentication failure", async () => {
	const fetchImpl = fakeFetch({ error: { message: "Invalid key" } }, 401);

	await assert.rejects(
		() => openaiProvider.listModels({ config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "auth"
	);
});
