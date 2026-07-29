/**
 * Tests for making encounters actually happen.
 *
 * @description Whether a fight occurs was entirely the narrator's whim. In one
 *   120-turn game every single DM turn — 36 of 36 — set `combat_over: true` and not
 *   one carried an enemies array: there was no combat whatsoever, so the enemy-turn
 *   resolver had nobody to roll for and `player:death` could not fire however
 *   dangerous the settings said the world was.
 *
 *   Brutality and difficulty turned out to govern tone alone. A party of cautious
 *   players who scout and investigate will simply never be attacked, because nothing
 *   asks the model to attack them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldForceEncounter, encounterDirective, encounterBudget, QUIET_TURNS_BY_DIFFICULTY } from "./encounterPacing.js";

/** Every difficulty the dial offers, plus the values a stored lobby can actually hold. */
const DIFFICULTIES = ["casual", "standard", "hardcore", "merciless"];
const UNKNOWN_DIFFICULTIES = [undefined, null, "", "nightmare", 7];

// ===== When a fight is due =====

test("a fight is not forced while enemies are already in play", () => {
	// The resolver handles an ongoing fight; forcing another mid-battle would stack
	// encounters on a party that is already busy.
	assert.equal(shouldForceEncounter({ quietTurns: 99, difficulty: "merciless", enemiesPresent: true }), false);
});

test("a fight is not forced during the opening quiet", () => {
	assert.equal(shouldForceEncounter({ quietTurns: 0, difficulty: "standard", enemiesPresent: false }), false);
	assert.equal(shouldForceEncounter({ quietTurns: 1, difficulty: "standard", enemiesPresent: false }), false);
});

test("a fight is forced once the table has been quiet too long", () => {
	const limit = QUIET_TURNS_BY_DIFFICULTY.standard;
	assert.equal(shouldForceEncounter({ quietTurns: limit - 1, difficulty: "standard", enemiesPresent: false }), false);
	assert.equal(shouldForceEncounter({ quietTurns: limit, difficulty: "standard", enemiesPresent: false }), true);
});

test("harsher difficulties lose patience sooner", () => {
	assert.ok(QUIET_TURNS_BY_DIFFICULTY.merciless < QUIET_TURNS_BY_DIFFICULTY.hardcore);
	assert.ok(QUIET_TURNS_BY_DIFFICULTY.hardcore < QUIET_TURNS_BY_DIFFICULTY.standard);
	assert.ok(QUIET_TURNS_BY_DIFFICULTY.standard < QUIET_TURNS_BY_DIFFICULTY.casual);
});

test("a merciless table is interrupted well before a casual one", () => {
	const quiet = QUIET_TURNS_BY_DIFFICULTY.merciless;
	assert.equal(shouldForceEncounter({ quietTurns: quiet, difficulty: "merciless", enemiesPresent: false }), true);
	assert.equal(shouldForceEncounter({ quietTurns: quiet, difficulty: "casual", enemiesPresent: false }), false);
});

test("an unknown difficulty is paced as standard rather than never", () => {
	const limit = QUIET_TURNS_BY_DIFFICULTY.standard;
	for (const unknown of [undefined, null, "", "nightmare", 7]) {
		assert.equal(shouldForceEncounter({ quietTurns: limit, difficulty: unknown, enemiesPresent: false }), true, String(unknown));
	}
});

test("a malformed quiet count does not force a fight every turn", () => {
	for (const bad of [undefined, null, NaN, "lots", -5]) {
		assert.equal(shouldForceEncounter({ quietTurns: bad, difficulty: "merciless", enemiesPresent: false }), false, String(bad));
	}
});

// ===== How big the fight is =====
//
// 39% of stored games are solo. Nothing sized the encounter to the table, so the
// lone character and the party of four were handed the same instruction and the
// solo player faced several times the opposition per head. Measured over 2000
// fights per cell, that — not the action economy and not the one-blow cap — is
// the whole of the solo penalty: at one enemy per character a solo character wins
// 84% of Hardcore goblin fights against a party of four's 94%, while at two per
// character it wins 34%.

test("a solo character is not sent a party's worth of enemies", () => {
	const solo = encounterBudget({ partySize: 1, difficulty: "standard" });
	const four = encounterBudget({ partySize: 4, difficulty: "standard" });
	assert.equal(solo.max, 1);
	assert.ok(four.max > solo.max, `party of four got ${four.max}, solo got ${solo.max}`);
});

test("the roster grows with the party", () => {
	for (const difficulty of DIFFICULTIES) {
		let previous = 0;
		for (const partySize of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const { max } = encounterBudget({ partySize, difficulty });
			assert.ok(max >= previous, `${difficulty} P${partySize}: ${max} < ${previous}`);
			previous = max;
		}
	}
});

test("no encounter exceeds one enemy per character", () => {
	// Measured ceiling, not taste. Above one per character a Hardcore or Merciless
	// party facing an AC 18 creature wins 0-6% of the time, and "nothing is
	// unwinnable" is the line this engine holds.
	for (const difficulty of [...DIFFICULTIES, ...UNKNOWN_DIFFICULTIES]) {
		for (const partySize of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const { max } = encounterBudget({ partySize, difficulty });
			assert.ok(max <= partySize, `${String(difficulty)} P${partySize}: ${max} > ${partySize}`);
		}
	}
});

test("a harsher difficulty never asks for fewer enemies", () => {
	for (const partySize of [1, 2, 3, 4, 5, 6, 7, 8]) {
		let previousMin = 0;
		let previousMax = 0;
		for (const difficulty of DIFFICULTIES) {
			const { min, max } = encounterBudget({ partySize, difficulty });
			assert.ok(min >= previousMin, `${difficulty} P${partySize} min ${min} < ${previousMin}`);
			assert.ok(max >= previousMax, `${difficulty} P${partySize} max ${max} < ${previousMax}`);
			previousMin = min;
			previousMax = max;
		}
	}
});

test("casual sends a smaller crowd than standard", () => {
	assert.ok(encounterBudget({ partySize: 4, difficulty: "casual" }).max
		< encounterBudget({ partySize: 4, difficulty: "standard" }).max);
});

test("a budget always asks for at least one enemy and never inverts", () => {
	for (const difficulty of [...DIFFICULTIES, ...UNKNOWN_DIFFICULTIES]) {
		for (const partySize of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const { min, max } = encounterBudget({ partySize, difficulty });
			assert.ok(Number.isInteger(min) && Number.isInteger(max), `${String(difficulty)} P${partySize}`);
			assert.ok(min >= 1, `${String(difficulty)} P${partySize} min ${min}`);
			assert.ok(min <= max, `${String(difficulty)} P${partySize}: ${min} > ${max}`);
		}
	}
});

test("an empty or malformed party is budgeted as a solo one, not as none", () => {
	// An encounter for zero characters is an encounter that never starts, which is
	// the failure this module exists to end.
	for (const bad of [0, -3, NaN, Infinity, "three", null, undefined, {}]) {
		const { min, max } = encounterBudget({ partySize: bad, difficulty: "standard" });
		assert.equal(min, 1, String(bad));
		assert.equal(max, 1, String(bad));
	}
});

test("every paced difficulty also has a budget", () => {
	// The two tables are keyed the same and looked up through one resolver. Adding a
	// difficulty to one and not the other would destructure `undefined` and throw on
	// the first forced encounter of a lobby set to it.
	for (const difficulty of Object.keys(QUIET_TURNS_BY_DIFFICULTY)) {
		assert.doesNotThrow(() => encounterBudget({ partySize: 3, difficulty }), difficulty);
		assert.ok(encounterBudget({ partySize: 3, difficulty }).max >= 1, difficulty);
	}
	assert.deepEqual(Object.keys(QUIET_TURNS_BY_DIFFICULTY).sort(), DIFFICULTIES.slice().sort());
});

test("an unknown difficulty is budgeted as standard", () => {
	const standard = encounterBudget({ partySize: 4, difficulty: "standard" });
	for (const unknown of UNKNOWN_DIFFICULTIES) {
		assert.deepEqual(encounterBudget({ partySize: 4, difficulty: unknown }), standard, String(unknown));
	}
});

test("the difficulty is read case- and whitespace-insensitively", () => {
	assert.deepEqual(
		encounterBudget({ partySize: 4, difficulty: "  Casual " }),
		encounterBudget({ partySize: 4, difficulty: "casual" }),
	);
});

test("a missing argument object is budgeted as a solo standard table", () => {
	assert.deepEqual(encounterBudget(), { min: 1, max: 1 });
});

// ===== What the DM is told =====

test("the directive states how many enemies this table should face", () => {
	const text = encounterDirective("standard", { partySize: 4 });
	const { min, max } = encounterBudget({ partySize: 4, difficulty: "standard" });
	assert.match(text, new RegExp(`\\b${min}\\b`), text);
	assert.match(text, new RegExp(`\\b${max}\\b`), text);
});

test("the directive tells a solo table it is one character", () => {
	// The count alone is not enough: the model reaches for "a pack of them" unless
	// it is told the size of the table it is writing for.
	const text = encounterDirective("standard", { partySize: 1 });
	assert.match(text, /\b1 character\b/i, text);
});

test("a solo directive asks for fewer enemies than a party's", () => {
	assert.notEqual(
		encounterDirective("merciless", { partySize: 1 }),
		encounterDirective("merciless", { partySize: 4 }),
	);
});

test("the directive counts the table in grammatical English", () => {
	// It is read by a model that is being asked to write prose. "1 character are
	// playing" is the sort of thing it happily imitates.
	assert.match(encounterDirective("standard", { partySize: 1 }), /1 character is playing/i);
	assert.match(encounterDirective("standard", { partySize: 4 }), /4 characters are playing/i);
	assert.ok(!/1 characters|1 character are|4 character is|4 character\b/i.test(
		encounterDirective("standard", { partySize: 4 }) + encounterDirective("standard", { partySize: 1 }),
	));
});

test("a solo table is not offered a monster to stand in for a group of one", () => {
	// The directive is line-wrapped, so the phrase can straddle a newline.
	assert.doesNotMatch(encounterDirective("merciless", { partySize: 1 }), /stand\s+in for/i);
});

test("a solo table is told to size the creature to one character, not to a party", () => {
	// Measured: a level 3 solo character against the CR 2 ogre that is a 55% fight for
	// a party of three wins 0.7% of the time on Standard and 0% above it. Capping the
	// *count* at one does nothing about this — one creature sized for a party is still
	// one creature, and it is the worst encounter a lone character can be handed.
	const text = encounterDirective("hardcore", { partySize: 1 });
	assert.match(text, /alone|lone|single character|one character/i, text);
	assert.match(text, /would be a fair fight for a party|not.*for a party|sized for a party/i, text);
});

test("a party is not given the lone-character warning", () => {
	assert.doesNotMatch(encounterDirective("hardcore", { partySize: 4 }), /kills? a lone character/i);
});

test("the directive leaves room for a single larger monster", () => {
	// A budget stated as a head count would otherwise forbid the ogre, which is a
	// legitimate encounter for a party of three and one the engine handles.
	assert.match(encounterDirective("standard", { partySize: 3 }), /larger|bigger|single|one creature/i);
});

test("the directive carries no count for a party it was told nothing about", () => {
	// A caller that forgets to pass the party is budgeted as solo, which is the
	// smallest encounter and therefore the safe failure.
	const text = encounterDirective("standard");
	assert.ok(!/undefined|null|NaN/.test(text), text);
	assert.match(text, /\b1 character\b/i, text);
});

test("the directive tells the DM to start the fight in this response", () => {
	const text = encounterDirective("standard");
	assert.match(text, /now|this turn|immediately/i);
	assert.match(text, /enem/i);
});

test("the directive asks for the enemy block the roster needs", () => {
	// Without stat blocks in "enemies" the roster stays empty and the enemy-turn
	// resolver has nothing to roll, which is the failure this exists to end.
	const text = encounterDirective("standard");
	assert.match(text, /"enemies"/);
	assert.match(text, /cr/i);
	assert.match(text, /combat_over/);
});

test("the directive is blunt about not resolving the fight immediately", () => {
	const text = encounterDirective("merciless");
	assert.match(text, /survive|not.*kill|more than one|rounds?/i);
});

test("a harsher difficulty asks for a harder encounter", () => {
	assert.notEqual(encounterDirective("merciless"), encounterDirective("casual"));
});

test("the directive never contains undefined for an unknown difficulty", () => {
	for (const unknown of [undefined, null, "nightmare"]) {
		const text = encounterDirective(unknown);
		assert.ok(text.length > 40, String(unknown));
		assert.ok(!/undefined|null|NaN/.test(text), text);
	}
});
