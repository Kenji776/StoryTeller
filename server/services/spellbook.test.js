/**
 * Tests for the spellbook.
 *
 * @description The defect these describe: `classProgression.json` has no level-1 entry
 *   for any class, and there was no spell list anywhere in the project. A level-1 caster
 *   therefore knew nothing, so `hardChecks` rejected "I cast magic missile" as an
 *   unknown ability *and took a strike for it* — while the vague "I cast a spell" passed
 *   and fell through to a flat 15/8 ladder rolling `int` for every class. 102 of the 115
 *   characters in stored lobbies are level 1, and a third of them are casters.
 *
 *   A caster knows a *chosen* list, not their whole class list: cantrips at will, plus a
 *   small number of levelled spells that grows by one pick per level.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	castingAbility,
	isCaster,
	maxSpellLevel,
	spellsAvailableTo,
	startingSpells,
	STARTING_SPELL_PICKS,
	validateStartingSpells,
	knownSpells,
	spellChoicesFor,
	canLearn,
	findSpellIn,
	costsSlot,
	validateCatalogue,
} from "./spellbook.js";

/**
 * @description Builds a caster record carrying only what the spellbook reads.
 * @param {object} [over] - Fields to override.
 * @returns {object} A player record.
 */
function caster(over = {}) {
	return { name: "Elara", class: "Wizard", level: 1, stats: { int: 16 }, ...over };
}

// ── Which stat a caster casts with ───────────────────────────────────────────

test("each casting class uses its own ability, not intelligence", () => {
	// The hardcoded `statKey = "int"` in autoRollIfNeeded made a Cleric roll their
	// worst stat to cast, every time.
	assert.equal(castingAbility("Wizard"), "int");
	assert.equal(castingAbility("Cleric"), "wis");
	assert.equal(castingAbility("Druid"), "wis");
	assert.equal(castingAbility("Sorcerer"), "cha");
	assert.equal(castingAbility("Warlock"), "cha");
	assert.equal(castingAbility("Bard"), "cha");
});

test("a non-casting class has no casting ability", () => {
	for (const className of ["Fighter", "Rogue", "Barbarian", "Monk"]) {
		assert.equal(castingAbility(className), null, `${className} should not cast`);
		assert.equal(isCaster(className), false);
	}
});

test("an unknown or missing class is not a caster rather than a crash", () => {
	// "Adventurer" is the default class and has no progression entry; characterCapability
	// already has to defend against it.
	for (const value of ["Adventurer", "", null, undefined, 42, {}]) {
		assert.equal(castingAbility(value), null);
		assert.equal(isCaster(value), false);
	}
});

test("class matching ignores case and surrounding space", () => {
	assert.equal(castingAbility(" wizard "), "int");
	assert.equal(castingAbility("CLERIC"), "wis");
});

// ── How high a caster reaches ────────────────────────────────────────────────

test("spell level is half character level, rounded up", () => {
	assert.equal(maxSpellLevel(1), 1);
	assert.equal(maxSpellLevel(2), 1);
	assert.equal(maxSpellLevel(3), 2);
	assert.equal(maxSpellLevel(4), 2);
	assert.equal(maxSpellLevel(9), 5);
});

test("spell level never exceeds nine, however high the character", () => {
	assert.equal(maxSpellLevel(17), 9);
	assert.equal(maxSpellLevel(20), 9);
	assert.equal(maxSpellLevel(999), 9);
});

test("a malformed level reaches level 1 rather than nothing", () => {
	// Collapsing to zero would silently leave a caster unable to cast anything.
	for (const level of [null, undefined, "", NaN, 0, -3, {}]) {
		assert.equal(maxSpellLevel(level), 1, `level ${String(level)} did not fall back to 1`);
	}
});

// ── What a class could learn ─────────────────────────────────────────────────

test("a level-1 wizard has spells available", () => {
	// The whole defect in one assertion: this pool was empty, because it did not exist.
	const pool = spellsAvailableTo("Wizard", 1);
	assert.ok(pool.length > 0, "a level-1 wizard should have spells available");
	assert.ok(pool.some((s) => s.name === "Fire Bolt"));
	assert.ok(pool.some((s) => s.name === "Magic Missile"));
});

test("a spell is available only to the classes that may learn it", () => {
	// Several spells sit on more than one class list, so this is membership, not identity.
	const wizard = spellsAvailableTo("Wizard", 1).map((s) => s.name);
	assert.ok(!wizard.includes("Cure Wounds"), "Cure Wounds is not a wizard spell");
	assert.ok(!wizard.includes("Eldritch Blast"), "Eldritch Blast is a warlock spell");

	const cleric = spellsAvailableTo("Cleric", 1).map((s) => s.name);
	assert.ok(cleric.includes("Sacred Flame"));
	assert.ok(cleric.includes("Cure Wounds"));
	assert.ok(!cleric.includes("Fire Bolt"));

	// Shared entries reach every class that lists them.
	for (const className of ["Wizard", "Sorcerer", "Bard", "Druid"]) {
		assert.ok(
			spellsAvailableTo(className, 1).some((s) => s.name === "Thunderwave"),
			`Thunderwave should be available to ${className}`,
		);
	}
});

test("every casting class can reach an offensive spell at level 1", () => {
	// A caster with only utility spells has nothing to do in a fight, which is the
	// state this whole change exists to leave behind.
	for (const className of ["Wizard", "Cleric", "Druid", "Sorcerer", "Warlock", "Bard"]) {
		const offensive = spellsAvailableTo(className, 1)
			.filter((s) => ["attack", "save", "auto"].includes(s.resolution));
		assert.ok(offensive.length > 0, `${className} has no offensive spell at level 1`);
	}
});

test("a non-caster has nothing available", () => {
	assert.deepEqual(spellsAvailableTo("Fighter", 1), []);
	assert.deepEqual(spellsAvailableTo("Rogue", 20), []);
});

test("the pool is capped by the character's spell level", () => {
	assert.ok(spellsAvailableTo("Wizard", 1).every((s) => s.level <= 1));
	assert.ok(spellsAvailableTo("Wizard", 1).some((s) => s.level === 0), "cantrips should be available");
});

test("the returned pool cannot be used to mutate the catalogue", () => {
	// The list reaches the capability model and from there a prompt; a caller that
	// sorts or splices it in place must not change what the next caster may learn.
	const first = spellsAvailableTo("Wizard", 1);
	const originalLength = first.length;
	first.splice(0, first.length);
	assert.equal(spellsAvailableTo("Wizard", 1).length, originalLength);

	const second = spellsAvailableTo("Wizard", 1);
	second[0].name = "Tampered";
	assert.notEqual(spellsAvailableTo("Wizard", 1)[0].name, "Tampered");
});

// ── The starting loadout ─────────────────────────────────────────────────────

test("the fallback loadout is the number of picks the builder offers", () => {
	// This is what a caster gets when nobody picked for them — an import, or a character
	// made before the builder offered the choice.
	assert.equal(startingSpells("Wizard").length, STARTING_SPELL_PICKS);
});

test("the fallback loadout is all cantrips, so the character can always act", () => {
	// At-will. A default that spent the levelled picks would both ration the character's
	// only spells and pre-empt a choice that is the player's to make.
	assert.ok(startingSpells("Wizard").every((s) => s.level === 0));
	assert.ok(startingSpells("Cleric").every((s) => s.level === 0));
});

test("the fallback leaves most of the class list unlearned", () => {
	// The picks at creation and on level-up need something left to offer.
	const started = startingSpells("Wizard").length;
	assert.ok(started < spellsAvailableTo("Wizard", 1).length, "a caster should not start knowing everything");
});

test("a non-caster starts with no spells", () => {
	assert.deepEqual(startingSpells("Fighter"), []);
	assert.deepEqual(startingSpells("Adventurer"), []);
});

// ── What a character knows ───────────────────────────────────────────────────

test("a caster with no stored list falls back to the starting loadout", () => {
	// The 38 casters already in stored lobbies have no `spells` field and must not be
	// left mute by this change landing.
	const known = knownSpells(caster());
	assert.deepEqual(known.map((s) => s.name).sort(), startingSpells("Wizard").map((s) => s.name).sort());
});

test("a stored list is resolved against the catalogue", () => {
	const known = knownSpells(caster({ spells: ["Fire Bolt", "Magic Missile"] }));
	assert.deepEqual(known.map((s) => s.name), ["Fire Bolt", "Magic Missile"]);
	// Resolved, not echoed — the mechanics have to come with it.
	assert.equal(known[0].damage, "1d10");
	assert.equal(known[0].resolution, "attack");
});

test("a stored spell that is not in the catalogue is dropped, not invented", () => {
	// The DM writes to player records, and "never invent a fact" is the rule this
	// module shares with characterCapability.
	const known = knownSpells(caster({ spells: ["Fire Bolt", "Wish", "", null, 42] }));
	assert.deepEqual(known.map((s) => s.name), ["Fire Bolt"]);
});

test("a stored list survives a class that no longer matches the spell", () => {
	// A class change must not leave a wizard casting Cure Wounds.
	const known = knownSpells(caster({ class: "Wizard", spells: ["Fire Bolt", "Cure Wounds"] }));
	assert.deepEqual(known.map((s) => s.name), ["Fire Bolt"]);
});

test("a non-caster knows nothing even with a stored list", () => {
	assert.deepEqual(knownSpells({ class: "Fighter", level: 3, spells: ["Fire Bolt"] }), []);
});

test("knownSpells tolerates junk", () => {
	for (const value of [null, undefined, {}, "Elara", 42]) {
		assert.deepEqual(knownSpells(value), []);
	}
	assert.deepEqual(knownSpells(caster({ spells: "Fire Bolt" })).map((s) => s.name),
		startingSpells("Wizard").map((s) => s.name),
		"a non-array list should fall back rather than half-parse");
});

// ── Picking a spell on level-up ──────────────────────────────────────────────

test("the choices are what is available minus what is known", () => {
	const player = caster({ level: 3, spells: ["Fire Bolt", "Magic Missile"] });
	const choices = spellChoicesFor(player).map((s) => s.name);
	assert.ok(choices.length > 0);
	assert.ok(!choices.includes("Fire Bolt"), "already known");
	assert.ok(!choices.includes("Magic Missile"), "already known");
	assert.ok(choices.includes("Chromatic Orb"));
});

test("the choices include lower-level spells, not only the newest level", () => {
	// The operator's rule: a pick may be "from that level or lower".
	const player = caster({ level: 3, spells: ["Magic Missile"] });
	const levels = new Set(spellChoicesFor(player).map((s) => s.level));
	assert.ok(levels.has(0), "cantrips should remain pickable");
	assert.ok(levels.has(1), "level-1 spells should remain pickable");
});

test("a caster who knows everything available has no choices left", () => {
	const all = spellsAvailableTo("Wizard", 1).map((s) => s.name);
	assert.deepEqual(spellChoicesFor(caster({ level: 1, spells: all })), []);
});

test("a spell on the class list at or below the character's level may be learned", () => {
	const player = caster({ level: 1, spells: ["Fire Bolt"] });
	const verdict = canLearn(player, "Magic Missile");
	assert.equal(verdict.ok, true);
	assert.equal(verdict.spell.name, "Magic Missile");
});

test("a spell name is matched regardless of case and spacing", () => {
	assert.equal(canLearn(caster({ spells: [] }), "  magic   missile ").ok, true);
});

test("a spell already known cannot be learned twice", () => {
	const verdict = canLearn(caster({ spells: ["Fire Bolt"] }), "Fire Bolt");
	assert.equal(verdict.ok, false);
	assert.match(verdict.reason, /already/i);
});

test("a spell from another class's list is refused", () => {
	const verdict = canLearn(caster({ spells: [] }), "Cure Wounds");
	assert.equal(verdict.ok, false);
	assert.match(verdict.reason, /class/i);
});

test("a spell above the character's spell level is refused", () => {
	// There is no level-2 spell in the catalogue yet, so this asserts through the pool:
	// anything not in it is refused for one of the two stated reasons.
	const verdict = canLearn(caster({ level: 1, spells: [] }), "Meteor Swarm");
	assert.equal(verdict.ok, false);
	assert.ok(verdict.reason);
});

test("a non-caster cannot learn a spell", () => {
	const verdict = canLearn({ class: "Fighter", level: 5, spells: [] }, "Fire Bolt");
	assert.equal(verdict.ok, false);
	assert.match(verdict.reason, /cast/i);
});

test("canLearn refuses junk rather than throwing", () => {
	// This is the validation behind a socket event, so the input is untrusted.
	for (const name of [null, undefined, "", 42, {}, "   "]) {
		const verdict = canLearn(caster({ spells: [] }), name);
		assert.equal(verdict.ok, false, `${JSON.stringify(name)} was accepted`);
		assert.ok(verdict.reason);
	}
	for (const player of [null, undefined, "Elara", 42]) {
		assert.equal(canLearn(player, "Fire Bolt").ok, false);
	}
});

// ── Naming a spell in an action ──────────────────────────────────────────────

test("a spell named in the action is found", () => {
	const known = knownSpells(caster({ spells: ["Fire Bolt", "Magic Missile"] }));
	assert.equal(findSpellIn("I cast magic missile at the goblin", known)?.name, "Magic Missile");
	assert.equal(findSpellIn("I cast Fire Bolt at the nearest orc", known)?.name, "Fire Bolt");
});

test("punctuation and hyphens in the typed name do not defeat the match", () => {
	const known = knownSpells(caster({ spells: ["Fire Bolt", "Magic Missile"] }));
	assert.equal(findSpellIn("I cast magic-missile!", known)?.name, "Magic Missile");
	assert.equal(findSpellIn('I shout "FIRE BOLT" and point', known)?.name, "Fire Bolt");
});

test("a spell the character does not know is not found", () => {
	const known = knownSpells(caster({ spells: ["Fire Bolt"] }));
	assert.equal(findSpellIn("I cast cure wounds on the fighter", known), null);
});

test("the longest matching name wins", () => {
	// "Chill Touch" and a bare "Touch" would both match; the specific one is what the
	// player typed. Guards the same class of bug chooseTarget has.
	const known = [
		{ name: "Touch", level: 0, resolution: "utility" },
		{ name: "Chill Touch", level: 0, resolution: "attack" },
	];
	assert.equal(findSpellIn("I cast chill touch at it", known)?.name, "Chill Touch");
});

test("finding a spell tolerates junk input", () => {
	const known = knownSpells(caster());
	for (const text of [null, undefined, "", 42, {}]) {
		assert.equal(findSpellIn(text, known), null);
	}
	for (const spells of [null, undefined, "nope", [null], [{}]]) {
		assert.equal(findSpellIn("I cast fire bolt", spells), null);
	}
});

test("a spell name is not matched inside an unrelated word", () => {
	// "Light" must not fire on "I delight in the chaos" — the same false-positive class
	// the cast-idiom list in actionFeasibility exists to prevent.
	const known = [{ name: "Light", level: 0, resolution: "utility" }];
	assert.equal(findSpellIn("I delight in the chaos", known), null);
	assert.equal(findSpellIn("I cast light on my staff", known)?.name, "Light");
});

// ── What casting costs ───────────────────────────────────────────────────────

test("a cantrip is free and a levelled spell costs a slot", () => {
	// The shared pool is one activation at level 1. Charging a cantrip against it would
	// let a wizard cast Fire Bolt once per long rest, which is not a wizard.
	assert.equal(costsSlot({ name: "Fire Bolt", level: 0 }), false);
	assert.equal(costsSlot({ name: "Magic Missile", level: 1 }), true);
});

test("an unusable spell object does not silently become free", () => {
	// Defaulting to free is the dangerous direction: it would make every malformed
	// entry an at-will spell.
	for (const value of [null, undefined, {}, "Fire Bolt", { name: "X" }, { name: "X", level: "abc" }]) {
		assert.equal(costsSlot(value), true, `${JSON.stringify(value)} should not be free`);
	}
});

// ── Picking at character creation ────────────────────────────────────────────

test("a caster may pick the offered number of spells", () => {
	const v = validateStartingSpells("Wizard", ["Fire Bolt", "Magic Missile", "Shield"]);
	assert.equal(v.ok, true);
	assert.deepEqual(v.spells.map((s) => s.name), ["Fire Bolt", "Magic Missile", "Shield"]);
});

test("picks may mix cantrips and levelled spells freely", () => {
	const v = validateStartingSpells("Cleric", ["Sacred Flame", "Cure Wounds", "Guiding Bolt"]);
	assert.equal(v.ok, true);
	assert.deepEqual(v.spells.map((s) => s.level), [0, 1, 1]);
});

test("picking more than the allowance is refused rather than truncated", () => {
	// Silently keeping the first three would misreport what the player chose.
	const v = validateStartingSpells("Wizard", ["Fire Bolt", "Magic Missile", "Shield", "Sleep"]);
	assert.equal(v.ok, false);
	assert.match(v.reason, new RegExp(String(STARTING_SPELL_PICKS)));
});

test("picking fewer is allowed, so a half-finished sheet still saves", () => {
	assert.equal(validateStartingSpells("Wizard", ["Fire Bolt"]).ok, true);
	assert.equal(validateStartingSpells("Wizard", []).ok, true);
});

test("a spell from another class's list is dropped, not accepted", () => {
	const v = validateStartingSpells("Wizard", ["Fire Bolt", "Cure Wounds"]);
	assert.equal(v.ok, true);
	assert.deepEqual(v.spells.map((s) => s.name), ["Fire Bolt"]);
	assert.deepEqual(v.dropped, ["Cure Wounds"]);
});

test("a spell that does not exist is dropped, not invented", () => {
	const v = validateStartingSpells("Wizard", ["Fire Bolt", "Wish"]);
	assert.deepEqual(v.spells.map((s) => s.name), ["Fire Bolt"]);
	assert.deepEqual(v.dropped, ["Wish"]);
});

test("the same spell picked twice counts once", () => {
	const v = validateStartingSpells("Wizard", ["Fire Bolt", "fire-bolt", "FIRE BOLT"]);
	assert.equal(v.ok, true);
	assert.deepEqual(v.spells.map((s) => s.name), ["Fire Bolt"]);
});

test("a non-caster's picks are discarded without failing the character save", () => {
	// A player who picks spells and then switches to Fighter should lose the spells,
	// not the character.
	const v = validateStartingSpells("Fighter", ["Fire Bolt"]);
	assert.equal(v.ok, true);
	assert.deepEqual(v.spells, []);
});

test("a malformed pick list is refused rather than throwing", () => {
	// This runs on a payload from a browser.
	for (const value of [null, undefined, "Fire Bolt", 42, {}]) {
		const v = validateStartingSpells("Wizard", value);
		assert.equal(v.ok, false, JSON.stringify(value));
		assert.ok(v.reason);
	}
});

test("junk entries inside the pick list are dropped without throwing", () => {
	const v = validateStartingSpells("Wizard", [null, "", 42, {}, "Fire Bolt"]);
	assert.equal(v.ok, true);
	assert.deepEqual(v.spells.map((s) => s.name), ["Fire Bolt"]);
});

test("validated picks are copies that cannot mutate the catalogue", () => {
	const v = validateStartingSpells("Wizard", ["Fire Bolt"]);
	v.spells[0].damage = "99d99";
	assert.notEqual(validateStartingSpells("Wizard", ["Fire Bolt"]).spells[0].damage, "99d99");
});

// ── The catalogue's own shape ────────────────────────────────────────────────

/**
 * @description A minimal sound catalogue, so each case below alters exactly one thing.
 * @param {object[]} spells - Entries to carry.
 * @returns {object} A catalogue document.
 */
function catalogue(spells) {
	return { spells };
}

test("the shipped catalogue is sound", () => {
	// The point of the validator: it runs against the real file at boot.
	const data = JSON.parse(
		readFileSync(new URL("../../client/config/spells.json", import.meta.url), "utf8"),
	);
	assert.equal(validateCatalogue(data), null);
});

test("a catalogue that is not an object is refused", () => {
	for (const value of [null, undefined, [], "spells", 42]) {
		assert.ok(validateCatalogue(value), `${JSON.stringify(value)} should be refused`);
	}
});

test("a missing or empty spells array is refused", () => {
	assert.ok(validateCatalogue({}));
	assert.ok(validateCatalogue({ spells: "Fire Bolt" }));
	assert.ok(validateCatalogue(catalogue([])));
});

test("an entry missing its name, level or classes is refused", () => {
	assert.match(validateCatalogue(catalogue([{ level: 0, classes: ["Wizard"], resolution: "utility" }])), /name/i);
	assert.match(validateCatalogue(catalogue([{ name: "X", classes: ["Wizard"], resolution: "utility" }])), /level/i);
	assert.match(validateCatalogue(catalogue([{ name: "X", level: 0, resolution: "utility" }])), /class/i);
});

test("an unrecognised resolution is refused", () => {
	// A typo here would silently make a spell unresolvable rather than loudly wrong.
	const problem = validateCatalogue(catalogue([
		{ name: "X", level: 0, classes: ["Wizard"], resolution: "atack" },
	]));
	assert.match(problem, /resolution/i);
});

test("a damaging spell whose damage the dice roller cannot read is refused", () => {
	// The invariant the whole design rests on: mechanics are expressions, not English.
	// "8d6 fire" is the class table's style and is exactly what must never appear here.
	for (const damage of ["8d6 fire", "1d8 + WIS force", "lots", ""]) {
		const problem = validateCatalogue(catalogue([
			{ name: "X", level: 1, classes: ["Wizard"], resolution: "attack", damage, damageType: "fire" },
		]));
		assert.ok(problem, `damage ${JSON.stringify(damage)} should be refused`);
		assert.match(problem, /damage/i);
	}
});

test("a readable damage expression is accepted", () => {
	assert.equal(validateCatalogue(catalogue([
		{ name: "X", level: 1, classes: ["Wizard"], resolution: "attack", damage: "3d4+3", damageType: "force" },
	])), null);
});

test("a save spell must name the saving throw", () => {
	const problem = validateCatalogue(catalogue([
		{ name: "X", level: 1, classes: ["Wizard"], resolution: "save", damage: "3d6", damageType: "fire" },
	]));
	assert.match(problem, /save/i);
});

test("a healing spell must carry a readable healing expression", () => {
	assert.ok(validateCatalogue(catalogue([
		{ name: "X", level: 1, classes: ["Cleric"], resolution: "heal", healing: "1d8 plus wisdom" },
	])));
	assert.equal(validateCatalogue(catalogue([
		{ name: "X", level: 1, classes: ["Cleric"], resolution: "heal", healing: "1d8" },
	])), null);
});

test("a utility spell needs no damage at all", () => {
	assert.equal(validateCatalogue(catalogue([
		{ name: "X", level: 0, classes: ["Wizard"], resolution: "utility" },
	])), null);
});

test("the problem names the offending spell, so a boot log is actionable", () => {
	const problem = validateCatalogue(catalogue([
		{ name: "Fire Bolt", level: 0, classes: ["Wizard"], resolution: "utility" },
		{ name: "Broken Spell", level: 1, classes: ["Wizard"], resolution: "attack", damage: "loads" },
	]));
	assert.match(problem, /Broken Spell/);
});
