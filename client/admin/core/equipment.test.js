import test from "node:test";
import assert from "node:assert/strict";

import { buildGrantPayload, DEFAULT_DAMAGE, DEFAULT_AC } from "./equipment.js";
import { ITEM_TYPES, DAMAGE_TYPES, WEAPON_RANGES, ARMOR_TYPES } from "./vocab.js";

/** A complete weapon grant. */
const weapon = (over = {}) => ({
	player: "Mira", name: "Flamebrand Longsword", type: "weapon",
	description: "Deals an extra 1d6 fire damage.",
	damage: "2d6", damageType: "fire", range: "melee", ...over,
});

test("a weapon grant carries its mechanics and its description", () => {
	assert.deepEqual(buildGrantPayload(weapon()), {
		player: "Mira",
		item: "Flamebrand Longsword",
		change: 1,
		description: "Deals an extra 1d6 fire damage.",
		attributes: { item_type: "weapon", damage: "2d6", damage_type: "fire", range: "melee" },
	});
});

test("an armour grant carries its class and category", () => {
	const payload = buildGrantPayload({ player: "Bran", name: "Oak Shield", type: "armor", ac: 2, armorType: "shield" });
	assert.deepEqual(payload.attributes, { item_type: "armor", ac: 2, armor_type: "shield" });
});

test("a trinket or consumable carries only its type", () => {
	for (const type of ["trinket", "consumable"]) {
		const payload = buildGrantPayload({ player: "Mira", name: "Odd Coin", type });
		assert.deepEqual(payload.attributes, { item_type: type });
	}
});

test("weapon mechanics are ignored for an item that is not a weapon", () => {
	// Otherwise switching the type after filling the weapon fields grants a trinket
	// that deals damage.
	const payload = buildGrantPayload({ player: "Mira", name: "Odd Coin", type: "trinket", damage: "2d6", ac: 5 });
	assert.deepEqual(payload.attributes, { item_type: "trinket" });
});

test("an unstated description falls back to the item's own name", () => {
	assert.equal(buildGrantPayload({ player: "Mira", name: "Rope", type: "trinket" }).description, "Rope");
	assert.equal(buildGrantPayload({ player: "Mira", name: "Rope", type: "trinket", description: "  " }).description, "Rope");
});

test("names and descriptions are trimmed", () => {
	const payload = buildGrantPayload({ player: "  Mira  ", name: "  Rope  ", type: "trinket", description: "  Sturdy.  " });
	assert.equal(payload.player, "Mira");
	assert.equal(payload.item, "Rope");
	assert.equal(payload.description, "Sturdy.");
});

test("a grant is always for one item", () => {
	assert.equal(buildGrantPayload(weapon()).change, 1);
});

// ── defaults apply only to absence ────────────────────────────────────────────

test("an unstated weapon damage falls back to the default", () => {
	const payload = buildGrantPayload({ player: "Mira", name: "Club", type: "weapon" });
	assert.equal(payload.attributes.damage, DEFAULT_DAMAGE);
	assert.equal(payload.attributes.damage_type, DAMAGE_TYPES[0]);
	assert.equal(payload.attributes.range, WEAPON_RANGES[0]);
});

test("an unstated armour class falls back to the default", () => {
	const payload = buildGrantPayload({ player: "Bran", name: "Jerkin", type: "armor" });
	assert.equal(payload.attributes.ac, DEFAULT_AC);
	assert.equal(payload.attributes.armor_type, ARMOR_TYPES[0]);
});

test("an armour class of zero is kept rather than treated as absent", () => {
	assert.equal(buildGrantPayload({ player: "B", name: "Rags", type: "armor", ac: 0 }).attributes.ac, 0);
	assert.equal(buildGrantPayload({ player: "B", name: "Rags", type: "armor", ac: "0" }).attributes.ac, 0);
});

test("a numeric armour class arrives as a number even when typed as text", () => {
	assert.equal(buildGrantPayload({ player: "B", name: "Mail", type: "armor", ac: "16" }).attributes.ac, 16);
});

// ── refusals ──────────────────────────────────────────────────────────────────

test("a grant with no recipient is refused", () => {
	for (const player of ["", "   ", null, undefined, 7]) {
		assert.throws(() => buildGrantPayload(weapon({ player })), { name: "TypeError", message: /player/i });
	}
});

test("a grant with no item name is refused", () => {
	for (const name of ["", "   ", null, undefined]) {
		assert.throws(() => buildGrantPayload(weapon({ name })), { name: "TypeError", message: /name/i });
	}
});

test("an item type the game does not know is refused", () => {
	assert.throws(() => buildGrantPayload(weapon({ type: "artifact" })), { name: "TypeError", message: /type/i });
	assert.throws(() => buildGrantPayload(weapon({ type: "" })), { name: "TypeError", message: /type/i });
	assert.throws(() => buildGrantPayload(weapon({ type: undefined })), { name: "TypeError", message: /type/i });
});

test("a malformed damage expression is refused rather than quietly becoming a d6", () => {
	// The old panel substituted the default for anything it could not parse, so a
	// typo produced a weapon that worked but not as written.
	for (const damage of ["two d six", "d6", "2d", "2x6", "-1d6"]) {
		assert.throws(() => buildGrantPayload(weapon({ damage })), { name: "RangeError", message: /damage/i },
			`"${damage}" should be refused`);
	}
});

test("damage expressions the game can actually roll are accepted", () => {
	for (const damage of ["1d6", "2d10", "1d8+2", "3d4-1", "1d8 + 2", "2D6"]) {
		assert.doesNotThrow(() => buildGrantPayload(weapon({ damage })), `"${damage}" should be accepted`);
	}
});

test("a damage type or range outside the vocabulary is refused", () => {
	assert.throws(() => buildGrantPayload(weapon({ damageType: "psychic" })), { name: "RangeError", message: /damage type/i });
	assert.throws(() => buildGrantPayload(weapon({ range: "orbital" })), { name: "RangeError", message: /range/i });
});

test("a nonsensical armour class is refused", () => {
	for (const ac of ["heavy", -1, 1.5, NaN]) {
		assert.throws(() => buildGrantPayload({ player: "B", name: "Mail", type: "armor", ac }),
			{ name: "RangeError", message: /armou?r class/i }, `${ac} should be refused`);
	}
});

test("an armour type outside the vocabulary is refused", () => {
	assert.throws(() => buildGrantPayload({ player: "B", name: "Mail", type: "armor", armorType: "plate" }),
		{ name: "RangeError", message: /armou?r type/i });
});

test("buildGrantPayload refuses being called with nothing", () => {
	assert.throws(() => buildGrantPayload(), { name: "TypeError" });
	assert.throws(() => buildGrantPayload({}), { name: "TypeError" });
});

test("every item type in the vocabulary can actually be granted", () => {
	for (const { id } of ITEM_TYPES) {
		assert.doesNotThrow(() => buildGrantPayload({ player: "Mira", name: "Thing", type: id }), `${id} should grant`);
	}
});
