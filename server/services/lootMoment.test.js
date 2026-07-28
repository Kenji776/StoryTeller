/**
 * Tests for loot-moment detection.
 *
 * @description The server has to decide *before* it calls the model whether this turn
 *   is one where treasure could appear, because the reward must be in the prompt for
 *   the narration to describe it. The player's own words are the signal, and they are
 *   unambiguous far more often than not: the probed sessions used "I search the goblin
 *   bodies", "I work the lock on the iron-bound chest", "I look for treasure among the
 *   grave-goods".
 *
 *   The cases below are drawn from those transcripts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { detectLootMoment } from "./lootMoment.js";

/** A slain rabble, as the enemy roster holds them. */
const DEAD_GOBLINS = {
	"Goblin 1": { name: "Goblin 1", status: "dead", cr: "1/4" },
	"Goblin 2": { name: "Goblin 2", status: "dead", cr: "1/4" },
};

/** A slain champion. */
const DEAD_CHIEFTAIN = { Gurnak: { name: "Gurnak", status: "dead", cr: "7" } };

// ── Turns that are not about loot ────────────────────────────────────────────

test("an ordinary action is not a loot moment", () => {
	for (const action of [
		"I swing my shortsword at the nearest goblin.",
		"I ask the innkeeper about the road north.",
		"I cast Light on my holy symbol.",
		"I climb the rope to the ledge above.",
		"I wait and listen.",
	]) {
		assert.equal(detectLootMoment({ action, enemies: DEAD_GOBLINS }), null, `"${action}" was read as looting`);
	}
});

test("searching for something that is not treasure is not a loot moment", () => {
	// The distinction that matters: looking *for* a thing you named is a story beat,
	// not a payout.
	assert.equal(detectLootMoment({ action: "I search the crowd for my brother's face.", enemies: {} }), null);
	assert.equal(detectLootMoment({ action: "I search my memory for the name of the inn.", enemies: {} }), null);
});

test("missing and malformed input is not a loot moment", () => {
	for (const opts of [{}, { action: null }, { action: "" }, { action: 42 }, { action: "   " }]) {
		assert.equal(detectLootMoment(opts), null, `${JSON.stringify(opts)} was read as looting`);
	}
});

// ── Looting the dead ─────────────────────────────────────────────────────────

test("searching bodies after a fight is a loot moment scaled to what died", () => {
	const action = "I search the goblin bodies for anything useful — coin, weapons, anything they were carrying.";

	assert.equal(detectLootMoment({ action, enemies: DEAD_GOBLINS }).source, "trash");
	assert.equal(detectLootMoment({ action, enemies: DEAD_CHIEFTAIN }).source, "boss");
});

test("a mid-tier foe is worth more than rabble and less than a champion", () => {
	const action = "I loot the body.";
	const ogre = { Ogre: { name: "Ogre", status: "dead", cr: "2" } };

	assert.equal(detectLootMoment({ action, enemies: ogre }).source, "elite");
});

test("looting is recognised however the player phrases it", () => {
	for (const action of [
		"I loot the corpses.",
		"I rifle through the dead bandit's pockets.",
		"I strip the fallen of anything valuable.",
		"I scavenge what I can from the remains.",
		"I kneel beside Gurnak's body and take whatever he was carrying.",
	]) {
		assert.ok(detectLootMoment({ action, enemies: DEAD_CHIEFTAIN }), `"${action}" was not read as looting`);
	}
});

test("looting with nothing dead nearby is an ordinary search", () => {
	assert.equal(detectLootMoment({ action: "I search for anything valuable.", enemies: {} }).source, "search");
});

test("enemies still standing are not lootable", () => {
	const alive = { "Goblin 1": { name: "Goblin 1", status: "active", cr: "1/4" } };

	assert.equal(detectLootMoment({ action: "I search the bodies.", enemies: alive }).source, "search");
});

// ── Containers and hoards ────────────────────────────────────────────────────

test("opening a container is a cache, whatever else is in the room", () => {
	// A chest beats a corpse: the player named the more interesting target.
	const action = "I work the lock on the iron-bound chest with my thieves' tools and open it.";

	assert.equal(detectLootMoment({ action, enemies: DEAD_GOBLINS }).source, "cache");
	assert.equal(detectLootMoment({ action, enemies: DEAD_CHIEFTAIN }).source, "cache");
});

test("a hoard is recognised as a cache", () => {
	for (const action of [
		"I look for treasure among the grave-goods.",
		"I pry open the strongbox under the throne.",
		"I open the coffer at the foot of the bier.",
		"I search the hidden cache behind the bookshelf.",
	]) {
		assert.equal(detectLootMoment({ action, enemies: {} })?.source, "cache", `"${action}" was not read as a cache`);
	}
});

test("searching a room is a plain search, not a hoard", () => {
	const action = "I search the study carefully — the desk drawers, behind the books, under the rug — for anything hidden.";

	assert.equal(detectLootMoment({ action, enemies: {} }).source, "search");
});

// ── Boundaries ───────────────────────────────────────────────────────────────

test("an unreadable challenge rating does not promote rabble to a champion", () => {
	const nonsense = { Thing: { name: "Thing", status: "dead", cr: "banana" } };

	assert.equal(detectLootMoment({ action: "I loot the body.", enemies: nonsense }).source, "trash");
});

test("a fractional challenge rating is read as the fraction it is", () => {
	const rat = { Rat: { name: "Rat", status: "dead", cr: "1/8" } };

	assert.equal(detectLootMoment({ action: "I loot the body.", enemies: rat }).source, "trash");
});

test("the strongest of several dead sets the tier", () => {
	const mixed = { ...DEAD_GOBLINS, ...DEAD_CHIEFTAIN };

	assert.equal(detectLootMoment({ action: "I loot the bodies.", enemies: mixed }).source, "boss");
});

test("a missing enemy roster is treated as an empty one", () => {
	assert.equal(detectLootMoment({ action: "I loot the bodies." }).source, "search");
	assert.equal(detectLootMoment({ action: "I loot the bodies.", enemies: null }).source, "search");
});
