/**
 * Unit tests for inspectDMReply — the structural verdict on one raw DM reply.
 *
 * These pin the contract a model must satisfy to run a game at all. Every
 * assertion here corresponds to a way a real model has broken the game loop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDMReply, REQUIRED_KEYS, NULLABLE_KEYS, OPENING_KEYS } from "./dmReply.js";

/**
 * @description Builds a reply that satisfies the whole contract, so each test can
 *   break exactly one thing and attribute the finding to that break.
 * @param {object} [over] - Fields to override on the well-formed base.
 * @returns {string} The reply as a model would emit it.
 */
function goodReply(over = {}) {
	return JSON.stringify({
		text: "The door groans open onto a cold hall.",
		updates: {},
		prompt: "What do you do?",
		roll: null,
		suggestions: ["Listen at the door", "Light a torch"],
		spellUsed: false,
		music: "tension",
		combat_over: true,
		sfx: ["heavy door creak"],
		...over,
	});
}

// ── Happy path ───────────────────────────────────────────────────────────────

test("a well-formed reply parses cleanly with no findings", () => {
	const r = inspectDMReply(goodReply());
	assert.equal(r.parsed, true);
	assert.equal(r.cleanParse, true);
	assert.deepEqual(r.missingKeys, []);
	assert.deepEqual(r.typeErrors, []);
	assert.equal(r.usedFence, false);
	assert.equal(r.leadingProse, false);
	assert.equal(r.jsonInText, false);
	assert.equal(r.markdownInText, false);
	assert.equal(r.combatOver, true);
});

test("narration text and enemy roster are extracted for downstream scoring", () => {
	const r = inspectDMReply(goodReply({
		text: "Two goblins burst in.",
		combat_over: false,
		updates: {
			enemies: [
				{ name: "Goblin A", hp: 7, max_hp: 7, ac: 13, cr: "1/4", status: "active" },
				{ name: "Goblin B", hp: 0, max_hp: 7, ac: 13, cr: "1/4", status: "dead" },
			],
		},
	}));
	assert.equal(r.text, "Two goblins burst in.");
	assert.equal(r.enemies.length, 2);
	assert.equal(r.activeEnemies, 1);
	assert.equal(r.combatOver, false);
});

// ── Recoverable formatting faults ────────────────────────────────────────────

test("a fenced reply still parses but is flagged as fenced", () => {
	const r = inspectDMReply("```json\n" + goodReply() + "\n```");
	assert.equal(r.parsed, true);
	assert.equal(r.usedFence, true);
	assert.equal(r.cleanParse, false, "a fence means the raw body was not valid JSON");
});

test("prose before the JSON object is flagged", () => {
	const r = inspectDMReply("Sure! Here is the response:\n" + goodReply());
	assert.equal(r.parsed, true);
	assert.equal(r.leadingProse, true);
	assert.equal(r.cleanParse, false);
});

// ── Unrecoverable faults ─────────────────────────────────────────────────────

test("a reply with no JSON object at all does not parse", () => {
	const r = inspectDMReply("The goblins attack you with fury!");
	assert.equal(r.parsed, false);
	assert.equal(r.cleanParse, false);
	assert.deepEqual(r.enemies, []);
});

test("truncated JSON does not parse", () => {
	const r = inspectDMReply('{"text":"A hall","updates":{},"prompt":"go?"');
	assert.equal(r.parsed, false);
});

// ── Schema conformance ───────────────────────────────────────────────────────

test("every non-nullable required key is reported when the object is bare", () => {
	const r = inspectDMReply('{"text":"hi"}');
	assert.equal(r.parsed, true);
	const expected = REQUIRED_KEYS.filter((k) => k !== "text" && !NULLABLE_KEYS.includes(k)).sort();
	assert.deepEqual(r.missingKeys.sort(), expected);
});

test("a nullable key present as null is not missing and not a type error", () => {
	const r = inspectDMReply(goodReply({ roll: null, music: null }));
	assert.deepEqual(r.missingKeys, []);
	assert.deepEqual(r.typeErrors, []);
});

test("an omitted nullable key is not a fault, because the appliers cannot tell it from null", () => {
	// The schema declares `roll` and `music` as `X | null`, and every reader does a
	// falsy check. A model that omits the key produces byte-identical behaviour to one
	// that sends null, so charging it was marking models down for nothing.
	const reply = JSON.parse(goodReply());
	delete reply.roll;
	delete reply.music;
	const r = inspectDMReply(JSON.stringify(reply));
	assert.deepEqual(r.missingKeys, [], "omitting a nullable key has no consequence in the game loop");
	assert.deepEqual(r.typeErrors, []);
});

test("a non-nullable key is still reported when omitted", () => {
	const reply = JSON.parse(goodReply());
	delete reply.combat_over;
	const r = inspectDMReply(JSON.stringify(reply));
	assert.deepEqual(r.missingKeys, ["combat_over"],
		"the server cannot tell whether to purge the roster without this");
});

test("a caller may supply the key set a different prompt demands", () => {
	// The opening scene is asked for four keys, not nine. Judging it against the turn
	// schema charged every model for obeying the instructions it was actually given.
	const opening = JSON.stringify({ text: "You wake in a cold hall.", music: "tension", sfx: [], suggestions: ["Look around"] });
	const asOpening = inspectDMReply(opening, { requiredKeys: OPENING_KEYS });
	assert.deepEqual(asOpening.missingKeys, []);
	assert.deepEqual(asOpening.typeErrors, []);

	const asTurn = inspectDMReply(opening);
	assert.ok(asTurn.missingKeys.includes("combat_over"), "the turn schema is stricter and must stay so");
});

test("an unrecognised requiredKeys option falls back to the turn schema", () => {
	for (const bad of [null, undefined, 42, "text", {}, []]) {
		const r = inspectDMReply('{"text":"hi"}', { requiredKeys: bad });
		assert.ok(r.missingKeys.length > 0, `input ${JSON.stringify(bad)} should not disable checking`);
	}
});

test("combat_over sent as a string is a type error, not a missing key", () => {
	const r = inspectDMReply(goodReply({ combat_over: "false" }));
	assert.deepEqual(r.missingKeys, []);
	assert.ok(r.typeErrors.includes("combat_over"), `got ${JSON.stringify(r.typeErrors)}`);
	assert.equal(r.combatOver, null, "an unusable value must not be read as a verdict");
});

test("sfx sent as a bare string instead of an array is a type error", () => {
	const r = inspectDMReply(goodReply({ sfx: "sword clash" }));
	assert.ok(r.typeErrors.includes("sfx"));
});

test("an empty narration is a type error even though the key is present", () => {
	const r = inspectDMReply(goodReply({ text: "   " }));
	assert.ok(r.typeErrors.includes("text"));
});

test("updates sent as an array is a type error", () => {
	const r = inspectDMReply(goodReply({ updates: [] }));
	assert.ok(r.typeErrors.includes("updates"));
});

// ── Leakage into the narration ───────────────────────────────────────────────

test("raw JSON leaking into the narration is flagged", () => {
	const r = inspectDMReply(goodReply({ text: 'You enter. {"updates": {"hp": []}}' }));
	assert.equal(r.jsonInText, true);
});

test("markdown leaking into the narration is flagged", () => {
	const r = inspectDMReply(goodReply({ text: "You enter the **cold** hall." }));
	assert.equal(r.markdownInText, true);
});

test("permitted minimal HTML in the narration is not markdown", () => {
	const r = inspectDMReply(goodReply({ text: "You enter the <b>cold</b> hall." }));
	assert.equal(r.markdownInText, false);
	assert.equal(r.jsonInText, false);
});

// ── State events ─────────────────────────────────────────────────────────────

test("state event entries are counted by kind", () => {
	const r = inspectDMReply(goodReply({
		updates: {
			xp: [{ player: "Dorn", amount: 50, reason: "puzzle" }],
			hp: [{ player: "Dorn", delta: -3, reason: "claw", new_total: 7 }],
			inventory: [{ player: "Dorn", item: "Rope", change: 1, change_type: "add" }],
			gold: [{ player: "Dorn", delta: 12 }],
		},
	}));
	assert.equal(r.events.xp, 1);
	assert.equal(r.events.hp, 1);
	assert.equal(r.events.inventory, 1);
	assert.equal(r.events.gold, 1);
});

test("an hp entry missing its reason or new_total is flagged as malformed", () => {
	const r = inspectDMReply(goodReply({
		updates: { hp: [{ player: "Dorn", delta: -3 }] },
	}));
	assert.ok(r.malformedEvents.includes("hp"), `got ${JSON.stringify(r.malformedEvents)}`);
});

test("an inventory entry missing change_type is flagged as malformed", () => {
	const r = inspectDMReply(goodReply({
		updates: { inventory: [{ player: "Dorn", item: "Rope", change: 1 }] },
	}));
	assert.ok(r.malformedEvents.includes("inventory"));
});

test("an enemy stat block missing required fields is flagged", () => {
	const r = inspectDMReply(goodReply({
		combat_over: false,
		updates: { enemies: [{ name: "Goblin" }] },
	}));
	assert.ok(r.malformedEvents.includes("enemies"));
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("null, undefined and non-strings are handled without throwing", () => {
	for (const bad of [null, undefined, 42, {}, []]) {
		const r = inspectDMReply(bad);
		assert.equal(r.parsed, false, `input ${JSON.stringify(bad)} must not parse`);
		assert.equal(r.cleanParse, false);
		assert.deepEqual(r.typeErrors, []);
	}
});

test("an empty string does not parse", () => {
	assert.equal(inspectDMReply("").parsed, false);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("inspection is idempotent and does not mutate its input", () => {
	const raw = goodReply({ updates: { hp: [{ player: "Dorn", delta: -1, reason: "x", new_total: 9 }] } });
	const frozen = String(raw);
	const a = inspectDMReply(raw);
	const b = inspectDMReply(raw);
	assert.deepEqual(a, b);
	assert.equal(raw, frozen);
});
