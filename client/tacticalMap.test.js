/**
 * Tests for the battle map's client-side model.
 *
 * @description Only the decisions are tested here, not the drawing — a canvas assertion pins pixels
 *   and teaches nobody anything. What matters is which squares are offered, what a click does with
 *   one, and that the page never works out reach for itself.
 *
 *   That last one is the point. The reachable squares arrive from the server, which is the same rule
 *   the player agents are held to: one authority on distance, and it is not the client. A browser
 *   that computed its own would eventually disagree with the server about a legal move, and the
 *   player would be told their click was refused for no visible reason.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMapView } from "./tacticalMap.js";

/**
 * @description A small arena: two by two of open floor, the character on A1 and a goblin on B2.
 * @returns {object} A map in the shape `state:update` publishes.
 */
function arena() {
	return {
		width: 3, height: 2, feetPerCell: 5, archetype: "room",
		features: [{ id: "w", kind: "wall", cells: [[2, 0]] }],
		landmarks: [],
		tokens: {
			Ayla: { faction: "party", cell: [0, 0], size: 1, speedFeet: 30, reachFeet: 5 },
			Goblin: { faction: "enemy", cell: [1, 1], size: 1, speedFeet: 30, reachFeet: 5 },
		},
	};
}

test("a fresh view has nothing pending and nothing to offer", () => {
	const view = createMapView();
	assert.equal(view.pendingMove(), null);
	assert.deepEqual(view.offered(), []);
});

test("the view offers exactly the squares the server sent", () => {
	// Not "every empty square", and not anything derived here.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1", "A2"], standing: "A1" });
	assert.deepEqual(view.offered().sort(), ["A1", "A2", "B1"]);
});

test("clicking an offered square makes it the pending move", () => {
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	assert.equal(view.clickCell([1, 0]), true);
	assert.equal(view.pendingMove(), "B1");
});

test("clicking a square that was not offered changes nothing", () => {
	// The tint is the whole legality conversation: an illegal move is not refused with a message,
	// it is simply never offered. Clicking elsewhere has to be inert rather than an error.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	assert.equal(view.clickCell([2, 0]), false, "the wall");
	assert.equal(view.clickCell([1, 1]), false, "the goblin");
	assert.equal(view.pendingMove(), null);
});

test("clicking the square you already stand on cancels a pending move", () => {
	// Somewhere to put a mis-click back. Standing still is legal, so this reads as "never mind"
	// rather than as an error state to explain.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	view.clickCell([0, 0]);
	assert.equal(view.pendingMove(), null);
});

test("clicking the pending square again cancels it", () => {
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	view.clickCell([1, 0]);
	assert.equal(view.pendingMove(), null);
});

test("nothing is offered when it is not your turn", () => {
	// `tactical:menu` only reaches the character on the clock, so an empty option set is the
	// ordinary state for most of a fight rather than an error.
	const view = createMapView();
	view.setMap(arena());
	assert.deepEqual(view.offered(), []);
	assert.equal(view.clickCell([1, 0]), false);
});

test("a new turn clears the previous pending move", () => {
	// Otherwise last turn's click is silently attached to this turn's action.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	view.setOptions({ reachable: ["A1", "A2"], standing: "A1" });
	assert.equal(view.pendingMove(), null);
});

test("taking the pending move hands it over once and forgets it", () => {
	// The action submit path calls this. A move that stuck around would be re-sent on the next
	// action, moving the character somewhere nobody asked for a second time.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	assert.equal(view.takeMove(), "B1");
	assert.equal(view.takeMove(), null);
	assert.equal(view.pendingMove(), null);
});

test("the map going away clears everything", () => {
	// Combat ends and the arena is deleted. A stale pending move would ride the next action.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	view.setMap(null);
	assert.equal(view.pendingMove(), null);
	assert.deepEqual(view.offered(), []);
	assert.equal(view.hasMap(), false);
});

test("a click with no map at all is inert", () => {
	const view = createMapView();
	assert.equal(view.clickCell([0, 0]), false);
});

test("malformed options are ignored rather than throwing", () => {
	// This is fed straight from a socket payload.
	const view = createMapView();
	view.setMap(arena());
	for (const bad of [null, undefined, {}, { reachable: "A1" }, { reachable: [null, 7] }]) {
		view.setOptions(bad);
		assert.deepEqual(view.offered(), [], JSON.stringify(bad));
	}
});

test("a malformed map is treated as no map", () => {
	const view = createMapView();
	for (const bad of [{}, { width: 0, height: 0 }, { width: 3 }, "arena"]) {
		view.setMap(bad);
		assert.equal(view.hasMap(), false, JSON.stringify(bad));
	}
});

test("the view reports which square holds which token, for drawing and for hit-testing", () => {
	const view = createMapView();
	view.setMap(arena());
	assert.equal(view.tokenAtCell([0, 0])?.name, "Ayla");
	assert.equal(view.tokenAtCell([1, 1])?.name, "Goblin");
	assert.equal(view.tokenAtCell([0, 1]), null);
});

test("a cell outside the map hit-tests to nothing", () => {
	const view = createMapView();
	view.setMap(arena());
	assert.equal(view.tokenAtCell([9, 9]), null);
	assert.equal(view.clickCell([9, 9]), false);
});

test("the same arena arriving again does not discard a click", () => {
	// `state:update` carries the map and fires many times a turn — on damage, on conditions, on a
	// roster change. Treating each one as a new arena wiped the square the player had just clicked,
	// so their move silently failed to ride along with the action they typed afterwards.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	assert.equal(view.pendingMove(), "B1");

	view.setMap(arena());
	assert.equal(view.pendingMove(), "B1", "the click must survive a redundant state push");
});

test("a token moving within the same arena does not discard a click", () => {
	// The commonest case of all: somebody else takes their turn while you are deciding.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);

	const moved = arena();
	moved.tokens.Goblin.cell = [0, 1];
	view.setMap(moved);
	assert.equal(view.pendingMove(), "B1");
});

test("a genuinely different arena does discard a click", () => {
	// A new encounter is a new room, and a square chosen in the last one means nothing in it.
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);

	const other = arena();
	other.width = 8;
	view.setMap(other);
	assert.equal(view.pendingMove(), null);
});

test("the map going away still discards a click", () => {
	const view = createMapView();
	view.setMap(arena());
	view.setOptions({ reachable: ["A1", "B1"], standing: "A1" });
	view.clickCell([1, 0]);
	view.setMap(null);
	assert.equal(view.pendingMove(), null);
});
