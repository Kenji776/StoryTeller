/**
 * Tests for movement and pathing.
 *
 * @description The fixture arena, for reading these by eye:
 *
 * ```
 *      A  B  C  D  E  F  G  H
 *   1  H  .  .  .  .  .  .  X     H hero, speed 30 (six cells)
 *   2  .  .  #  .  .  .  .  .     # wall     impassable
 *   3  .  .  #  .  o  .  .  .     o pillar   impassable
 *   4  .  .  .  .  .  .  .  .     = low wall impassable
 *   5  .  ~  ~  .  =  =  .  .     ~ rubble   costs double
 *   6  .  .  .  .  .  .  .  G     X pit      impassable
 * ```
 */

import test from "node:test";
import assert from "node:assert/strict";

import { reachableCells, pathTo, canReach, movementBudgetFeet, walkableRegion } from "./movement.js";
import { cellLabel } from "./grid.js";
import { arena, emptyRoom } from "./mapFixtures.js";

/**
 * @description A two-by-two map with walls on the off-diagonal, for the squeeze rule.
 * @returns {object} The map, with the hero at A1.
 */
function pinch() {
	return {
		width: 2, height: 2, feetPerCell: 5, features: [
			{ id: "a", kind: "wall", cells: [[1, 0]] },
			{ id: "b", kind: "wall", cells: [[0, 1]] },
		],
		landmarks: [],
		tokens: { Hero: { faction: "party", cell: [0, 0], size: 1, speedFeet: 30, reachFeet: 5 } },
	};
}

// ── The budget ──────────────────────────────────────────────────────────────

test("a speed in feet becomes a budget in feet", () => {
	assert.equal(movementBudgetFeet(arena(), "Hero"), 30);
});

test("a token with no stated speed gets the default rather than none", () => {
	// Zero would pin a character to the spot, and a sheet written before speed existed has
	// no such field. Every character already in a stored lobby is in that position.
	const map = arena();
	delete map.tokens.Hero.speedFeet;
	assert.equal(movementBudgetFeet(map, "Hero"), 30);
});

test("a token nobody has heard of has no budget", () => {
	assert.equal(movementBudgetFeet(arena(), "Nobody"), 0);
});

// ── Reach ───────────────────────────────────────────────────────────────────

test("standing still is always a legal move", () => {
	// Otherwise "move then act" would force a step every turn, and holding a doorway is a
	// tactic rather than an oversight.
	const reachable = reachableCells(emptyRoom(), "Hero");
	assert.equal(reachable.get("A1").costFeet, 0);
});

test("six cells of speed reach exactly the cells within six cells", () => {
	// Chebyshev again: a diagonal costs what an orthogonal costs, so the reachable area is a
	// square rather than a diamond. Quoted distance and paid distance have to agree.
	const reachable = reachableCells(emptyRoom(10, 10), "Hero");
	assert.equal(reachable.size, 49, "a seven-by-seven square, corner included");
	assert.equal(reachable.get("G7").costFeet, 30, "the far corner, at full price");
	assert.equal(reachable.has("H1"), false, "and one step further is out of reach");
});

test("a shorter budget reaches proportionally less", () => {
	const reachable = reachableCells(emptyRoom(10, 10), "Hero", { budgetFeet: 10 });
	assert.equal(reachable.size, 9);
	assert.equal(reachable.has("D1"), false);
});

test("a budget of nothing reaches only where you already stand", () => {
	const reachable = reachableCells(emptyRoom(), "Hero", { budgetFeet: 0 });
	assert.deepEqual([...reachable.keys()], ["A1"]);
});

test("an impassable cell is never a destination", () => {
	const reachable = reachableCells(arena(), "Hero");
	assert.equal(reachable.has("C2"), false, "the wall");
	assert.equal(reachable.has("C3"), false, "the rest of the wall");
	assert.equal(reachable.has("E3"), false, "the pillar");
	assert.equal(reachable.has("E5"), false, "the low wall stops a body even so");
});

test("rubble is crossed, at twice the price", () => {
	// B5 is rubble. Three cells down the A column and a diagonal step in costs 15 + 10.
	const reachable = reachableCells(arena(), "Hero");
	assert.equal(reachable.get("B5").costFeet, 25);
});

test("a route goes around a wall rather than through it", () => {
	// D3 sits directly behind the wall at C2-C3, and the detour costs a step: 20 feet where
	// open ground would have been 15.
	//
	// Twenty is provable rather than observed. Reaching D3 needs three columns of travel, so
	// a three-step route has to cross column C exactly once — and the wall occupies C2 and
	// C3, which are the only two rows such a route could use. Hence four steps.
	const reachable = reachableCells(arena(), "Hero");
	assert.equal(reachable.get("D3").costFeet, 20);
});

test("a diagonal may not squeeze between two blocked corners", () => {
	// Slipping between the corners of two walls is the classic grid cheat. Forbidding it
	// costs nothing and stops a character crossing a barrier that looks solid on the map.
	const reachable = reachableCells(pinch(), "Hero");
	assert.equal(reachable.has("B2"), false);
});

test("an enemy cannot be walked through", () => {
	const map = emptyRoom(5, 1);
	map.tokens.Goblin = { faction: "enemy", cell: [2, 0], size: 1, speedFeet: 30, reachFeet: 5 };
	const reachable = reachableCells(map, "Hero");
	assert.equal(reachable.has("C1"), false, "not onto them");
	assert.equal(reachable.has("D1"), false, "and not past them either");
});

test("an ally is squeezed past but not stood on", () => {
	// Being sealed into a corridor by your own party would be a softlock wearing the costume
	// of a rule, so a friend is passable. Ending the move on top of them is still not.
	const map = emptyRoom(5, 1);
	map.tokens.Friend = { faction: "party", cell: [2, 0], size: 1, speedFeet: 30, reachFeet: 5 };
	const reachable = reachableCells(map, "Hero");
	assert.equal(reachable.has("C1"), false, "not onto them");
	assert.equal(reachable.has("D1"), true, "but past them");
});

test("a token nobody has heard of reaches nowhere", () => {
	assert.equal(reachableCells(arena(), "Nobody").size, 0);
});

test("a malformed map reaches nowhere rather than throwing", () => {
	for (const bad of [null, undefined, {}]) {
		assert.equal(reachableCells(bad, "Hero").size, 0);
	}
});

test("the same question twice gives the same answer", () => {
	// `TDD-8`: the flood fill breaks ties on a stable key, so a menu offered to a player is
	// not reordered between the turn it is built and the turn it is checked.
	const first = [...reachableCells(arena(), "Hero").keys()];
	const second = [...reachableCells(arena(), "Hero").keys()];
	assert.deepEqual(first, second);
});

// ── canReach ────────────────────────────────────────────────────────────────

test("canReach agrees with the reachable set", () => {
	const map = arena();
	for (const label of ["A1", "B2", "D3", "B5"]) {
		assert.equal(canReach(map, "Hero", label), true, label);
	}
	for (const label of ["C2", "E3", "H1"]) {
		assert.equal(canReach(map, "Hero", label), false, label);
	}
});

test("canReach takes a cell or a label, since one comes from a click and one from a sentence", () => {
	const map = arena();
	assert.equal(canReach(map, "Hero", [1, 1]), true);
	assert.equal(canReach(map, "Hero", "B2"), true);
});

test("canReach refuses a cell off the map and a label that is not one", () => {
	const map = arena();
	assert.equal(canReach(map, "Hero", [99, 99]), false);
	assert.equal(canReach(map, "Hero", "banana"), false);
	assert.equal(canReach(map, "Hero", null), false);
});

// ── Paths ───────────────────────────────────────────────────────────────────

test("a path across open ground is a straight run", () => {
	const path = pathTo(emptyRoom(10, 10), "Hero", [3, 0]);
	assert.equal(path.cells.map(cellLabel).join(","), "B1,C1,D1");
	assert.equal(path.costFeet, 15);
});

test("a path excludes where you started and includes where you arrive", () => {
	// So a caller can walk the result to animate the move, and the last entry is the
	// destination to write back to the token.
	const path = pathTo(emptyRoom(10, 10), "Hero", [2, 0]);
	assert.equal(cellLabel(path.cells.at(-1)), "C1");
	assert.equal(path.cells.some((c) => cellLabel(c) === "A1"), false);
});

test("a path to where you already stand is empty and free", () => {
	const path = pathTo(emptyRoom(), "Hero", [0, 0]);
	assert.deepEqual(path.cells, []);
	assert.equal(path.costFeet, 0);
});

test("a path bends around an obstacle and its cost matches the route", () => {
	const path = pathTo(arena(), "Hero", [3, 2]);
	assert.equal(path.costFeet, 20);
	assert.equal(path.cells.length, 4, "four steps at five feet each — the wall forces a detour");
	assert.equal(path.cells.every((c) => cellLabel(c) !== "C2" && cellLabel(c) !== "C3"), true,
		"and none of them is the wall");
});

test("there is no path to a cell out of budget", () => {
	// Reported as no path rather than as a truncated one. Clamping would leave a character
	// standing somewhere nobody chose, which is the silent wrongness ADR 0026 exists to
	// keep out of positions.
	assert.equal(pathTo(emptyRoom(10, 10), "Hero", [9, 9]), null);
});

test("there is no path into a wall", () => {
	assert.equal(pathTo(arena(), "Hero", [2, 1]), null);
});

test("there is no path off the map, or to nonsense", () => {
	const map = arena();
	assert.equal(pathTo(map, "Hero", [99, 99]), null);
	assert.equal(pathTo(map, "Hero", null), null);
	assert.equal(pathTo(map, "Nobody", [1, 1]), null);
});

test("a path is a legal walk: every step is a neighbour of the last", () => {
	// The property that catches a search which stitches together disconnected cells.
	const path = pathTo(arena(), "Hero", [3, 4]);
	let previous = arena().tokens.Hero.cell;
	for (const cell of path.cells) {
		const step = Math.max(Math.abs(cell[0] - previous[0]), Math.abs(cell[1] - previous[1]));
		assert.equal(step, 1, `${cellLabel(previous)} → ${cellLabel(cell)} is not one step`);
		previous = cell;
	}
});

test("a path never costs more than the budget it was found under", () => {
	const map = arena();
	for (const [, entry] of reachableCells(map, "Hero")) {
		const path = pathTo(map, "Hero", entry.cell);
		assert.ok(path, `${cellLabel(entry.cell)} is reachable but has no path`);
		assert.equal(path.costFeet, entry.costFeet, `${cellLabel(entry.cell)} disagrees on cost`);
		assert.ok(path.costFeet <= 30);
	}
});

// ── Terrain connectivity ────────────────────────────────────────────────────

/**
 * @description A room cut clean in two by a wall down column C.
 * @returns {object} The map, hero on the left of the divide.
 */
function divided() {
	return {
		width: 5, height: 3, feetPerCell: 5,
		features: [{ id: "d", kind: "wall", cells: [[2, 0], [2, 1], [2, 2]] }],
		landmarks: [],
		tokens: { Hero: { faction: "party", cell: [0, 0], size: 1, speedFeet: 30, reachFeet: 5 } },
	};
}

test("an open room is one region", () => {
	assert.equal(walkableRegion(emptyRoom(3, 3), [0, 0]).size, 9);
});

test("a region ignores speed, because generation asks a question about terrain", () => {
	// `reachableCells` answers "where can I go this turn" and is bounded. Whether a room is
	// traversable at all is a different question, and a five-foot speed must not make an
	// arena look disconnected and send generation into a reroll loop.
	const map = emptyRoom(10, 10);
	map.tokens.Hero.speedFeet = 5;
	assert.equal(walkableRegion(map, [0, 0]).size, 100);
});

test("a wall across the room splits it into two regions", () => {
	const region = walkableRegion(divided(), [0, 0]);
	assert.equal(region.size, 6, "the three cells of columns A and B");
	assert.equal(region.has("D1"), false, "and nothing beyond the divide");
});

test("the far side of a divide is its own region", () => {
	assert.equal(walkableRegion(divided(), [3, 0]).size, 6);
});

test("a region ignores who is standing where", () => {
	// Tokens move; terrain does not. An enemy parked in a doorway must not make generation
	// reject an arena that is perfectly traversable once the fight starts.
	const map = divided();
	map.features = [{ id: "d", kind: "wall", cells: [[2, 0], [2, 2]] }];
	map.tokens.Blocker = { faction: "enemy", cell: [2, 1], size: 1, speedFeet: 30, reachFeet: 5 };
	// Thirteen: five by three, less the two wall cells. Were the token treated as an obstacle
	// the fill would stop at the divide and return six.
	assert.equal(walkableRegion(map, [0, 0]).size, 13);
});

test("a region starting on a wall is empty", () => {
	assert.equal(walkableRegion(divided(), [2, 1]).size, 0);
});

test("a region starting off the map, or from nonsense, is empty", () => {
	for (const bad of [[99, 99], null, "C1"]) {
		assert.equal(walkableRegion(divided(), bad).size, 0);
	}
	assert.equal(walkableRegion(null, [0, 0]).size, 0);
});

test("a region is a set of labels, so membership is a cheap question", () => {
	// Generation asks "is every spawn in the same region" once per attempt, and rerolls on a
	// miss; the answer wants to be a lookup rather than a search.
	const region = walkableRegion(emptyRoom(3, 3), [0, 0]);
	assert.ok(region.has("A1"));
	assert.ok(region.has("C3"));
});

test("an unlimited budget really means unlimited", () => {
	// Regression. `Number.isFinite(Infinity)` is false, so the budget guard treated an explicit
	// `Infinity` as "no budget given" and quietly substituted the token's own speed. The caller
	// that tripped over it was `session.applyMove`, asking what an out-of-range move *would*
	// have cost so the refusal could say — and getting null, so it could not.
	const path = pathTo(emptyRoom(10, 10), "Hero", [9, 9], { budgetFeet: Infinity });
	assert.ok(path, "an unlimited walk across an empty room must exist");
	assert.equal(path.costFeet, 45);
	assert.equal(reachableCells(emptyRoom(10, 10), "Hero", { budgetFeet: Infinity }).size, 100);
});
