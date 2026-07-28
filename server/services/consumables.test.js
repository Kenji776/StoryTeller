import test from "node:test";
import assert from "node:assert/strict";

import { resolveConsumable } from "./consumables.js";

/** An rng that always rolls the maximum face, so effects are pinned. */
const maxRoll = () => 0.999999;

/**
 * @description Builds an inventory item, so a case states only what it is about.
 * @param {object} over - Fields to override.
 * @returns {object} An inventory item.
 */
function item(over = {}) {
	return { name: "Healing Potion", count: 1, description: "", attributes: { item_type: "consumable" }, ...over };
}

// ── Healing ──────────────────────────────────────────────────────────────────

test("a healing potion restores its rolled amount", () => {
	const effect = resolveConsumable(item({ attributes: { item_type: "consumable", healing: "2d4+2" } }), { rng: maxRoll });

	assert.equal(effect.hp, 10);
	assert.match(effect.summary, /Healing Potion/);
	assert.match(effect.summary, /10/);
});

test("a healing amount is read from the description when there is no attribute", () => {
	// "Restores 2d4 + 2 hit points when consumed." is what the builder writes.
	const effect = resolveConsumable(
		item({ description: "Restores 2d4 + 2 hit points when consumed." }),
		{ rng: maxRoll }
	);

	assert.equal(effect.hp, 10);
});

test("a flat healing value needs no dice", () => {
	assert.equal(resolveConsumable(item({ attributes: { item_type: "consumable", healing: "5" } }), { rng: maxRoll }).hp, 5);
});

test("an unreadable healing expression heals nothing rather than NaN", () => {
	const effect = resolveConsumable(item({ attributes: { item_type: "consumable", healing: "some" } }), { rng: maxRoll });

	assert.equal(effect.hp, 0);
});

// ── Conditions ───────────────────────────────────────────────────────────────

test("an antidote clears the condition it names", () => {
	const effect = resolveConsumable(
		item({ name: "Antitoxin", attributes: { item_type: "consumable", cures: "poisoned" } }),
		{ rng: maxRoll }
	);

	assert.deepEqual(effect.conditions.remove, ["poisoned"]);
	assert.deepEqual(effect.conditions.add, []);
});

test("cures are normalised to the canonical lowercase names and a list", () => {
	const effect = resolveConsumable(
		item({ attributes: { item_type: "consumable", cures: ["Poisoned", " BLINDED "] } }),
		{ rng: maxRoll }
	);

	assert.deepEqual(effect.conditions.remove, ["poisoned", "blinded"]);
});

test("a condition the game does not know is discarded, not applied", () => {
	// The DM invents condition names. Applying "woozy" would put a permanent
	// unremovable tag on the character sheet.
	const effect = resolveConsumable(
		item({ attributes: { item_type: "consumable", cures: ["woozy", "poisoned"] } }),
		{ rng: maxRoll }
	);

	assert.deepEqual(effect.conditions.remove, ["poisoned"]);
});

test("only conditions the character actually has are reported as cleared", () => {
	// A live probe drank an antitoxin while perfectly healthy and was told "clearing
	// poisoned". Removing a condition nobody has is harmless; claiming to have done
	// it is not.
	const antitoxin = item({ name: "Antitoxin", attributes: { item_type: "consumable", cures: "poisoned" } });

	const healthy = resolveConsumable(antitoxin, { rng: maxRoll, conditions: [] });
	assert.deepEqual(healthy.conditions.remove, []);
	assert.doesNotMatch(healthy.summary, /clearing/);

	const poisoned = resolveConsumable(antitoxin, { rng: maxRoll, conditions: ["poisoned"] });
	assert.deepEqual(poisoned.conditions.remove, ["poisoned"]);
	assert.match(poisoned.summary, /clearing poisoned/);
});

test("a character's conditions are matched regardless of case", () => {
	const effect = resolveConsumable(
		item({ attributes: { item_type: "consumable", cures: "poisoned" } }),
		{ rng: maxRoll, conditions: [" POISONED "] }
	);

	assert.deepEqual(effect.conditions.remove, ["poisoned"]);
});

test("with no condition list given, every cure the item names is attempted", () => {
	// Callers that do not know the character's state must not silently lose the cure.
	const effect = resolveConsumable(
		item({ attributes: { item_type: "consumable", cures: ["poisoned", "blinded"] } }),
		{ rng: maxRoll }
	);

	assert.deepEqual(effect.conditions.remove, ["poisoned", "blinded"]);
});

test("an item may both heal and cure", () => {
	const effect = resolveConsumable(
		item({ name: "Elixir of Vigour", attributes: { item_type: "consumable", healing: "1d4", cures: "exhausted" } }),
		{ rng: maxRoll }
	);

	assert.equal(effect.hp, 4);
	assert.deepEqual(effect.conditions.remove, ["exhausted"]);
});

// ── Items with no mechanical effect ──────────────────────────────────────────

test("a consumable with no readable effect is still consumed and says so", () => {
	// The DM hands out "Vial of Dark Liquid — contents unknown". Drinking it must
	// spend the item; whether anything happens is the DM's to narrate.
	const effect = resolveConsumable(item({ name: "Vial of Dark Liquid", attributes: { item_type: "consumable" } }), { rng: maxRoll });

	assert.equal(effect.hp, 0);
	assert.deepEqual(effect.conditions, { add: [], remove: [] });
	assert.match(effect.summary, /Vial of Dark Liquid/);
});

test("an item that is not consumable resolves to null", () => {
	assert.equal(resolveConsumable(item({ name: "Barrow Blade", attributes: { item_type: "weapon" } }), { rng: maxRoll }), null);
	assert.equal(resolveConsumable(null, { rng: maxRoll }), null);
});

// ── Determinism ──────────────────────────────────────────────────────────────

test("the same item and the same rng resolve identically", () => {
	const potion = item({ attributes: { item_type: "consumable", healing: "3d6" } });
	const rngOf = () => {
		let i = 0;
		const values = [0.1, 0.5, 0.9];
		return () => values[i++ % values.length];
	};

	assert.deepEqual(resolveConsumable(potion, { rng: rngOf() }), resolveConsumable(potion, { rng: rngOf() }));
});
