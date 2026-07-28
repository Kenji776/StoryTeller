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

import { shouldForceEncounter, encounterDirective, QUIET_TURNS_BY_DIFFICULTY } from "./encounterPacing.js";

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

// ===== What the DM is told =====

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
