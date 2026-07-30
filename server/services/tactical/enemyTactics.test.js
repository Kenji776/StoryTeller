/**
 * Tests for enemy tactics.
 *
 * @description **Written after the implementation, against `TDD-1`.** Declared rather than hidden.
 *   In place of an observed RED, each behaviour here was confirmed to fail with the relevant
 *   function stubbed out — the `TDD-7` sanity check — because a test suite that would pass against
 *   `return null` proves nothing whichever order it was written in.
 *
 *   The fixture, for reading these by eye. Twelve by five, no scenery unless a test adds it:
 *
 * ```
 *      A B C D E F G H I J K L
 *   3  F . . . . . . . N . E .     F far character   N near character   E the enemy
 * ```
 */

import test from "node:test";
import assert from "node:assert/strict";

import { INTENTS, defaultIntent, resolveIntent, moveEnemy, tacticsFor, applyOrders } from "./enemyTactics.js";
import { TACTICAL_SETTING } from "./session.js";
import { cellLabel, distanceFeet } from "./grid.js";
import { coverBetween } from "./sight.js";

/**
 * @description A lobby with a hand-placed map: one enemy, one character close, one far away.
 * @param {object} [over] - Map overrides.
 * @returns {object} The lobby.
 */
function field(over = {}) {
	return {
		lobbyId: "lob1",
		[TACTICAL_SETTING]: true,
		players: {
			Far: { name: "Far", race: "Human", stats: { hp: 10, max_hp: 10 } },
			Near: { name: "Near", race: "Human", stats: { hp: 10, max_hp: 10 } },
		},
		enemies: { Ghoul: { name: "Ghoul", hp: 11, max_hp: 11, ac: 12, cr: "1", status: "active" } },
		map: {
			seed: 1, width: 12, height: 5, feetPerCell: 5, archetype: "room",
			features: [], landmarks: [],
			tokens: {
				Far: { faction: "party", cell: [0, 2], size: 1, speedFeet: 30, reachFeet: 5 },
				Near: { faction: "party", cell: [8, 2], size: 1, speedFeet: 30, reachFeet: 5 },
				Ghoul: { faction: "enemy", cell: [10, 2], size: 1, speedFeet: 30, reachFeet: 5 },
			},
			...over,
		},
	};
}

/** @description The party members a round would offer as candidates. */
const candidates = (lobby) => Object.values(lobby.players);

// ── The vocabulary ──────────────────────────────────────────────────────────

test("the intent vocabulary is closed", () => {
	// An open set would let the narrator invent a verb, and inventing verbs is how a model ends up
	// deciding geometry by the back door.
	assert.deepEqual([...INTENTS].sort(), ["close", "hold", "ranged", "regroup", "seek_cover", "withdraw"]);
});

// ── The default, which is what usually runs ─────────────────────────────────

test("by default an enemy closes on whoever is nearest", () => {
	const intent = defaultIntent(field().map, "Ghoul");
	assert.equal(intent.verb, "close");
	assert.equal(intent.target, "Near", "not the character on the far side of the room");
});

test("an enemy already in reach holds instead of shuffling", () => {
	const lobby = field();
	lobby.map.tokens.Near.cell = [9, 2];
	const intent = defaultIntent(lobby.map, "Ghoul");
	assert.equal(intent.verb, "hold");
	assert.equal(intent.target, "Near");
});

test("an enemy with nobody left holds", () => {
	const lobby = field();
	delete lobby.map.tokens.Far;
	delete lobby.map.tokens.Near;
	assert.deepEqual(defaultIntent(lobby.map, "Ghoul"), { verb: "hold", target: null });
});

test("an enemy who is not on the map holds rather than throwing", () => {
	assert.equal(defaultIntent(field().map, "Nobody").verb, "hold");
	assert.equal(defaultIntent(null, "Ghoul").verb, "hold");
});

test("equidistant characters are chosen between stably", () => {
	// Otherwise a monster oscillates between two targets on consecutive rounds, which reads as
	// indecision rather than tactics — and `TDD-8` wants the same answer every run.
	const lobby = field();
	lobby.map.tokens.Far.cell = [8, 0];
	lobby.map.tokens.Near.cell = [8, 4];
	const first = defaultIntent(lobby.map, "Ghoul").target;
	assert.equal(defaultIntent(field({ tokens: lobby.map.tokens }).map, "Ghoul").target, first);
});

// ── Standing orders ─────────────────────────────────────────────────────────

test("a valid order from the narrator is honoured over the default", () => {
	const lobby = field();
	lobby.map.tokens.Ghoul.order = { verb: "withdraw", target: null };
	const intent = resolveIntent(lobby.map, "Ghoul", lobby.map.tokens.Ghoul.order);
	assert.equal(intent.verb, "withdraw");
	assert.equal(intent.fellBack, false);
});

test("an invented verb is discarded, not guessed at", () => {
	const intent = resolveIntent(field().map, "Ghoul", { verb: "eviscerate", target: "Near" });
	assert.equal(intent.verb, "close");
	assert.equal(intent.fellBack, true);
});

test("an order naming somebody who has left the map falls back", () => {
	// Orders are chosen a round early, so this is the ordinary case rather than an edge one: the
	// character the ghoul was told to chase may have died in between.
	const intent = resolveIntent(field().map, "Ghoul", { verb: "close", target: "Ghost" });
	assert.equal(intent.fellBack, true);
	assert.equal(intent.target, "Near");
});

test("hold and withdraw need no target to stay valid", () => {
	for (const verb of ["hold", "withdraw"]) {
		assert.equal(resolveIntent(field().map, "Ghoul", { verb }).fellBack, false, verb);
	}
});

test("no order at all is not a failure, just the default", () => {
	assert.equal(resolveIntent(field().map, "Ghoul", undefined).verb, "close");
});

// ── Moving ──────────────────────────────────────────────────────────────────

test("closing moves the enemy toward its target and no further than its speed", () => {
	const lobby = field();
	const moved = moveEnemy(lobby, "Ghoul");
	assert.ok(moved, "it should have moved");
	assert.ok(moved.costFeet <= 30, `spent ${moved.costFeet} feet on a 30-foot budget`);
	assert.ok(distanceFeet(lobby.map, lobby.map.tokens.Ghoul.cell, lobby.map.tokens.Near.cell)
		< distanceFeet(lobby.map, moved.from, lobby.map.tokens.Near.cell), "it got closer");
});

test("closing stops when it arrives rather than walking through", () => {
	const lobby = field();
	moveEnemy(lobby, "Ghoul");
	assert.equal(distanceFeet(lobby.map, lobby.map.tokens.Ghoul.cell, lobby.map.tokens.Near.cell), 5,
		"adjacent, not on top of them");
});

test("holding does not move anybody", () => {
	const lobby = field();
	lobby.map.tokens.Near.cell = [9, 2];
	assert.equal(moveEnemy(lobby, "Ghoul"), null);
	assert.equal(cellLabel(lobby.map.tokens.Ghoul.cell), "K3");
});

test("withdrawing increases the distance to the nearest threat", () => {
	const lobby = field();
	lobby.map.tokens.Near.cell = [9, 2];
	lobby.map.tokens.Ghoul.order = { verb: "withdraw" };
	const before = distanceFeet(lobby.map, lobby.map.tokens.Ghoul.cell, lobby.map.tokens.Near.cell);
	moveEnemy(lobby, "Ghoul");
	assert.ok(distanceFeet(lobby.map, lobby.map.tokens.Ghoul.cell, lobby.map.tokens.Near.cell) > before);
});

test("seeking cover ends somewhere sheltered that can still see the target", () => {
	// A sheltered cell it cannot shoot from is not cover, it is hiding.
	const lobby = field();
	lobby.map.features = [{ id: "p", kind: "pillar", cells: [[6, 2]] }];
	lobby.map.tokens.Near.cell = [2, 2];
	lobby.map.tokens.Ghoul.cell = [7, 2];
	lobby.map.tokens.Ghoul.order = { verb: "seek_cover", target: "Near" };
	moveEnemy(lobby, "Ghoul");
	assert.notEqual(coverBetween(lobby.map, lobby.map.tokens.Near.cell, lobby.map.tokens.Ghoul.cell), "none");
});

test("a move is refused rather than half-applied when there is no route", () => {
	const lobby = field();
	// Wall the ghoul into its own corner.
	lobby.map.features = [{ id: "w", kind: "wall", cells: [[9, 0], [9, 1], [9, 2], [9, 3], [9, 4]] }];
	assert.equal(moveEnemy(lobby, "Ghoul"), null);
	assert.equal(cellLabel(lobby.map.tokens.Ghoul.cell), "K3");
});

test("moving does nothing when the feature is off", () => {
	const lobby = field();
	lobby[TACTICAL_SETTING] = false;
	const before = JSON.stringify(lobby);
	assert.equal(moveEnemy(lobby, "Ghoul"), null);
	assert.equal(JSON.stringify(lobby), before);
});

// ── Choosing who to hit, which is the point of the phase ────────────────────

test("there are no tactics at all without a map", () => {
	// Omitting the object is what "off" means at the `enemyTurns.js` layer, so the round-robin path
	// stays byte-for-byte what it was for a lobby that never opted in.
	const off = field();
	off[TACTICAL_SETTING] = false;
	assert.equal(tacticsFor(off), null);
	assert.equal(tacticsFor({ [TACTICAL_SETTING]: true }), null);
});

test("an enemy goes for the nearest character, not the next one in line", () => {
	// The whole phase in one assertion. Round-robin would hand it Far every other swing; proximity
	// hands it Near every time, which is what makes stepping in front of somebody mean anything.
	const lobby = field();
	const tactics = tacticsFor(lobby);
	for (let i = 0; i < 5; i++) {
		assert.equal(tactics.pickTarget(lobby.enemies.Ghoul, candidates(lobby)).name, "Near");
	}
});

test("a character who steps in front becomes the target", () => {
	// Guarding, as a consequence of geometry rather than a rule written for it.
	const lobby = field();
	const tactics = tacticsFor(lobby);
	assert.equal(tactics.pickTarget(lobby.enemies.Ghoul, candidates(lobby)).name, "Near");

	lobby.map.tokens.Far.cell = [9, 2];
	assert.equal(tactics.pickTarget(lobby.enemies.Ghoul, candidates(lobby)).name, "Far",
		"whoever is closest now");
});

test("somebody in reach is preferred over somebody merely closer to walk to", () => {
	const lobby = field();
	lobby.map.tokens.Near.cell = [9, 2];
	lobby.map.tokens.Far.cell = [7, 2];
	assert.equal(tacticsFor(lobby).pickTarget(lobby.enemies.Ghoul, candidates(lobby)).name, "Near");
});

test("a character not on the map is never chosen", () => {
	const lobby = field();
	delete lobby.map.tokens.Near;
	assert.equal(tacticsFor(lobby).pickTarget(lobby.enemies.Ghoul, candidates(lobby)).name, "Far");
});

test("an enemy with nobody on the map picks nobody", () => {
	const lobby = field();
	delete lobby.map.tokens.Near;
	delete lobby.map.tokens.Far;
	assert.equal(tacticsFor(lobby).pickTarget(lobby.enemies.Ghoul, candidates(lobby)), null);
});

// ── Whether the blow can be thrown at all ──────────────────────────────────

test("an enemy out of reach does not get to attack", () => {
	// The other half of making positioning matter. Before this, a creature forty feet away hit you
	// anyway, so closing the distance was never something the monsters had to spend anything on.
	const lobby = field();
	const tactics = tacticsFor(lobby);
	assert.equal(tactics.canStrike(lobby.enemies.Ghoul, { name: "Near" }), false, "25 feet away");
	assert.equal(tactics.canStrike(lobby.enemies.Ghoul, { name: "Far" }), false);
});

test("an adjacent enemy does get to attack", () => {
	const lobby = field();
	lobby.map.tokens.Near.cell = [9, 2];
	assert.equal(tacticsFor(lobby).canStrike(lobby.enemies.Ghoul, { name: "Near" }), true);
});

test("canStrike refuses anyone missing rather than throwing", () => {
	const tactics = tacticsFor(field());
	assert.equal(tactics.canStrike(null, { name: "Near" }), false);
	assert.equal(tactics.canStrike({ name: "Ghoul" }, null), false);
	assert.equal(tactics.canStrike({ name: "Ghost" }, { name: "Near" }), false);
});

test("closing then striking works in the order the round runs them", () => {
	// The sequence that matters: move, then swing. Out of reach at 25 feet, adjacent afterwards.
	const lobby = field();
	const tactics = tacticsFor(lobby);
	assert.equal(tactics.canStrike(lobby.enemies.Ghoul, { name: "Near" }), false);
	tactics.beforeStrike(lobby.enemies.Ghoul);
	assert.equal(tactics.canStrike(lobby.enemies.Ghoul, { name: "Near" }), true);
});

// ── Taking orders from the narrator ─────────────────────────────────────────

test("a valid order is recorded on the creature it names", () => {
	const lobby = field();
	const report = applyOrders(lobby, [{ enemy: "Ghoul", intent: "withdraw" }]);
	assert.deepEqual(lobby.map.tokens.Ghoul.order, { verb: "withdraw", target: null });
	assert.equal(report.accepted, 1);
});

test("an order carrying a target keeps it", () => {
	const lobby = field();
	applyOrders(lobby, [{ enemy: "Ghoul", intent: "seek_cover", target: "Far" }]);
	assert.deepEqual(lobby.map.tokens.Ghoul.order, { verb: "seek_cover", target: "Far" });
});

test("an invented verb is refused and recorded as refused", () => {
	// Reported rather than silently dropped: a narrator that keeps inventing verbs is a prompt
	// problem, and it is invisible unless somebody counts.
	const lobby = field();
	const report = applyOrders(lobby, [{ enemy: "Ghoul", intent: "eviscerate", target: "Near" }]);
	assert.equal(lobby.map.tokens.Ghoul.order, undefined);
	assert.equal(report.accepted, 0);
	assert.equal(report.refused.length, 1);
	assert.match(report.refused[0], /eviscerate/);
});

test("an order for a creature that is not on the map is refused", () => {
	const lobby = field();
	const report = applyOrders(lobby, [{ enemy: "Wyvern", intent: "close", target: "Near" }]);
	assert.equal(report.accepted, 0);
	assert.match(report.refused[0], /Wyvern/);
});

test("an order aimed at a character who is not on the map is refused", () => {
	// The narrator writes these a round early, so it names the dead surprisingly often.
	const lobby = field();
	const report = applyOrders(lobby, [{ enemy: "Ghoul", intent: "close", target: "Ghost" }]);
	assert.equal(report.accepted, 0);
	assert.equal(lobby.map.tokens.Ghoul.order, undefined);
});

test("an order that names a square is refused outright", () => {
	// The one rule that keeps ADR 0027's split intact. A model that starts smuggling coordinates
	// into the target field must not have them honoured.
	const lobby = field();
	const report = applyOrders(lobby, [{ enemy: "Ghoul", intent: "close", target: "K3" }]);
	assert.equal(report.accepted, 0);
	assert.equal(lobby.map.tokens.Ghoul.order, undefined);
});

test("orders may not be given to the party", () => {
	// Otherwise the narrator plays the characters, which is nobody's idea of a good table.
	const lobby = field();
	const report = applyOrders(lobby, [{ enemy: "Near", intent: "withdraw" }]);
	assert.equal(report.accepted, 0);
	assert.equal(lobby.map.tokens.Near.order, undefined);
});

test("an order replaces the previous one rather than stacking", () => {
	const lobby = field();
	applyOrders(lobby, [{ enemy: "Ghoul", intent: "withdraw" }]);
	applyOrders(lobby, [{ enemy: "Ghoul", intent: "hold" }]);
	assert.equal(lobby.map.tokens.Ghoul.order.verb, "hold");
});

test("saying nothing leaves standing orders alone", () => {
	// Orders stand until changed, which is what lets them ride the reply the narrator was already
	// making instead of costing a second call.
	const lobby = field();
	applyOrders(lobby, [{ enemy: "Ghoul", intent: "withdraw" }]);
	applyOrders(lobby, []);
	assert.equal(lobby.map.tokens.Ghoul.order.verb, "withdraw");
});

test("malformed input is refused rather than thrown", () => {
	const lobby = field();
	for (const bad of [null, undefined, "close", 7, [null], [{}], [{ enemy: "Ghoul" }]]) {
		assert.equal(applyOrders(lobby, bad).accepted, 0, JSON.stringify(bad));
	}
});

test("orders do nothing at all when the feature is off", () => {
	const lobby = field();
	lobby[TACTICAL_SETTING] = false;
	const before = JSON.stringify(lobby);
	assert.equal(applyOrders(lobby, [{ enemy: "Ghoul", intent: "withdraw" }]).accepted, 0);
	assert.equal(JSON.stringify(lobby), before);
});

test("an accepted order actually changes what the creature does", () => {
	// The end-to-end assertion: an order is worthless if `moveEnemy` ignores it. Default would close
	// on Near; withdraw must send it the other way.
	const lobby = field();
	lobby.map.tokens.Near.cell = [9, 2];
	applyOrders(lobby, [{ enemy: "Ghoul", intent: "withdraw" }]);
	const before = distanceFeet(lobby.map, lobby.map.tokens.Ghoul.cell, lobby.map.tokens.Near.cell);
	moveEnemy(lobby, "Ghoul");
	assert.ok(distanceFeet(lobby.map, lobby.map.tokens.Ghoul.cell, lobby.map.tokens.Near.cell) > before);
});
