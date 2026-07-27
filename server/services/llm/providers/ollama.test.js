/**
 * Unit tests for the Ollama provider adapter.
 *
 * Ollama is the local-model case: no key, a host address rather than a vendor
 * endpoint, and its own request shape (`/api/chat`, `/api/tags`) rather than the
 * OpenAI one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ollamaProvider } from "./ollama.js";
import { LLMRequestError } from "../errors.js";

const CONFIG = {
	providerId: "ollama",
	apiKey: null,
	model: "llama3.3",
	baseUrl: "http://localhost:11434",
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
 * @description Builds a minimal successful `/api/chat` payload.
 * @param {string} content - The assistant message content to return.
 * @returns {object} An Ollama-shaped response body.
 */
function reply(content) {
	return {
		message: { role: "assistant", content },
		done_reason: "stop",
		prompt_eval_count: 11,
		eval_count: 22,
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

test("ollamaProvider needs an address but no API key", () => {
	assert.equal(ollamaProvider.id, "ollama");
	assert.equal(ollamaProvider.requiresApiKey, false);
	assert.equal(ollamaProvider.requiresBaseUrl, true);
	assert.equal(ollamaProvider.defaultBaseUrl, "http://localhost:11434");
	assert.equal(ollamaProvider.supportsImages, false);
});

// ── chat ────────────────────────────────────────────────────────────────────

test("chat posts to the native chat endpoint", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(fetchImpl.calls[0].url, "http://localhost:11434/api/chat");
	assert.equal(fetchImpl.calls[0].init.method, "POST");
});

test("chat disables streaming, since the caller wants one complete reply", async () => {
	// Ollama streams by default, which would arrive as newline-delimited JSON
	// and fail to parse as a single object.
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(sentBody(fetchImpl).stream, false);
});

test("chat sends no Authorization header by default", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("Authorization" in fetchImpl.calls[0].init.headers, false);
});

test("chat sends bearer auth when the instance sits behind an auth proxy", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, apiKey: "test-key-DO-NOT-USE" },
		fetchImpl,
	});

	assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer test-key-DO-NOT-USE");
});

test("chat keeps system messages in the message list", async () => {
	// Unlike Anthropic, Ollama takes system as a role.
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({
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

test("chat strips the name field, which Ollama does not accept", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({
		messages: [{ role: "user", content: "I attack", name: "Reginald" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).messages, [{ role: "user", content: "I attack" }]);
});

test("chat requests JSON format when json is set", async () => {
	const fetchImpl = fakeFetch(reply('{"text":"hi"}'));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, json: true, fetchImpl });

	assert.equal(sentBody(fetchImpl).format, "json");
});

test("chat omits format when json is not requested", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("format" in sentBody(fetchImpl), false);
});

test("chat passes temperature through the options object", async () => {
	// Ollama nests sampling parameters under `options`, not at the top level.
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, temperature: 0.7, fetchImpl });

	assert.deepEqual(sentBody(fetchImpl).options, { temperature: 0.7 });
});

test("chat omits the options object entirely when nothing needs setting", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("options" in sentBody(fetchImpl), false);
});

test("chat maps maxTokens onto the num_predict option", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, maxTokens: 512, fetchImpl });

	assert.equal(sentBody(fetchImpl).options.num_predict, 512);
});

test("chat returns the assistant text with usage and stop reason", async () => {
	const fetchImpl = fakeFetch(reply("The tavern falls silent."));

	const result = await ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The tavern falls silent.");
	assert.equal(result.model, "llama3.3");
	assert.equal(result.finishReason, "stop");
	assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22 });
});

test("chat raises a bad_response error when the reply carries no content", async () => {
	const fetchImpl = fakeFetch({ message: { role: "assistant", content: "" } });

	await assert.rejects(
		() => ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("chat explains an unreachable instance as a network failure", async () => {
	// By far the most common Ollama problem: it simply is not running.
	const impl = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); };

	await assert.rejects(
		() => ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl: impl }),
		(err) => err.kind === "network" && err.provider === "ollama" && /running|reach/i.test(err.userMessage())
	);
});

test("chat surfaces an unknown model as a not_found failure", async () => {
	const fetchImpl = fakeFetch({ error: "model 'llama9' not found, try pulling it first" }, 404);

	await assert.rejects(
		() => ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err.kind === "not_found" && /llama9/.test(err.message)
	);
});

test("chat rejects an empty message list before making a request", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await assert.rejects(
		() => ollamaProvider.chat({ messages: [], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

test("chat rejects a call with no model from either source", async () => {
	const fetchImpl = fakeFetch(reply("hi"));

	await assert.rejects(
		() => ollamaProvider.chat({ messages: [{ role: "user", content: "hi" }], config: { ...CONFIG, model: null }, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
});

// ── listModels ──────────────────────────────────────────────────────────────

test("listModels reads the locally installed models from the tags endpoint", async () => {
	const fetchImpl = fakeFetch({ models: [{ name: "llama3.3:latest", model: "llama3.3:latest" }] });

	const models = await ollamaProvider.listModels({ config: CONFIG, fetchImpl });

	assert.equal(fetchImpl.calls[0].url, "http://localhost:11434/api/tags");
	assert.deepEqual(models, [{ id: "llama3.3:latest", label: "llama3.3:latest" }]);
});

test("listModels falls back to the name field when model is absent", async () => {
	const fetchImpl = fakeFetch({ models: [{ name: "mistral:7b" }] });

	const models = await ollamaProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "mistral:7b", label: "mistral:7b" }]);
});

test("listModels returns an empty list when nothing has been pulled yet", async () => {
	const fetchImpl = fakeFetch({ models: [] });

	assert.deepEqual(await ollamaProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels tolerates a response with no models field", async () => {
	const fetchImpl = fakeFetch({});

	assert.deepEqual(await ollamaProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels reports an unreachable instance rather than pretending it is empty", async () => {
	// An empty dropdown and a dead server are very different problems, and the
	// player needs to be told which one they have.
	const impl = async () => { throw new Error("connect ECONNREFUSED"); };

	await assert.rejects(
		() => ollamaProvider.listModels({ config: CONFIG, fetchImpl: impl }),
		(err) => err instanceof LLMRequestError && err.kind === "network"
	);
});
