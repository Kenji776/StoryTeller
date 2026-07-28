import test from "node:test";
import assert from "node:assert/strict";

import { equipSlotFor, NON_EQUIPPABLE_TYPES } from "./itemSlots.js";

/**
 * @description Builds an inventory item in the shape the store holds, so a case can
 *   state only the part it is about.
 * @param {object} over - Fields to override on the default item.
 * @returns {object} An inventory item.
 */
function item(over = {}) {
	return { name: "Rope", count: 1, description: "", attributes: {}, ...over };
}

// ── An explicit type is authoritative ────────────────────────────────────────

test("an explicit equippable type picks its own slot", () => {
	assert.equal(equipSlotFor(item({ name: "Barrow Blade", attributes: { item_type: "weapon" } })), "weapon");
	assert.equal(equipSlotFor(item({ name: "Chain Shirt", attributes: { item_type: "armor" } })), "armor");
	assert.equal(equipSlotFor(item({ name: "Bone Talisman", attributes: { item_type: "trinket" } })), "trinket");
});

test("jewellery types are all trinkets", () => {
	for (const type of ["ring", "amulet", "necklace", "bracelet", "cloak"]) {
		assert.equal(equipSlotFor(item({ attributes: { item_type: type } })), "trinket", `${type} should be a trinket`);
	}
});

// ── The defect this exists for ───────────────────────────────────────────────

test("a quest item is never equippable, whatever it is called", () => {
	// There is one trinket slot. A sealed letter typed as gear competes with the
	// amulet the player actually wants to wear — a live probe produced five such
	// items (letters, keys, maps) in a single session.
	const letter = item({ name: "Crescent-Sealed Letter", attributes: { item_type: "quest" } });
	const charm = item({ name: "Charm of the Fallen Mill", attributes: { item_type: "quest" } });

	assert.equal(equipSlotFor(letter), null);
	assert.equal(equipSlotFor(charm), null);
});

test("an explicit non-equippable type beats a name that looks like gear", () => {
	// "charm" and "orb" are trinket keywords, so a consumable named with one used to
	// be offered as equipment: the keyword pass ran before the consumable check.
	const potion = item({ name: "Charm Philtre", attributes: { item_type: "consumable" } });
	const flask = item({ name: "Orb of Alchemist's Fire", attributes: { item_type: "consumable" } });

	assert.equal(equipSlotFor(potion), null);
	assert.equal(equipSlotFor(flask), null);
});

test("a non-equippable type beats mechanical attributes", () => {
	// A thrown flask carries damage without being a weapon you wield.
	const flask = item({ name: "Alchemist's Fire", attributes: { item_type: "consumable", damage: "1d4", damage_type: "fire" } });

	assert.equal(equipSlotFor(flask), null);
});

test("the non-equippable types are exactly consumable and quest", () => {
	assert.deepEqual([...NON_EQUIPPABLE_TYPES].sort(), ["consumable", "quest"]);
});

// ── Falling back when the model gave no type ─────────────────────────────────

test("mechanical attributes imply a slot when no type is given", () => {
	assert.equal(equipSlotFor(item({ name: "Odd Thing", attributes: { damage: "1d8" } })), "weapon");
	assert.equal(equipSlotFor(item({ name: "Odd Thing", attributes: { damage_type: "slashing" } })), "weapon");
	assert.equal(equipSlotFor(item({ name: "Odd Thing", attributes: { ac: 15 } })), "armor");
	assert.equal(equipSlotFor(item({ name: "Odd Thing", attributes: { armor_type: "medium" } })), "armor");
});

test("a name keyword is the last resort", () => {
	assert.equal(equipSlotFor(item({ name: "Rusty Handaxe" })), "weapon");
	assert.equal(equipSlotFor(item({ name: "Studded Leather" })), "armor");
	assert.equal(equipSlotFor(item({ name: "Garnet Silver Ring" })), "trinket");
});

test("attributes outrank a misleading name", () => {
	// A "Shield Amulet" carrying an AC is armour, not jewellery.
	assert.equal(equipSlotFor(item({ name: "Amulet of the Shield", attributes: { ac: 12 } })), "armor");
});

test("an unrecognised item is not equippable", () => {
	assert.equal(equipSlotFor(item({ name: "Rations" })), null);
	assert.equal(equipSlotFor(item({ name: "Mine Map (crude)" })), null);
});

// ── Boundaries and bad input ─────────────────────────────────────────────────

test("missing and malformed items are not equippable rather than throwing", () => {
	assert.equal(equipSlotFor(null), null);
	assert.equal(equipSlotFor(undefined), null);
	assert.equal(equipSlotFor({}), null);
	assert.equal(equipSlotFor({ name: null, attributes: null }), null);
	assert.equal(equipSlotFor("Sword"), null);
});

test("type matching ignores case and surrounding space", () => {
	assert.equal(equipSlotFor(item({ attributes: { item_type: " WEAPON " } })), "weapon");
	assert.equal(equipSlotFor(item({ name: "Charm Philtre", attributes: { item_type: "Consumable" } })), null);
});

test("an empty name with no attributes is not equippable", () => {
	assert.equal(equipSlotFor(item({ name: "" })), null);
});
