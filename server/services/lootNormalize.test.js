import test from "node:test";
import assert from "node:assert/strict";

import { reconcileCurrency } from "./lootNormalize.js";

/**
 * @description Builds an inventory entry in the shape the DM emits, so a case can
 *   state only the part it is about.
 * @param {object} over - Fields to override on the default entry.
 * @returns {object} An `updates.inventory` entry.
 */
function item(over = {}) {
	return { player: "Sylvie Ashwren", item: "Rope", change: 1, description: "", attributes: {}, ...over };
}

// ── The defect this exists for ───────────────────────────────────────────────

test("coins paid through both channels are banked once and leave no item behind", () => {
	// Verbatim from the live probe: the DM granted the pouch as an item and its
	// contents as gold, so the player banked 6 and kept a junk entry forever.
	const { inventory, gold } = reconcileCurrency(
		[item({ item: "Gold Pieces (Goblin Pouch)", change: 6, description: "A small pouch of coins looted from the goblin.", attributes: { item_type: "consumable" } })],
		[{ player: "Sylvie Ashwren", delta: 6 }]
	);

	assert.deepEqual(inventory, []);
	assert.deepEqual(gold, [{ player: "Sylvie Ashwren", delta: 6 }]);
});

test("a container is currency when its description says it holds coins", () => {
	const { inventory, gold } = reconcileCurrency(
		[item({ player: "Brannor Ironfoot", item: "Burial Coffer", description: "A small iron coffer containing old coins." })],
		[{ player: "Brannor Ironfoot", delta: 22 }]
	);

	assert.deepEqual(inventory, []);
	assert.equal(gold.length, 1);
});

// ── Converting when the DM forgot the gold channel ───────────────────────────

test("a counted coin stack with no gold update becomes gold", () => {
	const { inventory, gold } = reconcileCurrency(
		[item({ item: "Gold Pieces", change: 6 })],
		[]
	);

	assert.deepEqual(inventory, []);
	assert.deepEqual(gold, [{ player: "Sylvie Ashwren", delta: 6, reason: "Gold Pieces" }]);
});

test("a stated amount beats the stack count", () => {
	const { gold } = reconcileCurrency(
		[item({ item: "Coin Purse", change: 1, description: "A purse holding 40 gold pieces." })],
		[]
	);

	assert.deepEqual(gold, [{ player: "Sylvie Ashwren", delta: 40, reason: "Coin Purse" }]);
});

test("two coin entries for one player convert once and are not double-counted", () => {
	const { gold } = reconcileCurrency(
		[
			item({ item: "Gold Pieces", change: 10 }),
			item({ item: "Silver Pieces", change: 8 }),
		],
		[]
	);

	assert.equal(gold.reduce((sum, g) => sum + g.delta, 0), 10);
});

// ── Refusing to guess ────────────────────────────────────────────────────────

test("an unquantifiable coin container is left alone rather than deleted", () => {
	// Dropping this would silently destroy treasure the DM meant to grant, and
	// minting a number for it would invent treasure it did not.
	const entry = item({ item: "Coin Purse", change: 1, description: "A small purse of coins." });
	const { inventory, gold } = reconcileCurrency([entry], []);

	assert.deepEqual(inventory, [entry]);
	assert.deepEqual(gold, []);
});

// ── What must never be mistaken for money ────────────────────────────────────

test("gear is never currency however it is named", () => {
	const shield = item({ item: "Coin-Studded Shield", description: "Old coins hammered into the boss.", attributes: { item_type: "armor", ac: 2 } });
	const amulet = item({ item: "Golden Amulet", description: "Heavy, warm to the touch." });
	const sword = item({ item: "Silver Sword", change: 1, attributes: { item_type: "weapon", damage: "1d8" } });

	const { inventory, gold } = reconcileCurrency([shield, amulet, sword], [{ player: "Sylvie Ashwren", delta: 5 }]);

	assert.deepEqual(inventory, [shield, amulet, sword]);
	assert.equal(gold.length, 1);
});

test("a pouch that holds something other than coins is not money", () => {
	const herbs = item({ item: "Leather Pouch", description: "Full of dried herbs and a bone needle." });
	const { inventory } = reconcileCurrency([herbs], [{ player: "Sylvie Ashwren", delta: 5 }]);

	assert.deepEqual(inventory, [herbs]);
});

test("an item being removed is not treated as a coin grant", () => {
	const spent = item({ item: "Gold Pieces", change: -5 });
	const { inventory, gold } = reconcileCurrency([spent], []);

	assert.deepEqual(inventory, [spent]);
	assert.deepEqual(gold, []);
});

// ── Boundaries and bad input ─────────────────────────────────────────────────

test("absent channels reconcile to empty arrays", () => {
	assert.deepEqual(reconcileCurrency(undefined, undefined), { inventory: [], gold: [] });
	assert.deepEqual(reconcileCurrency(null, null), { inventory: [], gold: [] });
	assert.deepEqual(reconcileCurrency("nonsense", 7), { inventory: [], gold: [] });
});

test("null entries in either channel pass through for the broadcaster to reject", () => {
	// The DM has emitted a bare null inside an updates array before now. Reconciling
	// must not be the thing that throws — the broadcasters already drop unusable
	// entries one by one, and they report the drop.
	const { inventory, gold } = reconcileCurrency([null, item({ item: "Rope" })], [null]);

	assert.deepEqual(inventory, [null, item({ item: "Rope" })]);
	assert.deepEqual(gold, [null]);
});

test("a zero-delta gold entry does not count as payment", () => {
	// The broadcaster ignores a zero delta, so treating it as paid would drop the
	// item and lose the coins entirely.
	const { inventory, gold } = reconcileCurrency(
		[item({ item: "Coin Purse", change: 1, description: "A purse holding 12 gold pieces." })],
		[{ player: "Sylvie Ashwren", delta: 0 }]
	);

	assert.deepEqual(inventory, []);
	assert.equal(gold.find((g) => g.delta === 12)?.delta, 12);
});

test("player names match regardless of case and surrounding space", () => {
	const { inventory } = reconcileCurrency(
		[item({ player: " sylvie ashwren ", item: "Gold Pieces", change: 6 })],
		[{ player: "Sylvie Ashwren", delta: 6 }]
	);

	assert.deepEqual(inventory, []);
});

test("an entry carrying no attributes at all is still classified", () => {
	const { inventory, gold } = reconcileCurrency([{ player: "Sylvie Ashwren", item: "Gold Pieces", change: 6 }], []);

	assert.deepEqual(inventory, []);
	assert.deepEqual(gold, [{ player: "Sylvie Ashwren", delta: 6, reason: "Gold Pieces" }]);
});

test("a damage type or an armor type alone marks an entry as gear", () => {
	const thrown = item({ item: "Silver Coins of Warding", attributes: { damage_type: "radiant" } });
	const scales = item({ item: "Coin-Scale Mail", description: "Coins sewn as scales.", attributes: { armor_type: "medium" } });

	const { inventory } = reconcileCurrency([thrown, scales], [{ player: "Sylvie Ashwren", delta: 5 }]);

	assert.deepEqual(inventory, [thrown, scales]);
});

test("a gold entry with no player name does not mark anyone as paid", () => {
	const { inventory, gold } = reconcileCurrency(
		[item({ item: "Gold Pieces", change: 6 })],
		[{ delta: 10 }]
	);

	assert.deepEqual(inventory, []);
	assert.equal(gold.find((g) => g.reason === "Gold Pieces")?.delta, 6);
});

test("a stated zero falls through to the stack count rather than minting nothing", () => {
	const { gold } = reconcileCurrency([item({ item: "Gold Pieces", change: 4, description: "0 coins remained in the purse." })], []);

	assert.deepEqual(gold, [{ player: "Sylvie Ashwren", delta: 4, reason: "Gold Pieces" }]);
});

test("an entry with no item name is not currency", () => {
	const nameless = { player: "Sylvie Ashwren", change: 3 };
	const { inventory, gold } = reconcileCurrency([nameless], []);

	assert.deepEqual(inventory, [nameless]);
	assert.deepEqual(gold, []);
});

test("non-currency entries pass through untouched and in order", () => {
	const rope = item({ item: "Rope" });
	const map = item({ item: "Mine Map", description: "An X marks a deeper chamber." });
	const { inventory } = reconcileCurrency([rope, map], []);

	assert.deepEqual(inventory, [rope, map]);
});
