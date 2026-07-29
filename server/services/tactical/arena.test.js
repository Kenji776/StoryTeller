/**
 * Tests for arena generation.
 *
 * @description Two invariants carry this module, and both are worth more than any amount of
 *   interesting scenery:
 *
 *   - **Every spawn is in one walkable region.** A party that cannot reach the enemy has a
 *     softlock, not a hard fight, and there is no in-game way out of it.
 *   - **Nobody starts in melee.** Spawning adjacent means the first enemy round lands before
 *     anyone has chosen anything, which reads as the engine cheating.
 *
 *   Assertions are on those properties rather than on cell coordinates. Pinning where the
 *   third pillar landed would mean any tweak to the palette breaks a dozen tests while telling
 *   nobody anything — `TDD-6`, in a place where it is tempting to do the opposite because the
 *   output is so concrete.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { generateArena, ARCHETYPES, arenaSize } from "./arena.js";
import { walkableRegion } from "./movement.js";
import { cellLabel, inBounds, featureAt, distanceCells, FEATURE_RULES } from "./grid.js";

const PARTY = ["Dorn", "Kestra", "Almath", "Oduin"];
const ENEMIES = ["Ghoul 1", "Ghoul 2", "Ghoul 3"];

/**
 * @description Generates with sensible defaults.
 * @param {object} [over] - Overrides.
 * @returns {object} A map.
 */
function build(over = {}) {
	return generateArena({ party: PARTY, enemies: ENEMIES, seed: 1234, ...over });
}

/**
 * @description Collects the cells every token stands on.
 * @param {object} map - The generated map.
 * @returns {string[]} Labels.
 */
const occupied = (map) => Object.values(map.tokens).map((t) => cellLabel(t.cell));

// ── Shape ───────────────────────────────────────────────────────────────────

test("a generated arena has the shape the rest of the feature reads", () => {
	const map = build();
	assert.equal(typeof map.seed, "number");
	assert.ok(map.width > 0 && map.height > 0);
	assert.equal(map.feetPerCell, 5);
	assert.ok(Array.isArray(map.features));
	assert.ok(Array.isArray(map.landmarks));
	assert.equal(typeof map.tokens, "object");
	assert.ok(ARCHETYPES[map.archetype], "the archetype must be a real one");
});

test("every named creature gets exactly one token", () => {
	const map = build();
	assert.deepEqual(Object.keys(map.tokens).sort(), [...PARTY, ...ENEMIES].sort());
});

test("the party and the enemies are on opposing factions", () => {
	const map = build();
	for (const name of PARTY) assert.equal(map.tokens[name].faction, "party");
	for (const name of ENEMIES) assert.equal(map.tokens[name].faction, "enemy");
});

test("every token carries the fields movement and reach need", () => {
	// A token missing `speedFeet` would silently fall back to the default, which is right for
	// a legacy sheet and wrong for something generated here and now.
	for (const token of Object.values(build().tokens)) {
		assert.ok(Number.isFinite(token.speedFeet), "speed");
		assert.ok(Number.isFinite(token.reachFeet), "reach");
		assert.equal(token.size, 1);
	}
});

test("every token stands on the map, and no two share a cell", () => {
	const map = build();
	const cells = occupied(map);
	for (const token of Object.values(map.tokens)) assert.ok(inBounds(map, token.cell));
	assert.equal(new Set(cells).size, cells.length, "two creatures in one square");
});

test("no token is standing inside scenery", () => {
	const map = build();
	for (const [name, token] of Object.entries(map.tokens)) {
		const feature = featureAt(map, token.cell);
		const blocked = feature && FEATURE_RULES[feature.kind]?.movement === "blocked";
		assert.ok(!blocked, `${name} spawned inside a ${feature?.kind}`);
	}
});

test("every feature lies on the map", () => {
	const map = build();
	for (const feature of map.features) {
		for (const cell of feature.cells) assert.ok(inBounds(map, cell), `${feature.kind} at ${cellLabel(cell)}`);
	}
});

test("every feature kind placed is one the rules table describes", () => {
	// A palette naming scenery nobody wrote a rule for would behave as open floor, and the
	// arena would look furnished while playing empty.
	for (const feature of build().features) {
		assert.ok(FEATURE_RULES[feature.kind], `${feature.kind} has no rule`);
	}
});

// ── The two invariants ──────────────────────────────────────────────────────

test("every creature can reach every other, across many seeds", () => {
	// The invariant that matters most. Checked over a spread of seeds because a generator is
	// only as good as its worst roll, and a single seed proves nothing about the rest.
	for (let seed = 0; seed < 60; seed++) {
		const map = build({ seed });
		const region = walkableRegion(map, map.tokens[PARTY[0]].cell);
		for (const [name, token] of Object.entries(map.tokens)) {
			assert.ok(region.has(cellLabel(token.cell)),
				`seed ${seed}: ${name} at ${cellLabel(token.cell)} is cut off from the party`);
		}
	}
});

test("nobody starts within reach of an enemy", () => {
	for (let seed = 0; seed < 60; seed++) {
		const map = build({ seed });
		for (const friend of PARTY) {
			for (const foe of ENEMIES) {
				const gap = distanceCells(map, map.tokens[friend].cell, map.tokens[foe].cell);
				assert.ok(gap > 1, `seed ${seed}: ${friend} and ${foe} start ${gap} cells apart`);
			}
		}
	}
});

test("an ambush is allowed to start close, and says so", () => {
	// The exception exists so a deliberate ambush is expressible. It has to be asked for, and
	// the map records that it was, so nothing downstream mistakes it for a generation fault.
	const map = build({ ambush: true, seed: 5 });
	assert.equal(map.ambush, true);
});

test("an ordinary arena is not marked as an ambush", () => {
	assert.equal(build().ambush, false);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test("the same seed lays out the same room", () => {
	// The reason the seed is persisted: a lobby read back from disk must not rearrange its own
	// furniture.
	assert.deepEqual(build({ seed: 42 }), build({ seed: 42 }));
});

test("different seeds lay out different rooms", () => {
	assert.notDeepEqual(build({ seed: 1 }), build({ seed: 2 }));
});

test("the seed used is recorded on the map", () => {
	// So a bad arena can be reported, reproduced and fixed by seed alone.
	assert.equal(build({ seed: 777 }).seed, 777);
});

test("a missing seed still produces a valid arena", () => {
	// Generation is called from the turn pipeline. A caller that forgets the seed should get a
	// playable room, not an exception.
	const map = generateArena({ party: PARTY, enemies: ENEMIES });
	assert.ok(Number.isFinite(map.seed));
	assert.equal(Object.keys(map.tokens).length, PARTY.length + ENEMIES.length);
});

// ── Sizing ──────────────────────────────────────────────────────────────────

test("an arena is big enough to hold everyone with room to move", () => {
	const size = arenaSize(4, 3, ARCHETYPES.crypt);
	assert.ok(size.width * size.height > (4 + 3) * 4, "cramped");
});

test("a bigger fight gets a bigger room", () => {
	const small = arenaSize(1, 1, ARCHETYPES.crypt);
	const large = arenaSize(6, 8, ARCHETYPES.crypt);
	assert.ok(large.width * large.height > small.width * small.height);
});

test("an arena never exceeds the column limit a label can express", () => {
	// `cellLabel` runs out at Z, and returning null there would break every prompt and every
	// click. The cap belongs here, where the width is chosen.
	const size = arenaSize(20, 40, ARCHETYPES.crypt);
	assert.ok(size.width <= 26, `width ${size.width} cannot be labelled`);
});

test("a long archetype is longer than it is wide", () => {
	const size = arenaSize(4, 3, ARCHETYPES.corridor);
	assert.ok(size.width > size.height, `${size.width}x${size.height} is not a corridor`);
});

// ── Awkward inputs ──────────────────────────────────────────────────────────

test("a solo character against one enemy still gets a playable arena", () => {
	const map = generateArena({ party: ["Solo"], enemies: ["Rat"], seed: 3 });
	const region = walkableRegion(map, map.tokens.Solo.cell);
	assert.ok(region.has(cellLabel(map.tokens.Rat.cell)));
	assert.ok(distanceCells(map, map.tokens.Solo.cell, map.tokens.Rat.cell) > 1);
});

test("a crowd fits", () => {
	const party = Array.from({ length: 6 }, (_, i) => `P${i}`);
	const enemies = Array.from({ length: 10 }, (_, i) => `E${i}`);
	const map = generateArena({ party, enemies, seed: 9 });
	assert.equal(Object.keys(map.tokens).length, 16);
	assert.equal(new Set(occupied(map)).size, 16);
});

test("no enemies means no arena, because there is no fight to lay out", () => {
	assert.equal(generateArena({ party: PARTY, enemies: [], seed: 1 }), null);
});

test("no party means no arena either", () => {
	assert.equal(generateArena({ party: [], enemies: ENEMIES, seed: 1 }), null);
	assert.equal(generateArena({ seed: 1 }), null);
});

test("an unknown archetype falls back to a real one rather than throwing", () => {
	// The narrator is allowed to hint an archetype, and it invents words.
	const map = build({ archetype: "shimmering_void" });
	assert.ok(ARCHETYPES[map.archetype]);
});

test("a named archetype is honoured", () => {
	assert.equal(build({ archetype: "corridor" }).archetype, "corridor");
});

test("blank and duplicate names are dropped rather than colliding", () => {
	const map = generateArena({ party: ["A", "", null, "A"], enemies: ["B"], seed: 4 });
	assert.deepEqual(Object.keys(map.tokens).sort(), ["A", "B"]);
});

test("every archetype in the table generates a valid arena", () => {
	// Adding an archetype is meant to be a data change. This is what keeps that true.
	for (const name of Object.keys(ARCHETYPES)) {
		for (const seed of [1, 2, 3]) {
			const map = build({ archetype: name, seed });
			const region = walkableRegion(map, map.tokens[PARTY[0]].cell);
			for (const [who, token] of Object.entries(map.tokens)) {
				assert.ok(region.has(cellLabel(token.cell)), `${name}/${seed}: ${who} is cut off`);
			}
		}
	}
});
