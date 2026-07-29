/**
 * Tests for lobby pruning.
 *
 * @description 66 lobbies had accumulated and the landing page lists nearly all of them.
 *   Profiling showed the median age was **one day** and 12 had never been played, so this
 *   is not stale player data — it is integration-probe litter. The rule therefore has to
 *   be conservative enough to run against a directory that also holds real games.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { pruneVerdict, planPrune, STALE_DAYS, UNPLAYED_TURNS } from "./lobbyMaintenance.js";

const NOW = 1_800_000_000_000;
const daysAgo = (n) => NOW - n * 86_400_000;

/**
 * @description Builds a lobby record carrying only what the decision reads.
 * @param {object} [over] - Fields to override.
 * @returns {object} A lobby.
 */
function lobby(over = {}) {
	return {
		players: { Ayla: { name: "Ayla" } },
		history: Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `turn ${i}` })),
		lastActivity: daysAgo(1),
		...over,
	};
}

// ── What may go ──────────────────────────────────────────────────────────────

test("a lobby with no characters is disposable", () => {
	const verdict = pruneVerdict(lobby({ players: {} }), NOW);
	assert.equal(verdict.prune, true);
	assert.match(verdict.reason, /no characters/);
});

test("a lobby nobody ever played is disposable", () => {
	const verdict = pruneVerdict(lobby({ history: [{ role: "system" }] }), NOW);
	assert.equal(verdict.prune, true);
	assert.match(verdict.reason, /never played/);
});

test("the unplayed threshold is the opening turns, not one turn", () => {
	assert.equal(pruneVerdict(lobby({ history: new Array(UNPLAYED_TURNS).fill({}) }), NOW).prune, true);
	assert.equal(pruneVerdict(lobby({ history: new Array(UNPLAYED_TURNS + 1).fill({}) }), NOW).prune, false);
});

test("a long-abandoned lobby is disposable however much was played", () => {
	const verdict = pruneVerdict(lobby({ lastActivity: daysAgo(STALE_DAYS + 1) }), NOW);
	assert.equal(verdict.prune, true);
	assert.match(verdict.reason, /untouched/);
});

// ── What must survive ────────────────────────────────────────────────────────

test("a played lobby from yesterday is kept", () => {
	assert.equal(pruneVerdict(lobby(), NOW).prune, false);
});

test("a lobby exactly on the staleness boundary is kept", () => {
	// Off-by-one in the deleting direction is the expensive one.
	assert.equal(pruneVerdict(lobby({ lastActivity: daysAgo(STALE_DAYS) }), NOW).prune, false);
});

test("a record with no timestamp is kept rather than treated as ancient", () => {
	// Reading a missing date as "very old" is how a sweep deletes the thing you cared
	// about. An unparseable record is exactly the one worth keeping for inspection.
	const verdict = pruneVerdict(lobby({ lastActivity: undefined, createdAt: undefined }), NOW);
	assert.equal(verdict.prune, false);
	assert.match(verdict.reason, /no timestamp/);
});

test("an unreadable timestamp is kept, not guessed at", () => {
	for (const value of ["yesterday", NaN, -1, 0, {}, null]) {
		const verdict = pruneVerdict(lobby({ lastActivity: value, createdAt: undefined }), NOW);
		assert.equal(verdict.prune, false, `lastActivity ${JSON.stringify(value)} was pruned`);
	}
});

test("createdAt stands in when lastActivity is absent", () => {
	assert.equal(pruneVerdict(lobby({ lastActivity: undefined, createdAt: daysAgo(1) }), NOW).prune, false);
	assert.equal(pruneVerdict(lobby({ lastActivity: undefined, createdAt: daysAgo(STALE_DAYS + 5) }), NOW).prune, true);
});

test("an unreadable record is kept rather than throwing", () => {
	for (const value of [null, undefined, "lobby", 42, []]) {
		const verdict = pruneVerdict(value, NOW);
		assert.equal(verdict.prune, false, `${JSON.stringify(value)} was pruned`);
		assert.ok(verdict.reason);
	}
});

test("a lobby whose history is not an array counts as unplayed, not as a crash", () => {
	assert.equal(pruneVerdict(lobby({ history: "lots" }), NOW).prune, true);
});

// ── The plan ─────────────────────────────────────────────────────────────────

test("the plan separates what goes from what stays, keeping every id", () => {
	const plan = planPrune([
		{ id: "alive", lobby: lobby() },
		{ id: "empty", lobby: lobby({ players: {} }) },
		{ id: "unplayed", lobby: lobby({ history: [] }) },
	], NOW);
	assert.deepEqual(plan.prune.map((p) => p.id).sort(), ["empty", "unplayed"]);
	assert.deepEqual(plan.keep.map((p) => p.id), ["alive"]);
});

test("every entry carries a reason, so a dry run explains itself", () => {
	const plan = planPrune([{ id: "a", lobby: lobby() }, { id: "b", lobby: lobby({ players: {} }) }], NOW);
	for (const entry of [...plan.prune, ...plan.keep]) assert.ok(entry.reason, `${entry.id} had no reason`);
});

test("planning tolerates junk without losing the rest", () => {
	const plan = planPrune([null, { id: "ok", lobby: lobby() }, {}], NOW);
	assert.equal(plan.prune.length + plan.keep.length, 3);
	assert.ok(plan.keep.some((e) => e.id === "ok"));
});

test("planning a non-array yields an empty plan rather than throwing", () => {
	assert.deepEqual(planPrune(null, NOW), { prune: [], keep: [] });
	assert.deepEqual(planPrune(undefined, NOW), { prune: [], keep: [] });
});

test("the same input always yields the same plan", () => {
	// The clock is injected precisely so this holds (`TDD-8`).
	const entries = [{ id: "a", lobby: lobby() }, { id: "b", lobby: lobby({ players: {} }) }];
	assert.deepEqual(planPrune(entries, NOW), planPrune(entries, NOW));
});
