/**
 * Unit tests for the Anthropic provider adapter.
 *
 * Anthropic's API differs from OpenAI's in ways that have to be handled rather
 * than hoped for: `system` is a top-level parameter, `max_tokens` is mandatory,
 * messages carry no `name`, and the reply is a list of content blocks. These
 * tests pin each of those translations.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { anthropicProvider, DEFAULT_MAX_TOKENS } from "./anthropic.js";
import { LLMRequestError } from "../errors.js";

const FAKE_KEY = "test-key-DO-NOT-USE";
const NEWLINE = String.fromCharCode(10);

const CONFIG = {
	providerId: "anthropic",
	apiKey: FAKE_KEY,
	model: "claude-sonnet-4-6",
	baseUrl: "https://api.anthropic.com/v1",
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
 * @description Builds a minimal successful messages payload.
 * @param {string} text - The text block content to return.
 * @returns {object} An Anthropic-shaped response body.
 */
function message(text) {
	return {
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		usage: { input_tokens: 11, output_tokens: 22 },
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

test("anthropicProvider declares its credential requirements", () => {
	assert.equal(anthropicProvider.id, "anthropic");
	assert.equal(anthropicProvider.requiresApiKey, true);
	assert.equal(anthropicProvider.requiresBaseUrl, false);
	assert.equal(anthropicProvider.defaultBaseUrl, "https://api.anthropic.com/v1");
	assert.equal(anthropicProvider.supportsImages, false);
});

// ── chat: request construction ──────────────────────────────────────────────

test("chat posts to the messages endpoint with the x-api-key and version headers", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	const { url, init } = fetchImpl.calls[0];
	assert.equal(url, "https://api.anthropic.com/v1/messages");
	assert.equal(init.method, "POST");
	assert.equal(init.headers["x-api-key"], FAKE_KEY);
	assert.equal(init.headers["anthropic-version"], "2023-06-01");
	assert.equal("Authorization" in init.headers, false);
});

test("chat always sends max_tokens because Anthropic requires it", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(sentBody(fetchImpl).max_tokens, DEFAULT_MAX_TOKENS);
});

test("the default output budget leaves a thinking model room to answer", () => {
	// This assertion replaces one that pinned the default at 4096. That number was not
	// merely inconvenient, it was wrong: on models that reason before replying —
	// Sonnet 5 and Opus 5 do so by default when the request omits `thinking` —
	// `max_tokens` caps reasoning *and* prose together. A live game burned 2,938 of
	// 4,096 tokens reasoning, leaving 275 for the narration; two turns later the
	// reasoning consumed the lot and the DM returned no prose at all.
	//
	// The floor is the observed worst case (~3k reasoning) plus room for the longest
	// narration we ask for, with headroom. Anthropic bills what is produced, not what
	// is reserved, so a generous ceiling costs nothing on turns that stay short.
	assert.ok(DEFAULT_MAX_TOKENS >= 12000,
		`a budget of ${DEFAULT_MAX_TOKENS} leaves too little for prose once reasoning is paid for`);
});

test("a reply truncated before any prose says so, and says what to do", async () => {
	// The bare "no usable content" this used to raise sent the operator looking at the
	// model when the fault was our own request budget.
	const fetchImpl = fakeFetch({
		content: [{ type: "thinking", thinking: "" }],
		stop_reason: "max_tokens",
		usage: { input_tokens: 13596, output_tokens: 4096 },
	});

	await assert.rejects(
		() => anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => {
			assert.match(err.message, /max_tokens/, "it must name the stop reason");
			assert.match(err.message, /reasoning|thinking/i, "and where the budget went");
			return true;
		});
});

test("chat asks a reasoning model for moderate effort rather than the default", async () => {
	// Reasoning effort defaults to `high` on these models, which bought the DM 2,935
	// tokens of deliberation and a 37-second turn — and one turn that ran past the
	// 60-second cap and lost its narration entirely. A game narrating to a table in
	// real time wants a decision it can wait for, not the most considered one.
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, model: "claude-sonnet-5" },
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).output_config?.effort, "medium");
});

test("chat says nothing about effort to a model that predates it", async () => {
	// `output_config` is rejected by models older than the 4.6 generation, and the model
	// is chosen by the operator from a dropdown that still lists them. Sending it
	// unconditionally would turn a working game into a 400 on every turn.
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, model: "claude-3-5-sonnet-20241022" },
		fetchImpl,
	});

	assert.equal("output_config" in sentBody(fetchImpl), false);
});

test("chat honours an explicit effort", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, model: "claude-opus-5" },
		effort: "low",
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).output_config.effort, "low");
});

test("an explicit effort is still withheld from a model that would reject it", async () => {
	// Otherwise a caller asking for cheap reasoning would break the older models
	// outright, which is the opposite of what they asked for.
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, model: "claude-3-5-sonnet-20241022" },
		effort: "low",
		fetchImpl,
	});

	assert.equal("output_config" in sentBody(fetchImpl), false);
});

test("chat honours an explicit max_tokens", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, maxTokens: 512, fetchImpl });

	assert.equal(sentBody(fetchImpl).max_tokens, 512);
});

test("chat lifts system messages into the top-level system parameter", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [
			{ role: "system", content: "You are the DM" },
			{ role: "user", content: "I attack" },
		],
		config: CONFIG,
		fetchImpl,
	});

	const body = sentBody(fetchImpl);
	assert.equal(body.system, "You are the DM");
	assert.deepEqual(body.messages, [{ role: "user", content: "I attack" }]);
});

test("chat joins multiple system messages with a blank line", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [
			{ role: "system", content: "You are the DM" },
			{ role: "system", content: "Be brutal" },
			{ role: "user", content: "I attack" },
		],
		config: CONFIG,
		fetchImpl,
	});

	assert.equal(sentBody(fetchImpl).system, `You are the DM${NEWLINE}${NEWLINE}Be brutal`);
});

test("chat omits the system parameter when there are no system messages", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal("system" in sentBody(fetchImpl), false);
});

test("chat strips the name field, which Anthropic does not accept", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "user", content: "I attack", name: "Reginald" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).messages, [{ role: "user", content: "I attack" }]);
});

test("chat substitutes an opening user message when only system prompts were given", async () => {
	// Lobby setup sends nothing but a system prompt, and Anthropic rejects an
	// empty message list.
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "system", content: "Open the scene" }],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).messages, [{ role: "user", content: "(begin)" }]);
});

test("chat prepends a user turn when the conversation starts with the assistant", async () => {
	// A lobby resumed from history can begin with the DM's last narration.
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [
			{ role: "assistant", content: "The door creaks open." },
			{ role: "user", content: "I step through" },
		],
		config: CONFIG,
		fetchImpl,
	});

	const { messages } = sentBody(fetchImpl);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[1].content, "The door creaks open.");
});

test("chat merges consecutive messages from the same role", async () => {
	// Several players can act before the DM replies; Anthropic wants strictly
	// alternating turns.
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [
			{ role: "user", content: "I attack" },
			{ role: "user", content: "I also attack" },
			{ role: "assistant", content: "Roll for it." },
		],
		config: CONFIG,
		fetchImpl,
	});

	assert.deepEqual(sentBody(fetchImpl).messages, [
		{ role: "user", content: `I attack${NEWLINE}${NEWLINE}I also attack` },
		{ role: "assistant", content: "Roll for it." },
	]);
});

test("chat sends temperature when it is a finite number", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, temperature: 0.7, fetchImpl });

	assert.equal(sentBody(fetchImpl).temperature, 0.7);
});

test("chat omits temperature when it is null", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, temperature: null, fetchImpl });

	assert.equal("temperature" in sentBody(fetchImpl), false);
});

test("chat does not send response_format, which Anthropic has no concept of", async () => {
	// JSON steering for this provider lives in the prompt, not in a parameter.
	const fetchImpl = fakeFetch(message('{"text":"hi"}'));

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, json: true, fetchImpl });

	assert.equal("response_format" in sentBody(fetchImpl), false);
});

test("chat honours a custom base URL", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await anthropicProvider.chat({
		messages: [{ role: "user", content: "hi" }],
		config: { ...CONFIG, baseUrl: "https://gateway.example.com/v1" },
		fetchImpl,
	});

	assert.equal(fetchImpl.calls[0].url, "https://gateway.example.com/v1/messages");
});

test("chat forwards an abort signal", async () => {
	const fetchImpl = fakeFetch(message("hi"));
	const controller = new AbortController();

	await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, signal: controller.signal, fetchImpl });

	assert.equal(fetchImpl.calls[0].init.signal, controller.signal);
});

// ── chat: response handling ─────────────────────────────────────────────────

test("chat returns the text block with usage and stop reason", async () => {
	const fetchImpl = fakeFetch(message("The tavern falls silent."));

	const result = await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The tavern falls silent.");
	assert.equal(result.model, "claude-sonnet-4-6");
	assert.equal(result.finishReason, "end_turn");
	assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 22 });
});

test("chat concatenates every text block in the reply", async () => {
	// A long narration can arrive split across blocks; taking only the first
	// would silently truncate the DM mid-sentence.
	const fetchImpl = fakeFetch({
		content: [
			{ type: "text", text: "The door opens. " },
			{ type: "text", text: "Something moves inside." },
		],
		stop_reason: "end_turn",
	});

	const result = await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "The door opens. Something moves inside.");
});

test("chat ignores non-text content blocks", async () => {
	const fetchImpl = fakeFetch({
		content: [
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "You see a door." },
		],
		stop_reason: "end_turn",
	});

	const result = await anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl });

	assert.equal(result.text, "You see a door.");
});

test("chat raises a bad_response error when the reply has no text blocks", async () => {
	const fetchImpl = fakeFetch({ content: [], stop_reason: "end_turn" });

	await assert.rejects(
		() => anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

test("chat propagates an authentication failure", async () => {
	const fetchImpl = fakeFetch({ error: { message: "invalid x-api-key" } }, 401);

	await assert.rejects(
		() => anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "auth" && err.provider === "anthropic"
	);
});

test("chat rejects an empty message list before making a request", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await assert.rejects(
		() => anthropicProvider.chat({ messages: [], config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

test("chat rejects a call with no model from either source", async () => {
	const fetchImpl = fakeFetch(message("hi"));

	await assert.rejects(
		() => anthropicProvider.chat({ messages: [{ role: "user", content: "hi" }], config: { ...CONFIG, model: null }, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
	assert.equal(fetchImpl.calls.length, 0);
});

// ── listModels ──────────────────────────────────────────────────────────────

test("listModels fetches the models endpoint with the key and version headers", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] });

	await anthropicProvider.listModels({ config: CONFIG, fetchImpl });

	const { url, init } = fetchImpl.calls[0];
	assert.equal(url, "https://api.anthropic.com/v1/models");
	assert.equal(init.method, "GET");
	assert.equal(init.headers["x-api-key"], FAKE_KEY);
	assert.equal(init.headers["anthropic-version"], "2023-06-01");
});

test("listModels prefers the provider display name as the label", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }] });

	const models = await anthropicProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }]);
});

test("listModels falls back to the id when no display name is given", async () => {
	const fetchImpl = fakeFetch({ data: [{ id: "claude-opus-4-6" }] });

	const models = await anthropicProvider.listModels({ config: CONFIG, fetchImpl });

	assert.deepEqual(models, [{ id: "claude-opus-4-6", label: "claude-opus-4-6" }]);
});

test("listModels tolerates a response with no data field", async () => {
	const fetchImpl = fakeFetch({});

	assert.deepEqual(await anthropicProvider.listModels({ config: CONFIG, fetchImpl }), []);
});

test("listModels propagates an authentication failure", async () => {
	const fetchImpl = fakeFetch({ error: { message: "invalid x-api-key" } }, 401);

	await assert.rejects(
		() => anthropicProvider.listModels({ config: CONFIG, fetchImpl }),
		(err) => err instanceof LLMRequestError && err.kind === "auth"
	);
});
