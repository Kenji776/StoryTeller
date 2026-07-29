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

import { normalizeName, normaliseForMatch, containsPhrase } from "./utils.js";

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

// ── containsPhrase ───────────────────────────────────────────────────────────

test("a phrase is found as whole words", () => {
	assert.equal(containsPhrase("I cast fire bolt at the goblin", "Fire Bolt"), true);
	assert.equal(containsPhrase("I cast cure wounds on Brannor", "Brannor"), true);
});

test("a phrase inside a longer word is not a match", () => {
	// The two live false positives this exists to stop.
	assert.equal(containsPhrase("I delight in the chaos", "Light"), false);
	assert.equal(containsPhrase("I always cast cure wounds", "Al"), false);
});

test("case, punctuation and spacing do not defeat a match", () => {
	assert.equal(containsPhrase("i cast MAGIC-MISSILE!", "Magic Missile"), true);
	assert.equal(containsPhrase("I cast  fire   bolt", "fire bolt"), true);
});

test("an empty or missing side is never a match", () => {
	for (const [text, phrase] of [["", "Al"], ["I cast", ""], [null, "Al"], ["I cast", null], [undefined, undefined]]) {
		assert.equal(containsPhrase(text, phrase), false, `${JSON.stringify([text, phrase])}`);
	}
});

test("a phrase of pure punctuation cannot match everything", () => {
	// It normalises to "", and an empty needle must not be treated as always present.
	assert.equal(containsPhrase("I cast fire bolt", "---"), false);
});

test("non-string input is tolerated rather than thrown on", () => {
	assert.equal(containsPhrase(42, 42), true, "both normalise to \"42\"");
	assert.equal(containsPhrase({}, []), false);
});
