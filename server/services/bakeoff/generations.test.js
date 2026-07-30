/**
 * Unit tests for the generation ("rung") grouping used by the descending sweep.
 *
 * The sweep walks newest to oldest and stops once a whole generation fails, so the
 * ordering *is* the method — get it wrong and the sweep abandons models that work, or
 * grinds through ancient ones it should have skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rungKeyOf, orderRungsNewestFirst } from "./generations.js";

// ── Rung keys ────────────────────────────────────────────────────────────────

test("size and flavour variants collapse onto their generation", () => {
	const cases = {
		"gpt-5.6-sol": "gpt-5.6",
		"gpt-5.6-luna": "gpt-5.6",
		"gpt-5.6-terra": "gpt-5.6",
		"ra-gpt-5.6-sol": "gpt-5.6",
		"gpt-5.5-pro": "gpt-5.5",
		"gpt-5.5": "gpt-5.5",
		"gpt-5.4-mini": "gpt-5.4",
		"gpt-5.4-nano": "gpt-5.4",
		"gpt-5.3-chat-latest": "gpt-5.3",
		"gpt-5-nano": "gpt-5",
		"gpt-5-chat-latest": "gpt-5",
		"gpt-4.1-mini": "gpt-4.1",
		"gpt-4o-mini": "gpt-4o",
		"gpt-4o": "gpt-4o",
	};
	for (const [id, rung] of Object.entries(cases)) {
		assert.equal(rungKeyOf(id), rung, `${id} should be in rung ${rung}`);
	}
});

test("the reasoning series keeps its own generations", () => {
	assert.equal(rungKeyOf("o4-mini"), "o4");
	assert.equal(rungKeyOf("o3"), "o3");
	assert.equal(rungKeyOf("o3-mini"), "o3");
	assert.equal(rungKeyOf("o1"), "o1");
	assert.equal(rungKeyOf("o1-pro"), "o1");
});

test("gpt-4-turbo is its own generation, not a variant of gpt-4", () => {
	assert.equal(rungKeyOf("gpt-4-turbo"), "gpt-4-turbo");
	assert.equal(rungKeyOf("gpt-4"), "gpt-4");
	assert.equal(rungKeyOf("gpt-4-0613"), "gpt-4");
});

test("the 3.5 snapshots collapse to one generation", () => {
	assert.equal(rungKeyOf("gpt-3.5-turbo"), "gpt-3.5");
	assert.equal(rungKeyOf("gpt-3.5-turbo-0125"), "gpt-3.5");
	assert.equal(rungKeyOf("gpt-3.5-turbo-16k"), "gpt-3.5");
});

test("a dated snapshot lands in the same rung as its alias", () => {
	assert.equal(rungKeyOf("gpt-5.5-2026-04-23"), "gpt-5.5");
	assert.equal(rungKeyOf("claude-haiku-4-5-20251001"), rungKeyOf("claude-haiku-4-5"));
});

test("an unrecognised id becomes its own rung rather than being lumped in", () => {
	assert.equal(rungKeyOf("chat-latest"), "chat-latest");
});

test("junk input does not throw", () => {
	for (const bad of [null, undefined, 42, "", "   ", {}]) {
		assert.equal(typeof rungKeyOf(bad), "string");
	}
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test("generations are ordered newest first using the catalogue's own dates", () => {
	const candidates = [
		{ provider: "openai", model: "gpt-5" },
		{ provider: "openai", model: "gpt-4o" },
		{ provider: "openai", model: "gpt-4.1" },
	];
	// The dated snapshots are the evidence: guessing recency from a version number is
	// how o3 ends up ranked against gpt-4.1 incorrectly.
	const catalogue = ["gpt-5-2025-08-07", "gpt-4o-2024-11-20", "gpt-4.1-2025-04-14"];
	const rungs = orderRungsNewestFirst(candidates, catalogue);
	assert.deepEqual(rungs.map((r) => r.rung), ["gpt-5", "gpt-4.1", "gpt-4o"]);
});

test("every candidate ends up in exactly one rung", () => {
	const candidates = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5", "gpt-5-mini", "o3", "gpt-4o"]
		.map((model) => ({ provider: "openai", model }));
	const rungs = orderRungsNewestFirst(candidates, []);
	const total = rungs.reduce((a, r) => a + r.models.length, 0);
	assert.equal(total, candidates.length);
	assert.equal(rungs.find((r) => r.rung === "gpt-5.6").models.length, 2);
});

test("an undated newer generation still sorts above a dated older one", () => {
	// gpt-5.6 publishes no dated snapshot, but it is plainly newer than gpt-5.5.
	const candidates = ["gpt-5.6-sol", "gpt-5.5"].map((model) => ({ provider: "openai", model }));
	const rungs = orderRungsNewestFirst(candidates, ["gpt-5.5-2026-04-23"]);
	assert.deepEqual(rungs.map((r) => r.rung), ["gpt-5.6", "gpt-5.5"]);
});

test("the real OpenAI field orders plausibly newest to oldest", () => {
	const models = [
		"gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-chat-latest", "gpt-5.2", "gpt-5.1",
		"gpt-5", "gpt-4.1", "o4-mini", "o3", "o1", "gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo",
	];
	const catalogue = [
		"gpt-5.5-2026-04-23", "gpt-5.4-2026-03-05", "gpt-5.2-2025-12-11", "gpt-5.1-2025-11-13",
		"gpt-5-2025-08-07", "gpt-4.1-2025-04-14", "o4-mini-2025-04-16", "o3-2025-04-16",
		"o1-2024-12-17", "gpt-4o-2024-11-20", "gpt-4-turbo-2024-04-09", "gpt-4-0613", "gpt-3.5-turbo-0125",
	];
	const order = orderRungsNewestFirst(models.map((m) => ({ provider: "openai", model: m })), catalogue)
		.map((r) => r.rung);

	const at = (rung) => order.indexOf(rung);
	assert.ok(at("gpt-5.6") < at("gpt-5.5"), `5.6 before 5.5: ${order.join(" > ")}`);
	assert.ok(at("gpt-5.5") < at("gpt-5.4"));
	assert.ok(at("gpt-5.4") < at("gpt-5.2"));
	assert.ok(at("gpt-5.2") < at("gpt-5.1"));
	assert.ok(at("gpt-5.1") < at("gpt-5"));
	assert.ok(at("gpt-5") < at("gpt-4.1"));
	assert.ok(at("gpt-4.1") < at("gpt-4o"), "4.1 (Apr 2025) is newer than 4o (Nov 2024)");
	assert.ok(at("o1") < at("gpt-4o"), `o1 (Dec 2024) is newer than 4o (Nov 2024): ${order.join(" > ")}`);
	assert.ok(at("gpt-4o") < at("gpt-4-turbo"));
	assert.ok(at("gpt-4-turbo") < at("gpt-4"));
	assert.ok(at("gpt-4") < at("gpt-3.5"));
	assert.equal(order.at(-1), "gpt-3.5", `oldest should be last: ${order.join(" > ")}`);
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("an empty candidate list yields no rungs", () => {
	assert.deepEqual(orderRungsNewestFirst([], []), []);
});

test("non-array inputs are tolerated", () => {
	for (const bad of [null, undefined, 42, {}, "models"]) {
		assert.deepEqual(orderRungsNewestFirst(bad, bad), []);
	}
});

test("candidates with no catalogue dates at all still produce a stable order", () => {
	const candidates = ["gpt-5", "gpt-4o", "gpt-3.5-turbo"].map((model) => ({ provider: "openai", model }));
	const a = orderRungsNewestFirst(candidates, []);
	const b = orderRungsNewestFirst(candidates, []);
	assert.deepEqual(a.map((r) => r.rung), b.map((r) => r.rung));
});

test("ordering does not mutate its inputs", () => {
	const candidates = [{ provider: "openai", model: "gpt-5" }];
	const catalogue = ["gpt-5-2025-08-07"];
	const before = JSON.stringify({ candidates, catalogue });
	orderRungsNewestFirst(candidates, catalogue);
	assert.equal(JSON.stringify({ candidates, catalogue }), before);
});
