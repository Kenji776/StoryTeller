/**
 * Tests for the shared string helpers.
 *
 * @description `normaliseForMatch` exists because two modules needed the same answer to
 *   "did the player type this name?" — `actionFeasibility.js` for abilities and
 *   `spellbook.js` for spells — and each had grown its own copy. That is the shape of
 *   the armour-class defect: one rule, two implementations, and a silent divergence the
 *   moment either is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeName, normaliseForMatch } from "./utils.js";

// ── normaliseForMatch ────────────────────────────────────────────────────────

test("case is flattened so a typed name matches a catalogue name", () => {
	assert.equal(normaliseForMatch("Magic Missile"), "magic missile");
	assert.equal(normaliseForMatch("MAGIC MISSILE"), "magic missile");
});

test("punctuation becomes a separator, so hyphens and quotes do not defeat a match", () => {
	assert.equal(normaliseForMatch("magic-missile"), "magic missile");
	assert.equal(normaliseForMatch('"Fire Bolt"!'), "fire bolt");
	assert.equal(normaliseForMatch("Mordenkainen's Sword"), "mordenkainen s sword");
});

test("runs of whitespace collapse and the edges are trimmed", () => {
	assert.equal(normaliseForMatch("  magic   missile  "), "magic missile");
	assert.equal(normaliseForMatch("magic\n\tmissile"), "magic missile");
});

test("digits survive, because ability and enemy names carry them", () => {
	assert.equal(normaliseForMatch("Goblin 2"), "goblin 2");
});

test("a non-string is flattened to an empty string rather than throwing", () => {
	// Every caller feeds this untrusted input — a persisted record, or a player's text.
	for (const value of [null, undefined, 42, {}, []]) {
		assert.equal(typeof normaliseForMatch(value), "string");
	}
	assert.equal(normaliseForMatch(null), "");
	assert.equal(normaliseForMatch(undefined), "");
	assert.equal(normaliseForMatch(""), "");
});

test("a string of pure punctuation normalises to empty, not to spaces", () => {
	// Callers test the result for truthiness to decide whether a name was given at all.
	assert.equal(normaliseForMatch("---"), "");
	assert.equal(normaliseForMatch("   "), "");
});

test("normalising twice changes nothing", () => {
	for (const value of ["Magic Missile", "magic-missile!", "  Fire   Bolt "]) {
		assert.equal(normaliseForMatch(normaliseForMatch(value)), normaliseForMatch(value));
	}
});

// ── normalizeName, which is a different rule and must stay one ───────────────

test("normalizeName keeps case and punctuation, unlike normaliseForMatch", () => {
	// These two are not interchangeable: one prepares a name for display, the other for
	// comparison. Asserted so a later reader does not collapse them.
	assert.equal(normalizeName("Fire_Bolt"), "Fire Bolt");
	assert.equal(normaliseForMatch("Fire_Bolt"), "fire bolt");
});
