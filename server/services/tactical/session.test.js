/**
 * Tests for the tactical session — the layer that owns a lobby's map.
 *
 * @description This is the first part of the feature that touches lobby state, so the guard that
 *   matters most is the toggle: with `tacticalCombat` off, nothing here may write a single field.
 *   A map that exists and is ignored is not the same as a feature that is off, and the difference
 *   is the whole safety argument in [ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	TACTICAL_SETTING, RANGE_FEET,
	isTactical, speedFeetFor, ensureArena, syncTokens, clearArena, applyMove, reachCheck,
} from "./session.js";
import { cellLabel, distanceCells } from "./grid.js";

/**
 * @description Builds a lobby in the shape the store actually persists.
 * @param {object} [over] - Fields to override.
 * @returns {object} A lobby.
 */
function lobby(over = {}) {
	return {
		lobbyId: "lob1",
		[TACTICAL_SETTING]: true,
		players: {
			"Dorn Hammerfall": { name: "Dorn Hammerfall", race: "Dwarf", level: 1, stats: { hp: 10, max_hp: 10 } },
			"Sister Almath": { name: "Sister Almath", race: "Human", level: 1, stats: { hp: 7, max_hp: 10 } },
		},
		enemies: {
			"Ghoul 1": { name: "Ghoul 1", hp: 11, max_hp: 11, ac: 12, cr: "1", status: "active" },
			"Ghoul 2": { name: "Ghoul 2", hp: 11, max_hp: 11, ac: 12, cr: "1", status: "active" },
		},
		...over,
	};
}

/** @description Places two tokens a known distance apart on a featureless map, for reach tests. */
function facing(gapCells, features = []) {
	const state = lobby();
	ensureArena(state);
	state.map.width = 12;
	state.map.height = 3;
	state.map.features = features;
	state.map.tokens = {
		"Dorn Hammerfall": { faction: "party", cell: [0, 1], size: 1, speedFeet: 25, reachFeet: 5 },
		"Ghoul 1": { faction: "enemy", cell: [gapCells, 1], size: 1, speedFeet: 30, reachFeet: 5 },
	};
	return state;
}

// ── The toggle ──────────────────────────────────────────────────────────────

test("tactical combat is off unless a lobby turns it on", () => {
	assert.equal(isTactical({}), false);
	assert.equal(isTactical(null), false);
	assert.equal(isTactical({ [TACTICAL_SETTING]: false }), false);
	assert.equal(isTactical({ [TACTICAL_SETTING]: true }), true);
});

test("a truthy-but-not-true setting does not switch the feature on", () => {
	// Settings arrive from a browser. "off" is a string, and a string is truthy.
	assert.equal(isTactical({ [TACTICAL_SETTING]: "off" }), false);
	assert.equal(isTactical({ [TACTICAL_SETTING]: 1 }), false);
});

test("with the feature off, ensureArena writes nothing at all", () => {
	// The guarantee the whole design rests on. Not "a map that is ignored" — no map, and no
	// field touched, so the off path is indistinguishable from the feature not existing.
	const state = lobby({ [TACTICAL_SETTING]: false });
	const before = JSON.stringify(state);
	assert.equal(ensureArena(state), null);
	assert.equal(JSON.stringify(state), before);
});

test("with the feature off, nothing else writes either", () => {
	const state = lobby({ [TACTICAL_SETTING]: false });
	const before = JSON.stringify(state);
	syncTokens(state);
	clearArena(state);
	assert.equal(applyMove(state, "Dorn Hammerfall", "B2").ok, false);
	assert.equal(reachCheck(state, "Dorn Hammerfall", "Ghoul 1").ok, false);
	assert.equal(JSON.stringify(state), before);
});

// ── Speed ───────────────────────────────────────────────────────────────────

test("a dwarf walks twenty-five feet and a human thirty", () => {
	assert.equal(speedFeetFor({ race: "Dwarf" }), 25);
	assert.equal(speedFeetFor({ race: "Human" }), 30);
});

test("race is matched whatever the casing or spacing", () => {
	assert.equal(speedFeetFor({ race: "  halfling " }), 25);
	assert.equal(speedFeetFor({ race: "GNOME" }), 25);
});

test("an unstated or invented race walks at the ordinary pace", () => {
	// Races are free text and the narrator invents them; guessing slow would be a stealth nerf.
	for (const race of [undefined, null, "", "Aarakocra", 42]) {
		assert.equal(speedFeetFor({ race }), 30, String(race));
	}
	assert.equal(speedFeetFor(null), 30);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test("an arena appears once there is something to fight", () => {
	const state = lobby();
	const map = ensureArena(state);
	assert.ok(map);
	assert.equal(state.map, map, "and is stored on the lobby");
	assert.deepEqual(Object.keys(map.tokens).sort(),
		["Dorn Hammerfall", "Ghoul 1", "Ghoul 2", "Sister Almath"]);
});

test("no arena without enemies, because there is no fight to lay out", () => {
	assert.equal(ensureArena(lobby({ enemies: {} })), null);
	assert.equal(ensureArena(lobby({ enemies: null })), null);
});

test("an enemy already dead does not summon an arena", () => {
	const dead = { "Ghoul 1": { name: "Ghoul 1", hp: 0, status: "dead", cr: "1" } };
	assert.equal(ensureArena(lobby({ enemies: dead })), null);
});

test("a dead character is not placed on the map", () => {
	const state = lobby();
	state.players["Sister Almath"].dead = true;
	const map = ensureArena(state);
	assert.equal("Sister Almath" in map.tokens, false);
});

test("calling ensureArena again returns the same room rather than a new one", () => {
	// It runs on every action, so it has to be idempotent or the room would be rebuilt — and
	// everybody teleported — on each turn.
	const state = lobby();
	const first = ensureArena(state);
	const firstJSON = JSON.stringify(first);
	assert.equal(ensureArena(state), first);
	assert.equal(JSON.stringify(state.map), firstJSON);
});

test("the same lobby and the same opposition lay out the same room", () => {
	assert.deepEqual(ensureArena(lobby()), ensureArena(lobby()));
});

test("a different lobby lays out a different room", () => {
	assert.notDeepEqual(ensureArena(lobby()), ensureArena(lobby({ lobbyId: "other" })));
});

test("a token carries the speed its character walks at", () => {
	const map = ensureArena(lobby());
	assert.equal(map.tokens["Dorn Hammerfall"].speedFeet, 25, "the dwarf");
	assert.equal(map.tokens["Sister Almath"].speedFeet, 30, "the human");
});

test("clearing the arena removes it, because a map only exists during a fight", () => {
	const state = lobby();
	ensureArena(state);
	clearArena(state);
	assert.equal(state.map, undefined);
});

// ── Keeping the roster in step ──────────────────────────────────────────────

test("an enemy the narrator adds mid-fight gets a token", () => {
	const state = lobby();
	ensureArena(state);
	state.enemies["Ghoul 3"] = { name: "Ghoul 3", hp: 11, status: "active", cr: "1" };
	syncTokens(state);
	assert.ok(state.map.tokens["Ghoul 3"], "the newcomer is on the map");
});

test("a newcomer does not appear within reach of anybody", () => {
	// Arriving already in melee gives the party no chance to respond, which reads as the
	// engine cheating rather than as a reinforcement.
	const state = lobby();
	ensureArena(state);
	state.enemies["Ghoul 3"] = { name: "Ghoul 3", hp: 11, status: "active", cr: "1" };
	syncTokens(state);
	const arrival = state.map.tokens["Ghoul 3"].cell;
	for (const name of ["Dorn Hammerfall", "Sister Almath"]) {
		assert.ok(distanceCells(state.map, arrival, state.map.tokens[name].cell) > 1, name);
	}
});

test("syncing never moves anyone who is already standing somewhere", () => {
	// The invariant that makes this safe to call every turn.
	const state = lobby();
	ensureArena(state);
	const before = Object.fromEntries(
		Object.entries(state.map.tokens).map(([name, t]) => [name, cellLabel(t.cell)]));
	state.enemies["Ghoul 3"] = { name: "Ghoul 3", hp: 11, status: "active", cr: "1" };
	syncTokens(state);
	for (const [name, label] of Object.entries(before)) {
		assert.equal(cellLabel(state.map.tokens[name].cell), label, name);
	}
});

test("a fallen enemy leaves the map", () => {
	const state = lobby();
	ensureArena(state);
	state.enemies["Ghoul 1"].status = "dead";
	state.enemies["Ghoul 1"].hp = 0;
	syncTokens(state);
	assert.equal("Ghoul 1" in state.map.tokens, false);
});

test("a fallen character leaves the map too", () => {
	const state = lobby();
	ensureArena(state);
	state.players["Sister Almath"].dead = true;
	syncTokens(state);
	assert.equal("Sister Almath" in state.map.tokens, false);
});

test("syncing a lobby with no map does nothing rather than throwing", () => {
	const state = lobby();
	syncTokens(state);
	assert.equal(state.map, undefined);
});

// ── Moving ──────────────────────────────────────────────────────────────────

test("a legal move updates the position and reports what it cost", () => {
	const state = facing(6);
	const result = applyMove(state, "Dorn Hammerfall", "C2");
	assert.equal(result.ok, true);
	assert.equal(result.costFeet, 10);
	assert.equal(cellLabel(state.map.tokens["Dorn Hammerfall"].cell), "C2");
});

test("a move beyond the character's speed is refused, and they do not budge", () => {
	// Refused rather than clamped. Clamping would leave somebody standing where nobody chose,
	// which is the silent wrongness this project keeps removing.
	// H2 is seven cells off, and a dwarf's 25 feet buys five. Not J2, which is where the ghoul
	// is standing — that would test occupancy and quietly stop testing distance.
	const state = facing(9);
	const result = applyMove(state, "Dorn Hammerfall", "H2");
	assert.equal(result.ok, false);
	assert.match(result.reason, /too far/i);
	assert.match(result.reason, /35 feet/, "and says what it would have cost");
	assert.equal(cellLabel(state.map.tokens["Dorn Hammerfall"].cell), "A2");
});

test("a move into scenery is refused", () => {
	const state = facing(9, [{ id: "w", kind: "wall", cells: [[1, 1]] }]);
	assert.equal(applyMove(state, "Dorn Hammerfall", "B2").ok, false);
});

test("a move onto somebody else is refused", () => {
	const state = facing(3);
	assert.equal(applyMove(state, "Dorn Hammerfall", "D2").ok, false);
});

test("standing still is a legal move", () => {
	const state = facing(6);
	const result = applyMove(state, "Dorn Hammerfall", "A2");
	assert.equal(result.ok, true);
	assert.equal(result.costFeet, 0);
});

test("a move takes a label or a cell, since one comes from a sentence and one from a click", () => {
	assert.equal(applyMove(facing(6), "Dorn Hammerfall", [2, 1]).ok, true);
	assert.equal(applyMove(facing(6), "Dorn Hammerfall", "C2").ok, true);
});

test("a move by somebody who is not on the map is refused with a reason", () => {
	const result = applyMove(facing(6), "Nobody", "B2");
	assert.equal(result.ok, false);
	assert.match(result.reason, /not on the map/i);
});

test("nonsense destinations are refused rather than throwing", () => {
	for (const bad of [null, undefined, "banana", "Z99", [99, 99], {}]) {
		assert.equal(applyMove(facing(6), "Dorn Hammerfall", bad).ok, false, JSON.stringify(bad));
	}
});

// ── Reach and range ─────────────────────────────────────────────────────────

test("an adjacent enemy is in reach of a sword", () => {
	const result = reachCheck(facing(1), "Dorn Hammerfall", "Ghoul 1");
	assert.equal(result.ok, true);
	assert.equal(result.distanceFeet, 5);
	assert.equal(result.cover, "none");
});

test("an enemy across the room is not, and the refusal says how far away they are", () => {
	// The point of the whole phase: out of reach becomes a settled fact rather than something
	// the narrator waves through.
	const result = reachCheck(facing(6), "Dorn Hammerfall", "Ghoul 1");
	assert.equal(result.ok, false);
	assert.equal(result.distanceFeet, 30);
	assert.match(result.reason, /30 feet/);
});

test("a ranged attack reaches across the same room", () => {
	const result = reachCheck(facing(6), "Dorn Hammerfall", "Ghoul 1", { range: "ranged" });
	assert.equal(result.ok, true);
	assert.equal(RANGE_FEET.ranged, 60);
});

test("range words are what the spell catalogue speaks, and they map to feet here", () => {
	assert.equal(reachCheck(facing(2), "Dorn Hammerfall", "Ghoul 1", { range: "touch" }).ok, false);
	assert.equal(reachCheck(facing(1), "Dorn Hammerfall", "Ghoul 1", { range: "touch" }).ok, true);
});

test("an explicit distance in feet wins over a word", () => {
	assert.equal(reachCheck(facing(4), "Dorn Hammerfall", "Ghoul 1", { rangeFeet: 20 }).ok, true);
	assert.equal(reachCheck(facing(5), "Dorn Hammerfall", "Ghoul 1", { rangeFeet: 20 }).ok, false);
});

test("an unknown range word falls back to reach rather than to infinity", () => {
	// A spell whose range nobody recognised should not become a sniper rifle.
	assert.equal(reachCheck(facing(6), "Dorn Hammerfall", "Ghoul 1", { range: "yonder" }).ok, false);
});

test("a wall between two creatures denies the shot outright", () => {
	const state = facing(6, [{ id: "w", kind: "wall", cells: [[3, 1], [3, 0], [3, 2]] }]);
	const result = reachCheck(state, "Dorn Hammerfall", "Ghoul 1", { range: "ranged" });
	assert.equal(result.ok, false);
	assert.match(result.reason, /line of sight|no clear/i);
});

test("cover is reported so the resolver can add it to armour class", () => {
	const state = facing(6, [{ id: "l", kind: "low_wall", cells: [[3, 1]] }]);
	const result = reachCheck(state, "Dorn Hammerfall", "Ghoul 1", { range: "ranged" });
	assert.equal(result.ok, true);
	assert.equal(result.cover, "half");
	assert.equal(result.acBonus, 2);
});

test("a reach check against somebody not on the map is refused", () => {
	assert.equal(reachCheck(facing(1), "Dorn Hammerfall", "Nobody").ok, false);
	assert.equal(reachCheck(facing(1), "Nobody", "Ghoul 1").ok, false);
});

test("a reach check with no map at all is refused rather than throwing", () => {
	assert.equal(reachCheck(lobby(), "Dorn Hammerfall", "Ghoul 1").ok, false);
});
