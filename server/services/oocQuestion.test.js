/**
 * Tests for recognising an out-of-character question.
 *
 * @description The server had no concept of one. "ooc how do spell slots work in
 *   this game?" was handed to the narrator as a game action, which answered it with
 *   a generic 5e lecture — spell slots by level, recovered on a long rest — that
 *   describes a system this game does not use. It has one shared pool covering
 *   every ability, martial and magical alike.
 *
 *   The answer was then broadcast to all three players as DM narration and appended
 *   to the story history the DM is re-prompted with, so the wrong rules became part
 *   of its own context for every later turn. It also consumed the asker's turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isOutOfCharacter, buildRulesPrompt } from "./oocQuestion.js";

// ===== Recognised forms =====

test("the ooc prefix is recognised and stripped", () => {
	const result = isOutOfCharacter("ooc how do spell slots work in this game?");
	assert.equal(result.isOoc, true);
	assert.equal(result.question, "how do spell slots work in this game?");
});

test("the prefix is recognised whatever its case", () => {
	for (const prefix of ["ooc", "OOC", "Ooc", "oOc"]) {
		assert.equal(isOutOfCharacter(`${prefix} what is my AC?`).isOoc, true, prefix);
	}
});

test("common punctuation after the prefix is accepted", () => {
	for (const text of ["ooc: what is my AC?", "ooc, what is my AC?", "ooc - what is my AC?", "(ooc) what is my AC?"]) {
		const result = isOutOfCharacter(text);
		assert.equal(result.isOoc, true, text);
		assert.equal(result.question, "what is my AC?", text);
	}
});

test("double slashes are accepted, as table shorthand", () => {
	const result = isOutOfCharacter("// can I use my ability twice?");
	assert.equal(result.isOoc, true);
	assert.equal(result.question, "can I use my ability twice?");
});

test("double parentheses are accepted, as table shorthand", () => {
	const result = isOutOfCharacter("((am I still poisoned?))");
	assert.equal(result.isOoc, true);
	assert.equal(result.question, "am I still poisoned?");
});

test("leading whitespace does not hide the prefix", () => {
	assert.equal(isOutOfCharacter("   ooc what now?").isOoc, true);
});

// ===== In-character actions must never be diverted =====

test("an ordinary action is in character", () => {
	assert.equal(isOutOfCharacter("I swing my sword at the goblin.").isOoc, false);
});

test("a word merely beginning with the letters ooc is in character", () => {
	// A character can be occupied, and a place can be an oocyte-strewn horror.
	for (const text of ["I occupy the doorway.", "I look at the oocysts on the wall."]) {
		assert.equal(isOutOfCharacter(text).isOoc, false, text);
	}
});

test("an action that merely mentions being out of character is in character", () => {
	assert.equal(isOutOfCharacter("I stay in character and press on.").isOoc, false);
});

test("a lone prefix with no question is not treated as a question", () => {
	// Nothing to answer; better to let it fall through than to ask the model to
	// answer an empty string.
	for (const text of ["ooc", "ooc   ", "//", "(())"]) {
		assert.equal(isOutOfCharacter(text).isOoc, false, JSON.stringify(text));
	}
});

// ===== Boundaries =====

test("malformed input is in character rather than throwing", () => {
	for (const bad of [null, undefined, 42, {}, [], true, ""]) {
		const result = isOutOfCharacter(bad);
		assert.equal(result.isOoc, false, JSON.stringify(bad));
		assert.equal(result.question, "");
	}
});

test("a very long question is capped rather than passed on whole", () => {
	const result = isOutOfCharacter("ooc " + "why ".repeat(500));
	assert.equal(result.isOoc, true);
	assert.ok(result.question.length <= 500, `question was ${result.question.length} chars`);
});

// ── Answering from this game's rules, not the model's memory of 5e ───────────


/**
 * @description A capability for a level-1 fighter with two of three uses left.
 * @returns {object} The capability shape `buildCapability` produces.
 */
function cap() {
	return {
		identity: { name: "Brannor Ironfoot", className: "Fighter", race: "Dwarf", level: 1 },
		health: { hp: 9, maxHp: 12, dead: false },
		resources: { slots: { remaining: 2, max: 3, unlimited: false }, gold: 5 },
		abilities: [{ name: "Second Wind", description: "Catch your breath." }],
		inventory: [{ name: "Healing Potion", count: 2 }],
		conditions: ["poisoned"],
		equipped: { weapon: { name: "Shortsword" }, armor: { name: "Chain Shirt" }, armorClass: 13 },
	};
}

test("the prompt states this game's shared pool, not 5e spell slots by level", () => {
	const prompt = buildRulesPrompt("how do spell slots work?", cap());
	assert.match(prompt, /shared/i);
	assert.match(prompt, /2 of 3/);
	// The specific wrongness that shipped: per-level slot tables recovered on a long rest.
	assert.match(prompt, /do not|never/i);
});

test("the prompt carries the asker's own sheet so answers are specific", () => {
	const prompt = buildRulesPrompt("what can I do?", cap());
	assert.match(prompt, /Brannor Ironfoot/);
	assert.match(prompt, /Second Wind/);
	assert.match(prompt, /Healing Potion/);
	assert.match(prompt, /poisoned/);
	assert.match(prompt, /9\/12/);
});

test("an unlimited pool is described in words", () => {
	const c = cap();
	c.resources.slots = { remaining: Infinity, max: null, unlimited: true };
	const prompt = buildRulesPrompt("how many uses do I get?", c);
	assert.match(prompt, /unlimited/i);
	assert.ok(!/Infinity|null|NaN/.test(prompt), prompt);
});

test("the question itself is included", () => {
	assert.match(buildRulesPrompt("what is my AC?", cap()), /what is my AC\?/);
});

test("a missing capability still yields a usable prompt", () => {
	for (const bad of [null, undefined, {}]) {
		const prompt = buildRulesPrompt("what now?", bad);
		assert.ok(prompt.length > 0);
		assert.ok(!/undefined|NaN/.test(prompt), prompt);
	}
});

test("the prompt tells the answerer to stay out of the fiction", () => {
	// The failure being closed: the answer was published as in-story narration.
	const prompt = buildRulesPrompt("how do slots work?", cap());
	assert.match(prompt, /not narration|do not narrate|not the dungeon master|out of character/i);
});
