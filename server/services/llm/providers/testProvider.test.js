/**
 * Unit tests for the canned-response test provider.
 *
 * This provider backs dev-mode Quick Start: it returns pre-written DM responses
 * so the game loop can be exercised without spending anyone's tokens. It makes
 * no network request at all.
 *
 * Randomness is injected rather than reached for, so the selection logic is
 * testable and the tests are deterministic (TDD-8).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { testProvider } from "./testProvider.js";
import { LLMRequestError } from "../errors.js";

const CONFIG = { providerId: "test", apiKey: null, model: "test-stub", baseUrl: null };

/** A minimal stand-in for the canned response file. */
const RESPONSES = {
	setup: [
		{ text: "The tavern is warm.", music: "tavern", suggestions: ["Order a drink"] },
		{ text: "The pass is cold.", music: "exploration", suggestions: ["Cross the river"] },
	],
	action: [
		{ text: "__ACTIVE_PLAYER__ swings and misses.", music: "tense_battle", suggestions: ["Try again"] },
		{ text: "__ACTIVE_PLAYER__ finds a key.", music: "mystery", suggestions: ["Open the door"] },
	],
};

/** A fetch that fails loudly if the provider ever tries to use it. */
const forbiddenFetch = async () => { throw new Error("the test provider must not make network requests"); };

/**
 * @description Builds a deterministic stand-in for `Math.random`.
 * @param {number} value - The value the fake should always return.
 * @returns {Function} A random function returning `value`.
 */
function fixedRandom(value) {
	return () => value;
}

// ── Descriptor ──────────────────────────────────────────────────────────────

test("testProvider needs no credentials of any kind", () => {
	assert.equal(testProvider.id, "test");
	assert.equal(testProvider.requiresApiKey, false);
	assert.equal(testProvider.requiresBaseUrl, false);
	assert.equal(testProvider.defaultBaseUrl, null);
	assert.equal(testProvider.supportsImages, false);
});

// ── Adventure titles ────────────────────────────────────────────────────────

test("chat returns a bare title when asked to name an adventure", async () => {
	// The title prompt expects a plain string, not the JSON envelope.
	const result = await testProvider.chat({
		messages: [{ role: "system", content: "Generate a short adventure title of 3-5 words." }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(typeof result.text, "string");
	assert.throws(() => JSON.parse(result.text), "a title must not be JSON");
});

test("chat recognises the naming prompt by its other wording", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "system", content: "You are naming a Dungeons & Dragons adventure." }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.throws(() => JSON.parse(result.text));
});

// ── Setup versus action ─────────────────────────────────────────────────────

test("chat returns a setup scene for an opening prompt", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "system", content: "Write the opening scene for the party." }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "The tavern is warm.");
});

test("chat returns an action response for anything else", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "user", content: "I attack the goblin", name: "Reginald" }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).music, "tense_battle");
});

test("chat returns parseable JSON that carries the DM response fields", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "system", content: "opening scene" }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	const parsed = JSON.parse(result.text);
	assert.equal(parsed.music, "tavern");
	assert.deepEqual(parsed.suggestions, ["Order a drink"]);
});

// ── Selection is driven by the injected random ──────────────────────────────

test("chat selects the first canned response when random returns zero", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "system", content: "opening" }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "The tavern is warm.");
});

test("chat selects the last canned response when random approaches one", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "system", content: "opening" }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0.999),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "The pass is cold.");
});

// ── Player name substitution ────────────────────────────────────────────────

test("chat substitutes the acting player into the canned text", async () => {
	const result = await testProvider.chat({
		messages: [
			{ role: "system", content: "You are the DM" },
			{ role: "user", content: "I attack", name: "Reginald" },
		],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "Reginald swings and misses.");
});

test("chat uses the most recent user message for the player name", async () => {
	const result = await testProvider.chat({
		messages: [
			{ role: "user", content: "I wait", name: "Alice" },
			{ role: "assistant", content: "Nothing happens." },
			{ role: "user", content: "I attack", name: "Bob" },
		],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "Bob swings and misses.");
});

test("chat falls back to a generic name when no player name is present", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "user", content: "I attack" }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "Adventurer swings and misses.");
});

test("chat replaces every occurrence of the player placeholder", async () => {
	const responses = { setup: [], action: [{ text: "__ACTIVE_PLAYER__ trips. __ACTIVE_PLAYER__ falls." }] };

	const result = await testProvider.chat({
		messages: [{ role: "user", content: "I run", name: "Bob" }],
		config: CONFIG,
		responses,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(JSON.parse(result.text).text, "Bob trips. Bob falls.");
});

// ── Metadata and failure modes ──────────────────────────────────────────────

test("chat reports the stub model and no usage", async () => {
	const result = await testProvider.chat({
		messages: [{ role: "user", content: "I attack" }],
		config: CONFIG,
		responses: RESPONSES,
		random: fixedRandom(0),
		fetchImpl: forbiddenFetch,
	});

	assert.equal(result.model, "test-stub");
	assert.equal(result.usage, null);
});

test("chat rejects an empty message list", async () => {
	await assert.rejects(
		() => testProvider.chat({ messages: [], config: CONFIG, responses: RESPONSES, random: fixedRandom(0) }),
		(err) => err instanceof LLMRequestError && err.kind === "bad_request"
	);
});

test("chat raises a bad_response error when the requested pool is empty", async () => {
	// A truncated or mis-edited responses file should say so rather than
	// returning undefined into the JSON parser downstream.
	await assert.rejects(
		() => testProvider.chat({
			messages: [{ role: "system", content: "opening" }],
			config: CONFIG,
			responses: { setup: [], action: [] },
			random: fixedRandom(0),
		}),
		(err) => err instanceof LLMRequestError && err.kind === "bad_response"
	);
});

// ── listModels ──────────────────────────────────────────────────────────────

test("listModels offers the stub model without touching the network", async () => {
	const models = await testProvider.listModels({ config: CONFIG, fetchImpl: forbiddenFetch });

	assert.deepEqual(models, [{ id: "test-stub", label: "Canned responses (no API calls)" }]);
});
