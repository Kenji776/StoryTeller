/**
 * Unit tests for analyseCombat — whether a fight behaved like a fight.
 *
 * Each violation named here is a way a model has made combat unplayable while
 * still returning perfectly valid JSON, which is why this is scored separately
 * from schema conformance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseCombat } from "./combatTrace.js";

/**
 * @description Builds the slice of an inspection that analyseCombat reads.
 * @param {number} active - Enemies still standing after this turn.
 * @param {boolean|null} over - The model's `combat_over` verdict.
 * @param {number} [listed] - Enemies present in the roster array; defaults to `active`.
 * @returns {object} A minimal inspection.
 */
const turn = (active, over, listed = active) =>
	({ activeEnemies: active, combatOver: over, events: { enemies: listed } });

// ── Happy path ───────────────────────────────────────────────────────────────

test("a multi-round fight that resolves cleanly has no violations", () => {
	const r = analyseCombat([
		turn(0, true),          // exploring
		turn(3, false),         // three enemies appear
		turn(3, false),         // one wounded, none dead
		turn(1, false),         // two down
		turn(0, true),          // cleared, and correctly declared over
		turn(0, true),          // back to exploring
	]);
	assert.deepEqual(r.violations, []);
	assert.equal(r.encounters, 1);
	assert.equal(r.combatTurns, 3);
	assert.equal(r.clean, true);
});

test("a run with no combat at all is clean and reports no encounters", () => {
	const r = analyseCombat([turn(0, true), turn(0, true)]);
	assert.equal(r.encounters, 0);
	assert.equal(r.combatTurns, 0);
	assert.deepEqual(r.violations, []);
	assert.equal(r.clean, true);
});

// ── Violations ───────────────────────────────────────────────────────────────

test("declaring combat over while enemies are still standing is a premature end", () => {
	const r = analyseCombat([turn(0, true), turn(2, false), turn(2, true)]);
	assert.equal(r.counts.prematureEnd, 1);
	assert.ok(r.violations.some((v) => v.kind === "prematureEnd" && v.turn === 2));
	assert.equal(r.clean, false);
});

test("a fight introduced and finished inside one turn is a one-turn wipe", () => {
	const r = analyseCombat([turn(0, true), turn(0, true, 2)]);
	assert.equal(r.counts.oneTurnWipe, 1);
	assert.ok(r.violations.some((v) => v.kind === "oneTurnWipe" && v.turn === 1));
});

test("dropping the roster mid-fight is recorded against the turn that dropped it", () => {
	const r = analyseCombat([turn(0, true), turn(2, false), turn(0, false, 0)]);
	assert.equal(r.counts.rosterDrop, 1);
	assert.ok(r.violations.some((v) => v.kind === "rosterDrop" && v.turn === 2));
});

test("an unreadable combat_over verdict is counted on every turn it occurs", () => {
	const r = analyseCombat([turn(1, null), turn(1, null)]);
	assert.equal(r.counts.missingVerdict, 2);
});

test("enemies still standing when the run ends is reported once, not per turn", () => {
	const r = analyseCombat([turn(0, true), turn(3, false), turn(3, false)]);
	assert.equal(r.counts.unresolved, 1);
	assert.ok(r.violations.some((v) => v.kind === "unresolved"));
});

test("each distinct fight is counted as its own encounter", () => {
	const r = analyseCombat([
		turn(2, false), turn(0, true),
		turn(0, true),
		turn(1, false), turn(0, true),
	]);
	assert.equal(r.encounters, 2);
});

test("a premature end and a roster drop on the same turn are both reported", () => {
	const r = analyseCombat([turn(0, true), turn(2, false), turn(2, true, 0)]);
	const kinds = r.violations.filter((v) => v.turn === 2).map((v) => v.kind).sort();
	assert.deepEqual(kinds, ["prematureEnd", "rosterDrop"]);
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("an empty run is clean with nothing to report", () => {
	const r = analyseCombat([]);
	assert.deepEqual(r.violations, []);
	assert.equal(r.encounters, 0);
	assert.equal(r.clean, true);
});

test("a single combat turn that never resolves is unresolved, not a wipe", () => {
	const r = analyseCombat([turn(2, false)]);
	assert.equal(r.counts.unresolved, 1);
	assert.equal(r.counts.oneTurnWipe, 0);
});

test("non-array and malformed input is tolerated rather than thrown on", () => {
	for (const bad of [null, undefined, 42, "turns", {}]) {
		const r = analyseCombat(bad);
		assert.equal(r.encounters, 0, `input ${JSON.stringify(bad)}`);
		assert.deepEqual(r.violations, []);
	}
});

test("entries missing the fields it reads are skipped without throwing", () => {
	const r = analyseCombat([{}, null, turn(1, false), turn(0, true)]);
	assert.equal(r.encounters, 1);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("violation count always equals the sum of its per-kind counts", () => {
	const r = analyseCombat([turn(0, true), turn(2, false), turn(2, true, 0), turn(1, null)]);
	const summed = Object.values(r.counts).reduce((a, b) => a + b, 0);
	assert.equal(r.violations.length, summed);
});

test("analysis does not mutate the inspections it is given", () => {
	const turns = [turn(0, true), turn(2, false)];
	const before = JSON.stringify(turns);
	analyseCombat(turns);
	assert.equal(JSON.stringify(turns), before);
});
