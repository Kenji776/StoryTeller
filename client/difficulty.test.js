/**
 * Tests for the difficulty dial.
 *
 * @description `difficulty` shaped encounter composition and the tone of the prompt
 *   and nothing else — it was four adjectives handed to a narrator. Once attacks and
 *   damage became deterministic (ADR 0018) that left the setting unable to affect the
 *   thing it is named after, and combat got materially harder for everyone at once: a
 *   level 3 fighter against AC 18 misses more than half the time, on Casual as
 *   readily as on Merciless.
 *
 *   These pin the modifiers themselves, because they are quoted verbatim to the host
 *   in the settings window. A number that changes here and not there is a lie told to
 *   the operator at setup.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { difficultyModifiers, describeDifficulty, DIFFICULTIES } from "./difficulty.js";

// ── The dial has a direction ─────────────────────────────────────────────────

test("every named difficulty is known", () => {
	// These four are what `setDifficulty` accepts and what the settings window offers.
	assert.deepEqual([...DIFFICULTIES], ["casual", "standard", "hardcore", "merciless"]);
});

test("standard changes nothing at all", () => {
	// The baseline has to be a true no-op, or "Standard" is a lie and every balance
	// judgement made before this existed silently shifts.
	assert.deepEqual(difficultyModifiers("standard"), {
		enemyAttackBonus: 0,
		enemyDamageMultiplier: 1,
		enemyHpMultiplier: 1,
		playerAttackBonus: 0,
	});
});

test("the dial moves monotonically from casual to merciless", () => {
	const order = DIFFICULTIES.map(difficultyModifiers);

	for (let i = 1; i < order.length; i++) {
		const softer = order[i - 1];
		const harder = order[i];
		assert.ok(harder.enemyAttackBonus >= softer.enemyAttackBonus, `enemy to-hit fell at step ${i}`);
		assert.ok(harder.enemyDamageMultiplier >= softer.enemyDamageMultiplier, `enemy damage fell at step ${i}`);
		assert.ok(harder.enemyHpMultiplier >= softer.enemyHpMultiplier, `enemy hit points fell at step ${i}`);
		assert.ok(harder.playerAttackBonus <= softer.playerAttackBonus, `player to-hit rose at step ${i}`);
	}
});

test("casual helps the party and merciless hinders it", () => {
	const casual = difficultyModifiers("casual");
	const merciless = difficultyModifiers("merciless");

	assert.ok(casual.enemyAttackBonus < 0 && casual.playerAttackBonus > 0);
	assert.ok(casual.enemyDamageMultiplier < 1 && casual.enemyHpMultiplier < 1);

	assert.ok(merciless.enemyAttackBonus > 0 && merciless.playerAttackBonus < 0);
	assert.ok(merciless.enemyDamageMultiplier > 1);
});

test("no difficulty above standard inflates enemy hit points", () => {
	// Measured, not assumed. A multiplier is disproportionate for a big monster —
	// ×1.4 adds three hit points to a goblin and twenty-four to an ogre — so the same
	// setting was a mild handicap against a horde and unwinnable against a single
	// brute: 78% versus 4% at one difficulty. Holding it at 1 collapsed that spread.
	// Scaling *down* on Casual is fine, because the same disproportion is a kindness.
	for (const name of ["standard", "hardcore", "merciless"]) {
		assert.equal(difficultyModifiers(name).enemyHpMultiplier, 1, `${name} scales enemy hit points`);
	}
	assert.ok(difficultyModifiers("casual").enemyHpMultiplier < 1);
});

test("hit chance is pushed harder than damage, because damage is what deletes a character", () => {
	// An attack bonus saturates: past a point every swing lands and more does nothing.
	// A damage multiplier compounds without limit, and is what turns a hard fight into
	// a character removed from the game in one blow.
	const merciless = difficultyModifiers("merciless");

	assert.ok(merciless.enemyAttackBonus >= 6, "the safe lever is not being used");
	assert.ok(merciless.enemyDamageMultiplier <= 2, "the dangerous lever is being over-used");
});

// ── Bad input ────────────────────────────────────────────────────────────────

test("an unknown difficulty falls back to standard rather than to nothing", () => {
	// A lobby saved before this existed, or a client sending nonsense, must play a
	// balanced game rather than one with undefined modifiers.
	for (const bad of [undefined, null, "", "nightmare", 7, {}, "CASUAL "]) {
		assert.deepEqual(difficultyModifiers(bad), difficultyModifiers("standard"), `${JSON.stringify(bad)} did not fall back`);
	}
});

test("the returned modifiers cannot be mutated by a caller", () => {
	// They are quoted to the host and used by three call sites; a caller editing the
	// shared object would change the rules for everyone mid-game. Frozen, so under
	// ESM's strict mode the attempt throws rather than silently succeeding — either
	// way the table must be intact afterwards.
	const mods = difficultyModifiers("hardcore");

	assert.throws(() => { mods.enemyDamageMultiplier = 99; }, TypeError);
	assert.equal(difficultyModifiers("hardcore").enemyDamageMultiplier, 1.5);
});

// ── What the host is told ────────────────────────────────────────────────────

test("every difficulty describes itself in the terms the modifiers actually use", () => {
	for (const name of DIFFICULTIES) {
		const lines = describeDifficulty(name);
		assert.ok(Array.isArray(lines) && lines.length, `${name} described nothing`);

		const text = lines.join(" ");
		assert.match(text, /enemies/i, `${name} does not mention enemies`);
	}
});

test("the description states the real numbers, not an adjective", () => {
	// The requirement this exists for: a host choosing a difficulty is told exactly
	// what it does. "Enemies are relentless" is not a mechanical statement.
	const merciless = describeDifficulty("merciless").join(" ");
	const mods = difficultyModifiers("merciless");

	assert.ok(merciless.includes(`+${mods.enemyAttackBonus}`), `"${merciless}" omits the enemy attack bonus`);
	assert.match(merciless, /\d+%/, "no percentage in the description");
});

test("standard says plainly that it changes nothing", () => {
	assert.match(describeDifficulty("standard").join(" "), /unmodified|no (change|adjustment)|straight/i);
});

test("an unknown difficulty is described as standard", () => {
	assert.deepEqual(describeDifficulty("nightmare"), describeDifficulty("standard"));
});

test("a modifier that does nothing is not listed", () => {
	// Hit points are no longer scaled above Standard, which rendered as "Enemies have
	// 0% hit points" — a line that reads as a bug and tells the host nothing.
	for (const name of ["hardcore", "merciless"]) {
		const text = describeDifficulty(name).join(" ");
		assert.doesNotMatch(text, /\b0%/, `${name} lists a no-op modifier`);
		assert.doesNotMatch(text, /are \+?0 to hit/, `${name} lists a no-op bonus`);
	}
});

test("a difficulty still describes everything it does change", () => {
	const hardcore = describeDifficulty("hardcore").join(" ");

	assert.match(hardcore, /\+6 to hit/);
	assert.match(hardcore, /\+50%/);
	assert.match(hardcore, /-1/);
});
