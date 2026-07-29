/**
 * Tests for the grid primitives.
 *
 * @description Everything spatial is built on these, so they are pinned harder than their
 *   size suggests. The label functions in particular: `[x, y]` is what computes and `D7` is
 *   what a narrator and a player agent read, and a round-trip that loses a cell would put a
 *   character somewhere nobody chose — the class of silent wrongness ADR 0026 exists to
 *   keep out of positions.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_FEET_PER_CELL, FEATURE_RULES,
	cellLabel, parseCellLabel, sameCell, inBounds,
	distanceFeet, distanceCells, neighbours,
	featureAt, tokenAt, blocksMovement, blocksSight, moveCostFeet, coverOf,
} from "./grid.js";
import { arena } from "./mapFixtures.js";

// ── Labels ──────────────────────────────────────────────────────────────────

test("the origin cell is A1, because a player counts from one", () => {
	assert.equal(cellLabel([0, 0]), "A1");
});

test("a label names the column then the row", () => {
	assert.equal(cellLabel([3, 6]), "D7");
	assert.equal(cellLabel([25, 0]), "Z1");
});

test("a label round-trips back to the same cell", () => {
	// The property that matters: these two are used on opposite sides of the wire.
	for (const cell of [[0, 0], [3, 6], [25, 41], [7, 5]]) {
		assert.deepEqual(parseCellLabel(cellLabel(cell)), cell);
	}
});

test("a lower-case or spaced label still parses, because a model typed it", () => {
	assert.deepEqual(parseCellLabel("d7"), [3, 6]);
	assert.deepEqual(parseCellLabel(" D7 "), [3, 6]);
});

test("a column past Z has no label rather than a wrong one", () => {
	// Generation is capped at 26 columns. Returning null makes a breach visible; wrapping
	// round to A would place a token 26 cells from where it belongs.
	assert.equal(cellLabel([26, 0]), null);
});

test("nonsense does not parse to a cell", () => {
	for (const bad of ["", "7D", "AA1", "D", "1", "D0", "D-1", "!1", null, undefined, 42, [3, 6]]) {
		assert.equal(parseCellLabel(bad), null, `${JSON.stringify(bad)} must not parse`);
	}
});

test("a malformed cell has no label", () => {
	for (const bad of [null, undefined, [], [1], ["a", 1], [1.5, 2], [-1, 0], "D7"]) {
		assert.equal(cellLabel(bad), null, `${JSON.stringify(bad)} must not label`);
	}
});

// ── Identity and bounds ─────────────────────────────────────────────────────

test("two cells are the same when both coordinates match", () => {
	assert.equal(sameCell([3, 4], [3, 4]), true);
	assert.equal(sameCell([3, 4], [4, 3]), false);
	assert.equal(sameCell(null, [3, 4]), false);
});

test("a cell inside the arena is in bounds, and the edges count as inside", () => {
	const map = arena();
	assert.equal(inBounds(map, [0, 0]), true);
	assert.equal(inBounds(map, [7, 5]), true);
});

test("a cell one step outside any edge is out of bounds", () => {
	const map = arena();
	for (const cell of [[-1, 0], [0, -1], [8, 0], [0, 6]]) {
		assert.equal(inBounds(map, cell), false, `${JSON.stringify(cell)} must be out`);
	}
});

// ── Distance ────────────────────────────────────────────────────────────────

test("a step in any of the eight directions is one cell", () => {
	// Chebyshev: the diagonal costs the same as the orthogonal. 5e's own simplification,
	// and it avoids the alternating-diagonal rule nobody applies correctly.
	const map = arena();
	for (const [dx, dy] of neighbours()) {
		assert.equal(distanceCells(map, [3, 3], [3 + dx, 3 + dy]), 1, `step ${dx},${dy}`);
	}
});

test("distance is reported in feet using the map's own scale", () => {
	const map = arena();
	assert.equal(distanceFeet(map, [0, 0], [3, 0]), 15);
	assert.equal(distanceFeet(map, [0, 0], [3, 2]), 15, "the diagonal component is free");
	assert.equal(DEFAULT_FEET_PER_CELL, 5);
});

test("a map with an unusual scale is measured in its own units", () => {
	const map = { ...arena(), feetPerCell: 10 };
	assert.equal(distanceFeet(map, [0, 0], [2, 0]), 20);
});

test("a map with no scale falls back to five feet rather than to zero", () => {
	// Zero would make everything adjacent to everything, which is worse than a guess.
	const map = { ...arena(), feetPerCell: undefined };
	assert.equal(distanceFeet(map, [0, 0], [2, 0]), 10);
});

test("distance to itself is nothing, and distance is symmetric", () => {
	const map = arena();
	assert.equal(distanceFeet(map, [4, 4], [4, 4]), 0);
	assert.equal(distanceFeet(map, [1, 2], [6, 5]), distanceFeet(map, [6, 5], [1, 2]));
});

// ── Reading the map ─────────────────────────────────────────────────────────

test("a feature is found at each cell it occupies, not just its first", () => {
	// A wall spanning two cells that only registered at one of them would be walked
	// through, which is the whole point of the feature.
	const map = arena();
	assert.equal(featureAt(map, [2, 1])?.kind, "wall");
	assert.equal(featureAt(map, [2, 2])?.kind, "wall");
});

test("an empty cell holds no feature", () => {
	assert.equal(featureAt(arena(), [0, 3]), null);
});

test("a token is found by its cell, and reports its name", () => {
	const map = arena();
	assert.equal(tokenAt(map, [7, 5])?.name, "Goblin");
	assert.equal(tokenAt(map, [0, 0])?.name, "Hero");
	assert.equal(tokenAt(map, [3, 3]), null);
});

test("a landmark blocks nothing and covers nothing", () => {
	// Landmarks exist so the narrator has something to name. The moment one carries a
	// rule, the narration layer has quietly acquired mechanics.
	const map = arena();
	assert.equal(blocksMovement(map, [3, 3]), false);
	assert.equal(blocksSight(map, [3, 3]), false);
	assert.equal(coverOf(map, [3, 3]), "none");
	assert.equal(moveCostFeet(map, [3, 3]), 5);
});

// ── The feature rules table ─────────────────────────────────────────────────

test("every feature kind used by a fixture is described by the rules table", () => {
	// A kind absent from the table would silently behave like open floor.
	for (const feature of arena().features) {
		assert.ok(FEATURE_RULES[feature.kind], `${feature.kind} has no rule`);
	}
});

test("a wall stops movement and sight and grants full cover", () => {
	const map = arena();
	assert.equal(blocksMovement(map, [2, 1]), true);
	assert.equal(blocksSight(map, [2, 1]), true);
	assert.equal(coverOf(map, [2, 1]), "full");
});

test("a pillar stops a body, obstructs a shot without denying it, and grants half cover", () => {
	// This replaces an assertion that a pillar blocks sight outright. That was physically true of
	// a stone column and ruinous as a rule: eight pillars in a nine-by-seven crypt meant almost
	// nothing could see anything, ranged attacks failed rather than being made harder, and cover
	// never engaged — the measured crypt had nineteen full-cover cells against three of half.
	// A pillar is now `obstructs`, so the shot exists and costs the attacker cover.
	const map = arena();
	assert.equal(blocksMovement(map, [4, 2]), true);
	assert.equal(blocksSight(map, [4, 2]), false);
	assert.equal(coverOf(map, [4, 2]), "half");
});

test("a low wall stops movement, is seen over, and grants half cover", () => {
	const map = arena();
	assert.equal(blocksMovement(map, [4, 4]), true);
	assert.equal(blocksSight(map, [4, 4]), false);
	assert.equal(coverOf(map, [4, 4]), "half");
});

test("rubble is crossed at double cost and hides nobody", () => {
	const map = arena();
	assert.equal(blocksMovement(map, [1, 4]), false);
	assert.equal(moveCostFeet(map, [1, 4]), 10);
	assert.equal(coverOf(map, [1, 4]), "none");
});

test("a pit stops movement but is seen across", () => {
	const map = arena();
	assert.equal(blocksMovement(map, [7, 0]), true);
	assert.equal(blocksSight(map, [7, 0]), false);
});

test("an impassable cell costs infinity to enter", () => {
	// So a shortest-path search never prices a route through a wall as merely expensive.
	assert.equal(moveCostFeet(arena(), [2, 1]), Infinity);
});

test("an unrecognised feature kind is treated as open floor and not as a wall", () => {
	// The narrator invents scenery. Inventing a word must not seal a room and softlock the
	// encounter — the safe direction to be wrong is permissive.
	const map = arena();
	map.features.push({ id: "z", kind: "shimmering_haze", cells: [[6, 1]] });
	assert.equal(blocksMovement(map, [6, 1]), false);
	assert.equal(blocksSight(map, [6, 1]), false);
	assert.equal(coverOf(map, [6, 1]), "none");
	assert.equal(moveCostFeet(map, [6, 1]), 5);
});

test("a cell outside the map is impassable and opaque", () => {
	// Off-map is the outside of the world, not open ground: a flood fill that leaked past
	// the edge would offer moves that cannot be drawn.
	const map = arena();
	assert.equal(blocksMovement(map, [-1, 0]), true);
	assert.equal(blocksSight(map, [8, 0]), true);
	assert.equal(moveCostFeet(map, [99, 99]), Infinity);
});

test("a malformed map is read as empty rather than throwing", () => {
	// This runs inside the turn pipeline; a half-written map must not take the turn down.
	for (const bad of [null, undefined, {}, { features: null, tokens: null }]) {
		assert.equal(featureAt(bad, [0, 0]), null);
		assert.equal(tokenAt(bad, [0, 0]), null);
	}
});
