import test from "node:test";
import assert from "node:assert/strict";
import { toFeedEntry, matchesFilter, FEED_TYPES } from "./feed.js";

/** A frozen clock, so entries are comparable (TDD-8). */
const now = () => 1_700_000_000_000;

/** Formats one event with the clock pinned. */
const entry = (event, payload, deps = {}) => toFeedEntry(event, payload, { now, ...deps });

test("an XP award names the player, the amount, the reason and the new total", () => {
	assert.deepEqual(entry("xp:update", { player: "Mira", amount: 200, reason: "Solved the riddle", xp: 1650 }), {
		type: "xp",
		message: "Mira gained 200 XP (Solved the riddle) — now 1650 XP",
		at: now(),
	});
});

test("a negative adjustment reads as a loss rather than a gain of a negative", () => {
	assert.match(entry("xp:update", { player: "Mira", amount: -50, reason: "Cursed", xp: 1400 }).message,
		/Mira lost 50 XP/);
});

test("damage and healing are both signed so the direction is unambiguous", () => {
	assert.match(entry("hp:update", { player: "Bran", delta: -6, reason: "Axe", hp: 16 }).message,
		/Bran -6 HP \(Axe\) — now 16 HP/);
	assert.match(entry("hp:update", { player: "Bran", delta: 4, reason: "Potion", hp: 20 }).message,
		/Bran \+4 HP/);
});

test("gold changes are signed the same way", () => {
	assert.match(entry("gold:update", { player: "Mira", delta: 25, reason: "Loot", gold: 365 }).message, /\+25 gold/);
	assert.match(entry("gold:update", { player: "Mira", delta: -10, reason: "Bribe", gold: 330 }).message, /-10 gold/);
});

test("an update with no stated reason still produces a readable line", () => {
	assert.match(entry("xp:update", { player: "Mira", amount: 10, xp: 20 }).message, /Manual adjustment/);
});

test("a turn change names who is up and the order behind them", () => {
	const line = entry("turn:update", { current: "Bran", order: ["Mira", "Bran", "Talia"], round: 4 });
	assert.equal(line.type, "turn");
	assert.match(line.message, /Bran/);
	assert.match(line.message, /Mira, Bran, Talia/);
});

test("narration is reduced to plain text through the injected renderer", () => {
	const line = entry("narration", { content: "<p>The door <em>creaks</em> open.</p>" }, {
		toText: (html) => html.replace(/<[^>]+>/g, ""),
	});
	assert.equal(line.type, "dm");
	assert.equal(line.message, "The door creaks open.");
});

test("narration longer than the excerpt limit is cut and marked", () => {
	const line = entry("narration", { content: "x".repeat(400) });
	assert.equal(line.message.length, 300);
	assert.ok(line.message.endsWith("…"));
});

test("a contentless narration produces no entry at all", () => {
	// The TTS path emits a contentless twin of every narration; rendering it printed
	// a bare "null" line in the feed for every DM beat.
	assert.equal(entry("narration", { content: null }), null);
	assert.equal(entry("narration", { content: "" }), null);
	assert.equal(entry("narration", { content: "   " }), null);
	assert.equal(entry("narration", {}), null);
	assert.equal(entry("narration", { content: 42 }), null);
});

test("a death uses the server's message when it sent one", () => {
	assert.equal(entry("player:death", { player: "Talia", message: "Talia is crushed by falling rock." }).message,
		"Talia is crushed by falling rock.");
});

test("a death falls back to naming the player when no message was sent", () => {
	assert.match(entry("player:death", { player: "Talia" }).message, /Talia has died/);
});

test("music changes read as words, and stopping is its own line", () => {
	assert.match(entry("music:change", { mood: "tense_combat" }).message, /tense combat/);
	assert.match(entry("music:change", { mood: null }).message, /stopped/i);
});

test("sound effects are listed by name", () => {
	assert.match(entry("sfx:play", { effects: [{ name: "sword clash" }, { file: "roar.mp3" }] }).message,
		/sword clash, roar\.mp3/);
});

test("an empty sound effect burst produces no entry", () => {
	assert.equal(entry("sfx:play", { effects: [] }), null);
	assert.equal(entry("sfx:play", {}), null);
});

test("a required roll states the die and the stats it draws on", () => {
	const line = entry("roll:required", { player: "Mira", sides: 20, stats: ["dex", "wis"] });
	assert.equal(line.type, "roll");
	assert.match(line.message, /Mira must roll d20 \(dex, wis\)/);
});

test("a roll result reports both the die and the total", () => {
	assert.match(entry("dice:result", { player: "Mira", roll: 14, total: 17, sides: 20 }).message,
		/Mira rolled d20: 14 \(total: 17\)/);
});

test("conditions list what the player now has, or that they have none", () => {
	assert.match(entry("conditions:update", { player: "Mira", conditions: ["poisoned", "prone"] }).message,
		/poisoned, prone/);
	assert.match(entry("conditions:update", { player: "Mira", conditions: [] }).message, /none/);
});

test("an inventory change is signed and reports the resulting count", () => {
	assert.match(entry("inventory:update", { player: "Mira", item: "Torch", change: 2, newCount: 5 }).message,
		/Mira \+2 Torch \(now: 5\)/);
});

test("system-level events are grouped under one type", () => {
	for (const [event, payload] of [
		["spellslots:update", { player: "Mira", spellSlotsUsed: 1, maxSlots: 3 }],
		["player:kicked", { reason: "Removed by an admin" }],
		["rest:vote:start", { type: "long", proposer: "Bran" }],
		["rest:vote:result", { type: "long", passed: true }],
		["game:over", { reason: "The party fell" }],
		["toast", { type: "error", message: "Something failed" }],
	]) {
		assert.equal(entry(event, payload).type, "sys", `${event} should be a system line`);
	}
});

test("a level up is XP news", () => {
	assert.equal(entry("player:levelup", { newLevel: 4 }).type, "xp");
	assert.match(entry("player:levelup", { newLevel: 4 }).message, /level 4/);
});

test("an unrecognised event is dropped rather than rendered as an object", () => {
	assert.equal(entry("some:future:event", { a: 1 }), null);
	assert.equal(entry("", {}), null);
	assert.equal(entry(null, {}), null);
	assert.equal(entry(undefined), null);
});

test("an event with no payload does not throw", () => {
	assert.doesNotThrow(() => entry("xp:update"));
	assert.doesNotThrow(() => entry("turn:update"));
	assert.doesNotThrow(() => entry("conditions:update"));
});

test("every entry is stamped from the injected clock", () => {
	assert.equal(entry("toast", { message: "hello" }).at, now());
});

test("every type an entry can carry is offered by the filter control", () => {
	// Otherwise an event class exists that no filter can isolate.
	const offered = new Set(FEED_TYPES.map((t) => t.id));
	const produced = [
		["xp:update", { player: "a", amount: 1, xp: 1 }],
		["hp:update", { player: "a", delta: 1, hp: 1 }],
		["gold:update", { player: "a", delta: 1, gold: 1 }],
		["turn:update", { current: "a", order: [] }],
		["narration", { content: "x" }],
		["player:death", { player: "a" }],
		["music:change", { mood: "calm" }],
		["sfx:play", { effects: [{ name: "x" }] }],
		["roll:required", { player: "a", sides: 20, stats: [] }],
		["conditions:update", { player: "a", conditions: [] }],
		["inventory:update", { player: "a", item: "x", change: 1, newCount: 1 }],
		["toast", { message: "x" }],
	].map(([event, payload]) => entry(event, payload).type);

	for (const type of produced) {
		assert.equal(offered.has(type), true, `filter list is missing "${type}"`);
	}
});

test("the filter list leads with an option that shows everything", () => {
	assert.equal(FEED_TYPES[0].id, "all");
});

test("the all filter keeps every entry", () => {
	assert.equal(matchesFilter({ type: "xp" }, "all"), true);
	assert.equal(matchesFilter({ type: "sys" }, "all"), true);
});

test("a specific filter keeps only its own type", () => {
	assert.equal(matchesFilter({ type: "xp" }, "xp"), true);
	assert.equal(matchesFilter({ type: "hp" }, "xp"), false);
});

test("an unknown or absent filter shows everything rather than hiding the log", () => {
	assert.equal(matchesFilter({ type: "xp" }, "nonsense"), true);
	assert.equal(matchesFilter({ type: "xp" }, null), true);
	assert.equal(matchesFilter({ type: "xp" }, undefined), true);
});

test("matchesFilter rejects a missing entry rather than throwing", () => {
	assert.equal(matchesFilter(null, "xp"), false);
	assert.equal(matchesFilter(undefined, "all"), false);
});
