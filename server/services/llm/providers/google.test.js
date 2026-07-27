/**
 * Unit tests for the Google Gemini provider adapter.
 *
 * Gemini's API diverges further from the others than any of them do from each
 * other: the model name is part of the URL path, messages are "contents" with
 * "parts", the assistant role is called "model", and the system prompt is a
 * separate `systemInstruction` object. Each of those translations is pinned
 * here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { googleProvider } from "./google.js";
import { LLMRequestError } from "../errors.js";

const FAKE_KEY = "test-key-DO-NOT-USE";
const NEWLINE = String.fromCharCode(10);

const CONFIG = {
	providerId: "google",
	apiKey: FAKE_KEY,
	model: "gemini-2.5-pro",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
 * @description Builds a minimal successful generateContent payload.
 * @param {string} text - The text part to return.
 * @returns {object} A Gemini-shaped response body.
 */
function generated(text) {
	return {
		candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
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

test("googleProvider declares its credential requirements", () => {
	assert.equal(googleProvider.id, "google");
	assert.equal(googleProvider.requiresApiKey, true);
	assert.equal(googleProvider.requiresBaseUrl, false);
	assert.equal(googleProvider.defaultBaseUrl, "https://generativelanguage.googleapis.com/v1beta");
	assert.equal(googleProvider.supportsImages, false);
});

// ── chat: request construction ──────────────────────────────────────────────

test("chat posts to a model-specific generateContent path", async () => {
	// Unlike every other provider, the model is part of the URL, not the body.
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(
		fetchImpl.calls[0].url,
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
	);
});

test("chat sends the key as a header rather than a query parameter", async () => {
	// A key in the query string lands in server access logs and proxy logs.
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	const { url, init } = fetchImpl.calls[0];
	assert.equal(init.headers["x-goog-api-key"], FAKE_KEY);
	assert.equal(url.includes(FAKE_KEY), false);
});

test("chat translates messages into contents with parts", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "I attack" }], config: CONFIG, fetchImpl });

	assert.deepEqual(sentBody(fetchImpl).contents, [{ role: "user", parts: [{ text: "I attack" }] }]);
});

test("chat renames the assistant role to model", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({
		messages: [
			{ role: "user", content: "I attack" },
			{ role: "assistant", content: "You miss." },
		],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).contents.map(c => c.role), ["user", "model"]);
});

test("chat lifts system messages into systemInstruction", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({
		messages: [
			{ role: "system", content: "You are the DM" },
			{ role: "user", content: "I attack" },
		],
		config: CONFIG,
		fetchImpl,
	});

	const body = sentBody(fetchImpl);
	assert.deepEqual(body.systemInstruction, { parts: [{ text: "You are the DM" }] });
	assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "I attack" }] }]);
});

test("chat joins multiple system messages with a blank line", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({
		messages: [
			{ role: "system", content: "You are the DM" },
			{ role: "system", content: "Be brutal" },
			{ role: "user", content: "hi" },
		],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(
		sentBody(fetchImpl).systemInstruction.parts[0].text,
		`You are the DM${NEWLINE}${NEWLINE}Be brutal`
	);
});

test("chat omits systemInstruction when there are no system messages", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("systemInstruction" in sentBody(fetchImpl), false);
});

test("chat substitutes an opening turn when only system prompts were given", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "system", content: "Open the scene" }], config: CONFIG, fetchImpl });

	assert.deepEqual(sentBody(fetchImpl).contents, [{ role: "user", parts: [{ text: "(begin)" }] }]);
});

test("chat strips the name field, which Gemini has no place for", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({
		messages: [{ role: "user", content: "I attack", name: "Reginald" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).contents, [{ role: "user", parts: [{ text: "I attack" }] }]);
});

test("chat requests a JSON mime type when json is set", async () => {
	const fetchImpl = fakeFetch(generated('{"text":"hi"}'));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, json: true, fetchImpl });

	assert.equal(sentBody(fetchImpl).generationConfig.responseMimeType, "application/json");
});

test("chat passes temperature through generationConfig", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, temperature: 0.7, fetchImpl });

	assert.equal(sentBody(fetchImpl).generationConfig.temperature, 0.7);
});

test("chat maps maxTokens onto maxOutputTokens", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, maxTokens: 512, fetchImpl });

	assert.equal(sentBody(fetchImpl).generationConfig.maxOutputTokens, 512);
});

test("chat omits generationConfig entirely when nothing needs setting", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("generationConfig" in sentBody(fetchImpl), false);
});

// ── chat: response handling ─────────────────────────────────────────────────

test("chat returns the candidate text with usage and finish reason", async () => {
	const fetchImpl = fakeFetch(generated("The tavern falls silent."));

	const result = await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The tavern falls silent.");
	assert.equal(result.model, "gemini-2.5-pro");
	assert.equal(result.finishReason, "STOP");
	assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22 });
});

test("chat concatenates every text part of the candidate", async () => {
	const fetchImpl = fakeFetch({
		candidates: [{ content: { parts: [{ text: "The door opens. " }, { text: "Something moves." }] }, finishReason: "STOP" }],
	});

	const result = await googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The door opens. Something moves.");
});

test("chat raises a bad_response error when a safety filter returns no parts", async () => {
	// Gemini signals a blocked response as a candidate with no content parts.
	const fetchImpl = fakeFetch({ candidates: [{ finishReason: "SAFETY" }] });

	await assert.rejects(
		() => googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response" && /SAFETY/.test(err.message)
	);
});

test("chat raises a bad_response error when there are no candidates at all", async () => {
	const fetchImpl = fakeFetch({ candidates: [] });

	await assert.rejects(
		() => googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("chat propagates an authentication failure", async () => {
	const fetchImpl = fakeFetch({ error: { message: "API key not valid" } }, 401);

	await assert.rejects(
		() => googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "auth" && err.provider === "google"
	);
});

test("chat rejects an empty message list before making a request", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await assert.rejects(
		() => googleProvider.chat({ messages: [], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

test("chat rejects a call with no model, since the model forms the URL", async () => {
	const fetchImpl = fakeFetch(generated("hi"));

	await assert.rejects(
		() => googleProvider.chat({ messages: [{ role: "user", content: "hi" }], config: { ...CONFIG, model: null }, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

// ── listModels ──────────────────────────────────────────────────────────────

test("listModels fetches the models endpoint with the key header", async () => {
	const fetchImpl = fakeFetch({ models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] });

	await googleProvider.listModels({ config: CONFIG, fetchImpl });

	const { url, init } = fetchImpl.calls[0];
	assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models");
	assert.equal(init.headers["x-goog-api-key"], FAKE_KEY);
});

test("listModels strips the models/ prefix from the returned id", async () => {
	// The API returns "models/gemini-2.5-pro" but generateContent wants the bare
	// id, and that id is what gets stored as the lobby's model setting.
	const fetchImpl = fakeFetch({
		models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] }],
	});

	const models = await googleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]);
});

test("listModels excludes models that cannot generate content", async () => {
	const fetchImpl = fakeFetch({
		models: [
			{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
			{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
		],
	});

	const models = await googleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models.map(m => m.id), ["gemini-2.5-pro"]);
});

test("listModels keeps a model that does not declare its methods", async () => {
	// Absent metadata should not silently hide a usable model.
	const fetchImpl = fakeFetch({ models: [{ name: "models/gemini-experimental" }] });

	const models = await googleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models.map(m => m.id), ["gemini-experimental"]);
});

test("listModels falls back to the id when no display name is given", async () => {
	const fetchImpl = fakeFetch({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] });

	const models = await googleProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "gemini-2.5-flash", label: "gemini-2.5-flash" }]);
});

test("listModels tolerates a response with no models field", async () => {
	const fetchImpl = fakeFetch({});

	assert.deepEqual(await googleProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels propagates an authentication failure", async () => {
	const fetchImpl = fakeFetch({ error: { message: "API key not valid" } }, 400);

	await assert.rejects(
		() => googleProvider.listModels({ config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError
	);
});
