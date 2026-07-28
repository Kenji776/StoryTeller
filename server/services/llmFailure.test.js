/**
 * Tests for recognising a failed LLM call.
 *
 * @description Both provider adapters catch their exceptions and return an error
 *   *string* — "[Error: LLM unavailable or failed to respond]" — in the same channel
 *   as real narration. Callers cannot tell the two apart, so when a lobby opened
 *   against a provider whose key was invalid, that sentence was published to every
 *   player as the opening narration, stored as the adventure's name, written into
 *   the durable story log, and the turn timer started on top of it. No incident was
 *   raised and nothing was retried; the game simply played on with an error message
 *   as its plot.
 *
 *   Recognising the sentinels is the narrow fix. Returning them at all is the
 *   design fault, recorded in ADR 0009.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isLLMFailure } from "./llmFailure.js";

// ===== The sentinels the adapters actually return =====

test("the unavailable-provider sentinel is recognised", () => {
	assert.equal(isLLMFailure("[Error: LLM unavailable or failed to respond]"), true);
});

test("the empty-content sentinel is recognised", () => {
	assert.equal(isLLMFailure("[Error: no content returned]"), true);
});

test("both missing-key stubs are recognised", () => {
	assert.equal(isLLMFailure("[Stubbed LLM] No OpenAI key configured."), true);
	assert.equal(isLLMFailure("[Stubbed LLM] No Claude API key configured."), true);
});

test("a sentinel is recognised despite surrounding whitespace", () => {
	assert.equal(isLLMFailure("  [Error: LLM unavailable or failed to respond]\n"), true);
});

test("a sentinel wrapped in JSON by a repair pass is still recognised", () => {
	// parseDMJson re-asks the model to repair malformed output; a failure there can
	// arrive already wrapped.
	assert.equal(isLLMFailure('{"text":"[Error: LLM unavailable or failed to respond]"}'), true);
});

// ===== Real narration must never be mistaken for a failure =====

test("ordinary narration is not a failure", () => {
	assert.equal(isLLMFailure("The door groans open. Torchlight spills across wet stone."), false);
});

test("narration that merely mentions an error is not a failure", () => {
	// The word "error" appears in fiction. Matching on it would silence real turns.
	assert.equal(isLLMFailure("Brannor realises his error too late — the rope is already cut."), false);
	assert.equal(isLLMFailure("A stubbed toe is the least of Orrin's problems."), false);
});

test("narration quoting a bracketed aside is not a failure", () => {
	assert.equal(isLLMFailure("[The party hears a distant bell.] Sylvie freezes."), false);
});

test("a long passage containing the word unavailable is not a failure", () => {
	assert.equal(isLLMFailure("The bridge is unavailable to you; the planks have rotted through."), false);
});

// ===== Boundaries =====

test("empty and blank replies count as failures", () => {
	// An empty reply is already handled separately upstream, but it is never valid
	// narration, and callers should be able to ask one question rather than two.
	for (const blank of ["", "   ", "\n\t"]) assert.equal(isLLMFailure(blank), true, JSON.stringify(blank));
});

test("a non-string reply counts as a failure rather than throwing", () => {
	for (const bad of [null, undefined, 42, {}, [], true]) {
		assert.equal(isLLMFailure(bad), true, JSON.stringify(bad));
	}
});
