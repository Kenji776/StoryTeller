/**
 * Unit tests for selectCandidates — which of a provider's models are worth
 * spending a game on.
 *
 * This filter decides what gets evaluated at all, so a bug here silently omits a
 * model from the report and nobody notices. Hence the coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCandidates, isChatCapable, EXCLUSION_REASONS } from "./candidates.js";

// ── Non-chat models are excluded ─────────────────────────────────────────────

test("models that cannot hold a chat completion are rejected", () => {
	for (const id of [
		"sora-2", "sora-2-pro", "dall-e-3", "tts-1-hd", "whisper-1",
		"text-embedding-3-large", "omni-moderation-latest",
		"gpt-3.5-turbo-instruct", "gpt-4o-audio-preview", "gpt-4o-realtime-preview",
		"gpt-4o-transcribe", "gpt-image-1", "o4-mini-deep-research",
		"gpt-4o-search-preview", "gpt-5-search-api",
	]) {
		assert.equal(isChatCapable(id), false, `${id} should be rejected`);
	}
});

test("ordinary chat models are accepted", () => {
	for (const id of [
		"gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "gpt-5.6-sol", "gpt-4.1-nano",
		"o1", "o3-mini", "o4-mini", "chat-latest", "gpt-5.3-chat-latest",
		"claude-opus-5", "claude-haiku-4-5-20251001",
		"qwen3.6:latest", "llama3.2-vision:11b",
	]) {
		assert.equal(isChatCapable(id), true, `${id} should be accepted`);
	}
});

test("a search-tuned model is rejected even though its family is chat-capable", () => {
	assert.equal(isChatCapable("gpt-4o-mini-search-preview-2025-03-11"), false);
});

// ── Date-pinned duplicates are collapsed ─────────────────────────────────────

test("a date-pinned snapshot is dropped when its floating alias is present", () => {
	const r = selectCandidates("openai", ["gpt-5.5", "gpt-5.5-2026-04-23"]);
	assert.deepEqual(r.selected.map((c) => c.model), ["gpt-5.5"]);
	assert.equal(r.excluded.find((e) => e.model === "gpt-5.5-2026-04-23").reason, EXCLUSION_REASONS.DUPLICATE);
});

test("a date-pinned snapshot is kept when it is the only way to reach that model", () => {
	const r = selectCandidates("anthropic", ["claude-haiku-4-5-20251001", "claude-opus-5"]);
	assert.deepEqual(r.selected.map((c) => c.model).sort(), ["claude-haiku-4-5-20251001", "claude-opus-5"]);
});

test("several snapshots of one alias all collapse onto it", () => {
	const r = selectCandidates("openai", ["gpt-4o", "gpt-4o-2024-11-20", "gpt-4o-2024-08-06", "gpt-4o-2024-05-13"]);
	assert.deepEqual(r.selected.map((c) => c.model), ["gpt-4o"]);
	assert.equal(r.excluded.length, 3);
});

test("a pro or mini variant is its own model, not a duplicate of its base", () => {
	const r = selectCandidates("openai", ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"]);
	assert.equal(r.selected.length, 4);
});

// ── Shape of the result ──────────────────────────────────────────────────────

test("each candidate carries the provider it belongs to", () => {
	const r = selectCandidates("ollama", ["qwen3.6:latest"]);
	assert.deepEqual(r.selected, [{ provider: "ollama", model: "qwen3.6:latest" }]);
});

test("selection is stable in the order the provider listed them", () => {
	const r = selectCandidates("openai", ["gpt-5", "gpt-4o", "o3"]);
	assert.deepEqual(r.selected.map((c) => c.model), ["gpt-5", "gpt-4o", "o3"]);
});

test("every input is accounted for as either selected or excluded", () => {
	const ids = ["gpt-4o", "gpt-4o-2024-08-06", "sora-2", "tts-1", "o3"];
	const r = selectCandidates("openai", ids);
	assert.equal(r.selected.length + r.excluded.length, ids.length);
});

test("an exclusion always names a reason", () => {
	const r = selectCandidates("openai", ["sora-2", "gpt-4o", "gpt-4o-2024-08-06"]);
	assert.ok(r.excluded.length > 0);
	for (const e of r.excluded) {
		assert.ok(Object.values(EXCLUSION_REASONS).includes(e.reason), `bad reason ${e.reason}`);
	}
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("an empty catalogue selects nothing without throwing", () => {
	const r = selectCandidates("openai", []);
	assert.deepEqual(r.selected, []);
	assert.deepEqual(r.excluded, []);
});

test("non-array and malformed catalogues are tolerated", () => {
	for (const bad of [null, undefined, 42, "gpt-4o", {}]) {
		const r = selectCandidates("openai", bad);
		assert.deepEqual(r.selected, [], `input ${JSON.stringify(bad)}`);
	}
});

test("blank and non-string entries are excluded rather than selected", () => {
	const r = selectCandidates("openai", ["gpt-4o", "", "   ", null, 42]);
	assert.deepEqual(r.selected.map((c) => c.model), ["gpt-4o"]);
	assert.equal(r.excluded.length, 4);
});

test("duplicate identical ids are collapsed to one candidate", () => {
	const r = selectCandidates("openai", ["gpt-4o", "gpt-4o"]);
	assert.equal(r.selected.length, 1);
});

test("isChatCapable tolerates junk input", () => {
	for (const bad of [null, undefined, 42, "", "   ", {}]) {
		assert.equal(isChatCapable(bad), false);
	}
});

// ── Properties ───────────────────────────────────────────────────────────────

test("selection is deterministic and does not mutate the catalogue", () => {
	const ids = ["gpt-5", "gpt-5-2025-08-07", "sora-2"];
	const before = JSON.stringify(ids);
	const a = selectCandidates("openai", ids);
	const b = selectCandidates("openai", ids);
	assert.deepEqual(a, b);
	assert.equal(JSON.stringify(ids), before);
});

test("no selected model is ever one that isChatCapable rejects", () => {
	const ids = ["gpt-4o", "sora-2", "tts-1", "o3", "gpt-3.5-turbo-instruct", "claude-opus-5"];
	for (const c of selectCandidates("openai", ids).selected) {
		assert.equal(isChatCapable(c.model), true, `${c.model} slipped through`);
	}
});
