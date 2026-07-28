/**
 * Tests for XP awarded from defeated enemies.
 *
 * @description XP was entirely at the Dungeon Master's discretion: the server
 *   awarded it only if the model chose to emit an `updates.xp` block, and across a
 *   full 30-turn playtest — including a confirmed goblin kill — it never once did.
 *   Every character finished at `xp: 0`, so levelling, the level-up event and every
 *   ability gained on level-up were unreachable in practice. The enemy stat blocks
 *   carried a challenge rating the whole time; nothing read it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { xpForChallengeRating, xpForKills } from "./experience.js";

// ===== The challenge-rating table =====

test("standard fractional ratings award their book values", () => {
	assert.equal(xpForChallengeRating("0"), 10);
	assert.equal(xpForChallengeRating("1/8"), 25);
	assert.equal(xpForChallengeRating("1/4"), 50);
	assert.equal(xpForChallengeRating("1/2"), 100);
});

test("whole-number ratings award their book values", () => {
	assert.equal(xpForChallengeRating("1"), 200);
	assert.equal(xpForChallengeRating("2"), 450);
	assert.equal(xpForChallengeRating("5"), 1800);
	assert.equal(xpForChallengeRating("10"), 5900);
});

test("a rating given as a number is read the same as its string form", () => {
	assert.equal(xpForChallengeRating(1), xpForChallengeRating("1"));
	assert.equal(xpForChallengeRating(0.25), xpForChallengeRating("1/4"));
	assert.equal(xpForChallengeRating(0.5), xpForChallengeRating("1/2"));
});

test("a rating beyond the table is clamped to the highest entry rather than dropped", () => {
	// The model invents ratings. Awarding nothing for a CR 40 dragon would be worse
	// than awarding the table maximum.
	assert.equal(xpForChallengeRating("40"), xpForChallengeRating("30"));
	assert.ok(xpForChallengeRating("40") > 0);
});

test("an unreadable rating awards nothing rather than NaN", () => {
	for (const bad of [null, undefined, "", "boss", {}, [], NaN, -3]) {
		const xp = xpForChallengeRating(bad);
		assert.equal(xp, 0, `cr ${JSON.stringify(bad)}`);
		assert.ok(Number.isFinite(xp));
	}
});

// ===== Splitting among the party =====

test("a kill is split evenly among the living party", () => {
	const awards = xpForKills([{ name: "Goblin", cr: "1/4" }], ["Ayla", "Brannor"]);
	assert.equal(awards.length, 2);
	assert.deepEqual(awards.map((a) => a.amount), [25, 25]);
	assert.deepEqual(awards.map((a) => a.player).sort(), ["Ayla", "Brannor"]);
});

test("the reason names the enemy, so the feed explains where the XP came from", () => {
	const [award] = xpForKills([{ name: "Goblin", cr: "1/4" }], ["Ayla"]);
	assert.match(award.reason, /Goblin/);
});

test("several kills in one turn are summed into one award per player", () => {
	const awards = xpForKills(
		[{ name: "Goblin", cr: "1/4" }, { name: "Wolf", cr: "1/4" }],
		["Ayla"],
	);
	assert.equal(awards.length, 1);
	assert.equal(awards[0].amount, 100);
	assert.match(awards[0].reason, /Goblin/);
	assert.match(awards[0].reason, /Wolf/);
});

test("an uneven split rounds down rather than inventing XP", () => {
	// 50 XP across 3 characters is 16.67; awarding 17 each would create XP.
	const awards = xpForKills([{ name: "Goblin", cr: "1/4" }], ["A", "B", "C"]);
	assert.deepEqual(awards.map((a) => a.amount), [16, 16, 16]);
});

test("a share that rounds below one still awards one, never zero", () => {
	const awards = xpForKills([{ name: "Rat", cr: "0" }], ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]);
	assert.ok(awards.every((a) => a.amount >= 1), JSON.stringify(awards));
});

// ===== Nothing to award =====

test("no kills means no awards", () => {
	assert.deepEqual(xpForKills([], ["Ayla"]), []);
});

test("an empty party yields no awards rather than dividing by zero", () => {
	const awards = xpForKills([{ name: "Goblin", cr: "1/4" }], []);
	assert.deepEqual(awards, []);
});

test("enemies worth nothing produce no award at all", () => {
	assert.deepEqual(xpForKills([{ name: "Illusion", cr: "nonsense" }], ["Ayla"]), []);
});

test("malformed arguments yield no awards rather than throwing", () => {
	for (const bad of [null, undefined, "kills", 7, {}]) {
		assert.deepEqual(xpForKills(bad, ["Ayla"]), [], `kills ${JSON.stringify(bad)}`);
		assert.deepEqual(xpForKills([{ name: "Goblin", cr: "1" }], bad), [], `party ${JSON.stringify(bad)}`);
	}
});

// ===== Properties =====

test("no more XP is handed out than the kills are worth", () => {
	for (const size of [1, 2, 3, 5, 7]) {
		const party = Array.from({ length: size }, (_, i) => `P${i}`);
		const awards = xpForKills([{ name: "Ogre", cr: "2" }], party);
		const handedOut = awards.reduce((n, a) => n + a.amount, 0);
		assert.ok(handedOut <= 450, `party of ${size} received ${handedOut} from a 450 XP kill`);
	}
});

test("every party member receives an equal share", () => {
	const awards = xpForKills([{ name: "Ogre", cr: "2" }], ["A", "B", "C"]);
	assert.equal(new Set(awards.map((a) => a.amount)).size, 1);
});
