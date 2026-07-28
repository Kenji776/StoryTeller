/**
 * Tests for building a character portrait prompt.
 *
 * @description Two failures drove this. The prompt used seven of the sheet's fields
 *   — race, class, gender, age, height, weight, description — and ignored the
 *   equipment the character is visibly wearing and holding, so a plate-armoured
 *   paladin and a robed wizard of the same race produced the same picture. And
 *   generated images came back with words printed on them, lifted out of the prompt.
 *
 *   The module is deliberately free of imports so the browser and the server can
 *   share it: the player edits the prompt before sending, and the text they edit has
 *   to be the text that gets used.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildPortraitPrompt, finalisePrompt, NO_TEXT_GUARD } from "./portraitPrompt.js";

/**
 * @description A fully populated sheet, as `buildCurrentSheet` produces one.
 * @param {object} [over] - Fields to override.
 * @returns {object} The sheet.
 */
function sheet(over = {}) {
	return {
		name: "Brannor Ironfoot",
		race: "Dwarf", class: "Fighter", level: 3,
		gender: "male", age: "112", height: "4'5\"", weight: "180lb",
		alignment: "Lawful Good", background: "Soldier", deity: "Moradin",
		description: "A scar across one eye and a braided red beard.",
		stats: { str: 17, dex: 10, con: 15, int: 8, wis: 12, cha: 10, hp: 12, max_hp: 12 },
		weapon: { name: "Warhammer", damage: "1d8", damageType: "bludgeoning", range: "melee" },
		armor: { name: "Chain Mail", ac: 16, type: "heavy", material: "steel" },
		trinket: { name: "Iron Holy Symbol" },
		...over,
	};
}

// ===== The sheet actually reaches the prompt =====

test("physical description from the sheet is present", () => {
	const p = buildPortraitPrompt(sheet());
	for (const expected of ["Dwarf", "Fighter", "male", "112", "180lb"]) {
		assert.ok(p.includes(expected), `missing ${expected} in: ${p}`);
	}
});

test("the character's visible equipment is described", () => {
	// The old prompt ignored equipment entirely, so a plate-armoured knight and a
	// robed wizard of the same race produced the same portrait.
	const p = buildPortraitPrompt(sheet());
	assert.match(p, /Warhammer/);
	assert.match(p, /Chain Mail/);
	assert.match(p, /Iron Holy Symbol/);
});

test("the player's own description is carried through", () => {
	assert.match(buildPortraitPrompt(sheet()), /braided red beard/);
});

test("background and alignment inform bearing", () => {
	// Matched case-insensitively on purpose: the builder folds these into prose
	// ("a former soldier, lawful good in bearing"), and the contract is that the
	// information reaches the prompt, not that the sheet's capitalisation survives.
	const p = buildPortraitPrompt(sheet());
	assert.match(p, /soldier/i);
	assert.match(p, /lawful good/i);
});

test("physical build is inferred from the ability scores", () => {
	const strong = buildPortraitPrompt(sheet({ stats: { str: 18, dex: 8, con: 16, int: 8, wis: 10, cha: 10 } }));
	const nimble = buildPortraitPrompt(sheet({ stats: { str: 8, dex: 18, con: 10, int: 10, wis: 10, cha: 10 } }));
	assert.notEqual(strong, nimble);
	assert.match(strong, /powerful|muscular|heavy-set|brawny/i);
	assert.match(nimble, /lean|wiry|lithe|slender/i);
});

// ===== Text on the image =====

test("the character's name never appears in the prompt", () => {
	// A proper noun in an image prompt is the single most reliable way to get a
	// name plate, banner or signature rendered into the picture.
	const p = buildPortraitPrompt(sheet());
	assert.ok(!p.includes("Brannor"), p);
	assert.ok(!p.includes("Ironfoot"), p);
});

test("a name hidden in the free description is removed", () => {
	const p = buildPortraitPrompt(sheet({ description: "Brannor Ironfoot, a grizzled veteran." }));
	assert.ok(!p.includes("Brannor"), p);
	assert.match(p, /grizzled veteran/);
});

test("finalising a prompt appends the no-text guard", () => {
	assert.ok(finalisePrompt("A dwarf.").includes(NO_TEXT_GUARD));
});

test("the guard is appended even to a prompt the player rewrote entirely", () => {
	// The player owns the prompt, but not this part: they asked for no text, and a
	// prompt they pasted over would otherwise lose it.
	assert.ok(finalisePrompt("something completely different").includes(NO_TEXT_GUARD));
});

test("the guard is not duplicated if it is already there", () => {
	const once = finalisePrompt("A dwarf.");
	const twice = finalisePrompt(once);
	assert.equal(twice.split(NO_TEXT_GUARD).length - 1, 1, twice);
});

test("the guard does not itself name things that could be drawn as text", () => {
	// "no scrolls with writing" invites a scroll. The guard stays abstract.
	assert.ok(!/scroll|banner|book|sign\b/i.test(NO_TEXT_GUARD), NO_TEXT_GUARD);
});

// ===== Boundaries =====

test("a nearly empty sheet still yields a usable prompt", () => {
	for (const bad of [null, undefined, {}, { race: "" }]) {
		const p = buildPortraitPrompt(bad);
		assert.ok(p.length > 20, `too short for ${JSON.stringify(bad)}: ${p}`);
		assert.ok(!/undefined|null|NaN|\[object/.test(p), p);
	}
});

test("missing equipment is omitted rather than described as absent", () => {
	const p = buildPortraitPrompt(sheet({ weapon: null, armor: null, trinket: null }));
	assert.ok(!/null|undefined|no weapon|unarmed/i.test(p), p);
});

test("an over-long player prompt is capped", () => {
	const capped = finalisePrompt("word ".repeat(5000));
	assert.ok(capped.length <= 4000, `prompt was ${capped.length} chars`);
	assert.ok(capped.includes(NO_TEXT_GUARD), "the guard must survive capping");
});

test("a blank or non-string prompt falls back rather than sending nothing", () => {
	for (const bad of ["", "   ", null, undefined, 42, {}]) {
		const p = finalisePrompt(bad);
		assert.ok(p.length > NO_TEXT_GUARD.length, JSON.stringify(bad));
	}
});

test("the same sheet always produces the same prompt", () => {
	// The textarea is populated from this. A prompt that changed between renders
	// would overwrite what the player had typed.
	assert.equal(buildPortraitPrompt(sheet()), buildPortraitPrompt(sheet()));
});
