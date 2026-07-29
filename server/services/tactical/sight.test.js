/**
 * Tests for line of sight and cover.
 *
 * @description The fixture arena, for reading these by eye:
 *
 * ```
 *      A  B  C  D  E  F  G  H
 *   1  H  .  .  .  .  .  .  X     # wall     blocks sight, full cover
 *   2  .  .  #  .  .  .  .  .     o pillar   blocks sight, half cover
 *   3  .  .  #  .  o  .  .  .     = low wall seen over,    half cover
 *   4  .  .  .  .  .  .  .  .     ~ rubble   seen over,    no cover
 *   5  .  ~  ~  .  =  =  .  .     X pit      seen over,    no cover
 *   6  .  .  .  .  .  .  .  G
 * ```
 *
 *   The awkward case these pin down: a pillar blocks sight, so its half cover can never be
 *   earned by the line passing *through* it — that would already be no line of sight at
 *   all. Half cover from a pillar has to come from standing *beside* it, on the attacker's
 *   side, which is exactly what "behind a pillar" means to a player.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { cellsOnLine, hasLineOfSight, coverBetween, coverACBonus } from "./sight.js";
import { cellLabel } from "./grid.js";
import { arena, emptyRoom } from "./mapFixtures.js";

/**
 * @description Renders a line as labels, so a failure reads as cells rather than as nested
 *   arrays of numbers.
 * @param {number[][]} cells - The line.
 * @returns {string} Comma-separated labels.
 */
const labels = (cells) => cells.map(cellLabel).join(",");

// ── The line itself ─────────────────────────────────────────────────────────

test("a line between neighbouring cells crosses nothing in between", () => {
	assert.deepEqual(cellsOnLine([0, 0], [1, 0]), []);
});

test("a straight run lists the cells between, in order, excluding both ends", () => {
	// Ordering is load-bearing: the first blocker along the line is what stops sight, and a
	// caller that wants to name it needs them near-to-far.
	assert.equal(labels(cellsOnLine([0, 0], [4, 0])), "B1,C1,D1");
	assert.equal(labels(cellsOnLine([0, 0], [0, 3])), "A2,A3");
});

test("a line read backwards crosses the same cells", () => {
	const forward = cellsOnLine([1, 1], [6, 4]).map(cellLabel).sort();
	const backward = cellsOnLine([6, 4], [1, 1]).map(cellLabel).sort();
	assert.deepEqual(forward, backward);
});

test("a cell to itself crosses nothing", () => {
	assert.deepEqual(cellsOnLine([3, 3], [3, 3]), []);
});

test("a diagonal includes the cells it clips the corners of", () => {
	// Deliberately conservative: the segment from the centre of A1 to the centre of C3
	// passes exactly through the corners of B1 and A2, and both are counted. The effect is
	// that you cannot see through the joint between two diagonally-placed pillars, which is
	// the safer reading of a famously ambiguous case and is a house rule stated out loud
	// rather than an accident of rounding.
	const crossed = cellsOnLine([0, 0], [2, 2]).map(cellLabel);
	assert.ok(crossed.includes("B2"), "the cell the line runs through");
	assert.ok(crossed.includes("B1") && crossed.includes("A2"), "and the corners it clips");
});

test("a malformed endpoint yields no line rather than throwing", () => {
	assert.deepEqual(cellsOnLine(null, [1, 1]), []);
	assert.deepEqual(cellsOnLine([1, 1], "D4"), []);
});

// ── Line of sight ───────────────────────────────────────────────────────────

test("an open row is seen along", () => {
	assert.equal(hasLineOfSight(arena(), [0, 3], [7, 3]), true);
});

test("a wall between two cells stops sight", () => {
	// A2 to E2 runs through the wall at C2.
	assert.equal(hasLineOfSight(arena(), [0, 1], [4, 1]), false);
});

test("a pillar between two cells stops sight", () => {
	assert.equal(hasLineOfSight(arena(), [3, 2], [5, 2]), false);
});

test("a low wall is seen over", () => {
	// The whole reason `sight` and `movement` are separate properties.
	assert.equal(hasLineOfSight(arena(), [3, 4], [6, 4]), true);
});

test("sight is mutual", () => {
	// Anything else would let one side shoot from safety, and it would be invisible in the
	// prompt because each side is described from its own point of view.
	const map = arena();
	for (const [a, b] of [[[0, 1], [4, 1]], [[0, 3], [7, 3]], [[3, 4], [6, 4]], [[1, 1], [6, 5]]]) {
		assert.equal(hasLineOfSight(map, a, b), hasLineOfSight(map, b, a), `${labels([a, b])}`);
	}
});

test("neighbouring cells always see each other, even round a corner", () => {
	// D3 and C4 are diagonally adjacent and the wall at C3 clips the corner between them.
	// Being unable to see a creature you are standing next to would be absurd, and it is
	// the one place the conservative corner rule has to give way.
	assert.equal(hasLineOfSight(arena(), [3, 2], [2, 3]), true);
});

test("a cell sees itself", () => {
	assert.equal(hasLineOfSight(arena(), [3, 3], [3, 3]), true);
});

test("sight off the edge of the map is denied", () => {
	assert.equal(hasLineOfSight(arena(), [0, 0], [99, 99]), false);
});

// ── Cover ───────────────────────────────────────────────────────────────────

test("open ground offers nothing", () => {
	assert.equal(coverBetween(arena(), [0, 3], [7, 3]), "none");
	assert.equal(coverBetween(emptyRoom(), [0, 0], [5, 5]), "none");
});

test("a target with no line of sight cannot be picked out at all", () => {
	// Reported as full cover rather than as a separate "no target" state, so a caller has
	// one thing to read and full cover already means untargetable.
	assert.equal(coverBetween(arena(), [0, 1], [4, 1]), "full");
});

test("shooting over a low wall gives the target half cover", () => {
	// E4 down to E6, across the low wall at E5. Sight is clear, so the cover the line
	// crosses is what counts.
	assert.equal(coverBetween(arena(), [4, 3], [4, 5]), "half");
});

test("standing beside a pillar gives half cover against someone in front of it", () => {
	// F4 attacked from F1. The pillar at E3 is not on the line — if it were there would be
	// no shot at all — but it is adjacent to the target on the attacker's side, which is
	// what a player means by taking cover behind it.
	assert.equal(coverBetween(arena(), [5, 0], [5, 3]), "half");
});

test("scenery on the wrong side of the target grants nothing", () => {
	// The same pillar, approached from H4: E3 now sits behind the target, and cover you are
	// not sheltering behind is not cover.
	//
	// Attacking F4 from F6 would be the obvious way to write this and it is wrong — the low
	// wall at F5 lies directly between, so half cover is the correct answer there and the
	// test would have been asserting a bug.
	assert.equal(coverBetween(arena(), [7, 3], [5, 3]), "none");
});

test("a full-cover feature beside the target still only gives half", () => {
	// The altar cell D4, attacked from D3, with the wall at C3 diagonally beside the target.
	// The line itself runs clear down the D column, so this is cover earned from beside — and
	// an uncapped wall would report full, which would mean untargetable. A creature standing
	// in the open next to a wall is plainly not untargetable.
	//
	// Not written as an adjacent pair: nothing can be strictly nearer the attacker than a
	// cell adjacent to it, so cover-from-beside cannot arise in melee at all.
	assert.equal(coverBetween(arena(), [3, 1], [3, 3]), "half");
});

test("rubble hides nobody, though it slows them", () => {
	assert.equal(coverBetween(arena(), [1, 5], [1, 3]), "none");
});

test("a target in its own cell has no cover from itself", () => {
	assert.equal(coverBetween(arena(), [3, 3], [3, 3]), "none");
});

// ── Turning cover into a number ─────────────────────────────────────────────

test("half cover is worth two armour class", () => {
	assert.equal(coverACBonus("half"), 2);
});

test("no cover is worth nothing", () => {
	assert.equal(coverACBonus("none"), 0);
});

test("full cover reports infinity, because it is not a modifier", () => {
	// A number would invite somebody to add it to an armour class and roll anyway. Full
	// cover means there is no shot to roll.
	assert.equal(coverACBonus("full"), Infinity);
});

test("an unknown cover word is worth nothing rather than throwing", () => {
	for (const bad of [null, undefined, "", "partial", 3]) {
		assert.equal(coverACBonus(bad), 0, `${JSON.stringify(bad)}`);
	}
});
