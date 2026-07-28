import { test } from "node:test";
import assert from "node:assert/strict";

import { parseIllustration, illustrationGate, ILLUSTRATION_MODES } from "./illustration.js";

/** Party members the DM may name, as the lobby knows them. */
const PARTY = [
	{ name: "Brannor Ironfoot", imageCharacterId: "chr_1" },
	{ name: "Kaeda Ashfall", imageCharacterId: "chr_2" },
	{ name: "Nim", imageCharacterId: null },
];

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);

// ── Reading the directive ────────────────────────────────────────────────────

test("a DM reply with no illustrate field asks for nothing", () => {
	for (const reply of [{ text: "You open the door." }, {}, null, undefined]) {
		assert.equal(parseIllustration(reply, { party: PARTY }), null);
	}
});

test("a moment naming party members becomes a per-character illustration", () => {
	const directive = parseIllustration({
		illustrate: { moment: "raising the warhammer over the slain troll", characters: ["Brannor Ironfoot"] },
	}, { party: PARTY });

	assert.equal(directive.kind, "characters");
	assert.equal(directive.moment, "raising the warhammer over the slain troll");
	assert.deepEqual(directive.characters.map((c) => c.imageCharacterId), ["chr_1"]);
});

test("a subject with no characters becomes a plain scene", () => {
	const directive = parseIllustration({
		illustrate: { subject: "a ruined watchtower on a cliff at dusk" },
	}, { party: PARTY });

	assert.equal(directive.kind, "scene");
	assert.equal(directive.prompt, "a ruined watchtower on a cliff at dusk");
});

test("a named character with no stored likeness is dropped, not drawn as a stranger", () => {
	const directive = parseIllustration({
		illustrate: { moment: "standing back to back", characters: ["Brannor Ironfoot", "Nim"] },
	}, { party: PARTY });

	assert.deepEqual(directive.characters.map((c) => c.name), ["Brannor Ironfoot"]);
});

test("a moment naming only characters without likenesses falls back to a plain scene", () => {
	const directive = parseIllustration({
		illustrate: { moment: "Nim vanishes into the crowd", characters: ["Nim"] },
	}, { party: PARTY });

	assert.equal(directive.kind, "scene", "a scene without the right faces still beats no picture");
	assert.match(directive.prompt, /vanishes into the crowd/);
});

test("a character the party does not contain is ignored", () => {
	const directive = parseIllustration({
		illustrate: { moment: "a duel", characters: ["Brannor Ironfoot", "Someone Else"] },
	}, { party: PARTY });

	assert.deepEqual(directive.characters.map((c) => c.name), ["Brannor Ironfoot"]);
});

test("names are matched without regard to case or surrounding space", () => {
	const directive = parseIllustration({
		illustrate: { moment: "a duel", characters: ["  brannor ironfoot "] },
	}, { party: PARTY });

	assert.equal(directive.characters.length, 1);
});

test("the mood travels with the directive when the DM gives one", () => {
	const directive = parseIllustration({
		illustrate: { moment: "over the slain troll", characters: ["Brannor Ironfoot"], mood: "triumphant" },
	}, { party: PARTY });

	assert.equal(directive.mood, "triumphant");
});

test("a directive with neither a moment nor a subject is nothing", () => {
	assert.equal(parseIllustration({ illustrate: { mood: "tense" } }, { party: PARTY }), null);
	assert.equal(parseIllustration({ illustrate: {} }, { party: PARTY }), null);
});

test("a directive that is not an object is ignored rather than throwing", () => {
	for (const value of ["yes", true, 42, []]) {
		assert.equal(parseIllustration({ illustrate: value }, { party: PARTY }), null);
	}
});

test("an absurdly long moment is clamped rather than forwarded whole", () => {
	const directive = parseIllustration({
		illustrate: { subject: "a castle ".repeat(500) },
	}, { party: PARTY });

	assert.ok(directive.prompt.length <= 600, `prompt was ${directive.prompt.length} characters`);
});

test("more characters than the party has are capped, since each one is a separate image", () => {
	const big = Array.from({ length: 12 }, (_, i) => ({ name: `Hero ${i}`, imageCharacterId: `chr_${i}` }));
	const directive = parseIllustration({
		illustrate: { moment: "charging", characters: big.map((h) => h.name) },
	}, { party: big });

	assert.ok(directive.characters.length <= 4, `would have drawn ${directive.characters.length} images in one turn`);
});

// ── Deciding whether to actually draw it ─────────────────────────────────────

test("the modes are the three an operator can choose between", () => {
	assert.deepEqual([...ILLUSTRATION_MODES], ["off", "key-moments", "generous"]);
});

test("illustrations are refused outright when the mode is off", () => {
	const gate = illustrationGate({ mode: "off", lastAt: null, now: T0 });
	assert.equal(gate.allowed, false);
	assert.match(gate.reason, /off|disabled/i);
});

test("the first illustration of a game is always allowed", () => {
	assert.equal(illustrationGate({ mode: "key-moments", lastAt: null, now: T0 }).allowed, true);
});

test("a second illustration too soon after the first is refused", () => {
	const gate = illustrationGate({ mode: "key-moments", lastAt: T0, now: T0 + MINUTE });
	assert.equal(gate.allowed, false);
	assert.match(gate.reason, /soon|cooldown|wait/i);
});

test("an illustration after the cooldown is allowed again", () => {
	assert.equal(illustrationGate({ mode: "key-moments", lastAt: T0, now: T0 + 30 * MINUTE }).allowed, true);
});

test("the generous mode waits less than the sparing one", () => {
	const t = T0 + 6 * MINUTE;
	assert.equal(illustrationGate({ mode: "key-moments", lastAt: T0, now: t }).allowed, false);
	assert.equal(illustrationGate({ mode: "generous", lastAt: T0, now: t }).allowed, true);
});

test("an unknown mode is treated as off, because guessing spends money", () => {
	const gate = illustrationGate({ mode: "whenever-you-like", lastAt: null, now: T0 });
	assert.equal(gate.allowed, false);
});

test("an absent mode is treated as off", () => {
	assert.equal(illustrationGate({ lastAt: null, now: T0 }).allowed, false);
});

test("the refusal explains itself, so a silent non-drawing is never a mystery", () => {
	for (const gate of [
		illustrationGate({ mode: "off", lastAt: null, now: T0 }),
		illustrationGate({ mode: "key-moments", lastAt: T0, now: T0 + MINUTE }),
	]) {
		assert.ok(gate.reason.length > 0);
	}
});
