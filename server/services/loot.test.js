/**
 * Tests for the loot engine.
 *
 * @description The engine exists because the narrator is not a random number
 *   generator. Asked to decide loot, it said yes every time: a probe of six
 *   loot-seeking turns paid out six times, and still paid out on two of three
 *   *failed* rolls. "You find nothing" was not a reachable state, and nothing it
 *   handed over had a mechanical effect.
 *
 *   These tests pin the two properties that follow from that: rewards are
 *   sometimes absent, and when present they are mechanically real.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { rollLoot, RARITIES, LOOT_SOURCES } from "./loot.js";
import tables from "../config/loot-tables.json" with { type: "json" };

/**
 * A seeded linear congruential generator.
 *
 * @description Statistical claims — "a trash mob rarely drops" — need many trials,
 *   and many trials need a random source that is the same on every machine and in
 *   every run order (`TDD-8`). Numerical Recipes' constants.
 * @param {number} [seed=1] - The seed.
 * @returns {Function} An rng returning floats in [0, 1).
 */
function seeded(seed = 1) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/**
 * @description Runs many rolls and reports what came out, for statistical claims.
 * @param {object} opts - Options passed through to `rollLoot`, minus the rng.
 * @param {number} [trials=2000] - How many rolls.
 * @param {number} [seed=1] - The seed.
 * @returns {{dropRate: number, goldRate: number, results: object[]}} The summary.
 */
function sample(opts, trials = 2000, seed = 1) {
	const rng = seeded(seed);
	const results = [];
	for (let i = 0; i < trials; i++) results.push(rollLoot({ ...opts, rng }));

	return {
		dropRate: results.filter((r) => r.items.length > 0).length / trials,
		goldRate: results.filter((r) => r.gold > 0).length / trials,
		results,
	};
}

const allItems = (results) => results.flatMap((r) => r.items);

// ── Nothing is a normal result ───────────────────────────────────────────────

test("finding nothing at all is a reachable, ordinary outcome", () => {
	// The defect this engine exists to fix. If this ever fails, we are back to a
	// slot machine that always pays.
	const { results } = sample({ source: "trash", partyLevel: 3 });
	const empty = results.filter((r) => r.items.length === 0 && r.gold === 0);

	assert.ok(empty.length > 0, "a search must sometimes turn up nothing whatsoever");
});

test("a common enemy rarely yields an item; a boss usually does", () => {
	const trash = sample({ source: "trash", partyLevel: 3 }).dropRate;
	const boss = sample({ source: "boss", partyLevel: 3 }).dropRate;

	assert.ok(trash < 0.2, `trash mobs dropped ${(trash * 100).toFixed(1)}% of the time — that is Diablo`);
	assert.ok(boss > 0.6, `bosses dropped only ${(boss * 100).toFixed(1)}% of the time`);
});

test("every source drops less often than a deliberate quest reward", () => {
	const quest = sample({ source: "quest", partyLevel: 3 }).dropRate;
	assert.equal(quest, 1, "a promised reward must always pay");

	for (const source of LOOT_SOURCES.filter((s) => s !== "quest")) {
		assert.ok(sample({ source, partyLevel: 3 }).dropRate < 1, `${source} always dropped`);
	}
});

// ── Generosity is a dial, not a vibe ─────────────────────────────────────────

test("generosity orders the drop rate, sparse through generous", () => {
	const rate = (generosity) => sample({ source: "cache", partyLevel: 3, generosity }).dropRate;

	const sparse = rate("sparse");
	const fair = rate("fair");
	const generous = rate("generous");

	assert.ok(sparse < fair, `sparse ${sparse} was not below fair ${fair}`);
	assert.ok(fair < generous, `fair ${fair} was not below generous ${generous}`);
});

test("even at its most generous, an ordinary corpse is not guaranteed", () => {
	assert.ok(sample({ source: "trash", partyLevel: 10, generosity: "generous" }).dropRate < 1);
});

// ── Rarity ───────────────────────────────────────────────────────────────────

test("a low-level party cannot find a legendary", () => {
	const rarities = new Set(allItems(sample({ source: "boss", partyLevel: 1 }).results).map((i) => i.rarity));

	assert.ok(!rarities.has("legendary"), "a level 1 party found a legendary");
	assert.ok(!rarities.has("very-rare"), "a level 1 party found a very rare item");
});

test("high-level play reaches the top tiers", () => {
	const rarities = new Set(allItems(sample({ source: "boss", partyLevel: 17 }).results).map((i) => i.rarity));

	assert.ok(rarities.has("very-rare") || rarities.has("legendary"), `only saw ${[...rarities].join(", ")}`);
});

test("the rare tiers stay rare even where they are reachable", () => {
	const items = allItems(sample({ source: "cache", partyLevel: 12 }).results);
	const top = items.filter((i) => i.rarity === "legendary").length;

	assert.ok(top / items.length < 0.1, `legendaries were ${((top / items.length) * 100).toFixed(1)}% of drops`);
});

test("every item carries a rarity the game knows", () => {
	for (const item of allItems(sample({ source: "boss", partyLevel: 8 }).results)) {
		assert.ok(RARITIES.includes(item.rarity), `unknown rarity "${item.rarity}"`);
	}
});

// ── What comes out must be usable ────────────────────────────────────────────

test("every item is mechanically valid for the slot it claims", () => {
	const items = allItems(sample({ source: "boss", partyLevel: 10 }, 800).results);
	assert.ok(items.length > 50, "not enough items to judge");

	for (const item of items) {
		const a = item.attributes;
		assert.ok(item.name, "an item arrived with no name");
		assert.ok(["weapon", "armor", "trinket"].includes(a.item_type), `bad item_type "${a.item_type}"`);

		if (a.item_type === "weapon") {
			assert.match(a.damage, /^\d+d\d+$/, `weapon damage "${a.damage}" is not a dice expression`);
			assert.ok(a.damage_type, "weapon has no damage type");
		}
		if (a.item_type === "armor") {
			assert.ok(Number.isInteger(a.ac) && a.ac >= 10, `armor AC ${a.ac} is not usable`);
			assert.ok(a.armor_type, "armor has no armor type");
		}
	}
});

test("an enchantment bonus is separate from the base damage, never spliced into it", () => {
	// A live DM invented "damage": "1d6+1", which is not a dice expression any
	// roller here accepts and is not what the equip path stores.
	for (const item of allItems(sample({ source: "boss", partyLevel: 12 }, 800).results)) {
		if (item.attributes.damage) assert.doesNotMatch(item.attributes.damage, /[+-]/, `damage "${item.attributes.damage}" has a bonus spliced in`);
		if (item.attributes.bonus !== undefined) assert.ok(Number.isInteger(item.attributes.bonus));
	}
});

test("a common item is plain, and everything above it is not", () => {
	const items = allItems(sample({ source: "cache", partyLevel: 10 }, 1500).results);

	for (const item of items) {
		const enchanted = Boolean(item.attributes.bonus) || Boolean(item.effect);
		if (item.rarity === "common") assert.ok(!enchanted, `a common "${item.name}" carried an enchantment`);
		else assert.ok(enchanted, `a ${item.rarity} "${item.name}" carried nothing at all`);
	}
});

test("an armour bonus is added into the AC the server actually reads", () => {
	// enemyTurns.js rolls against player.armor.ac and nothing else, so a bonus kept
	// only in prose would change nothing.
	const armours = allItems(sample({ source: "boss", partyLevel: 14 }, 1500).results)
		.filter((i) => i.attributes.item_type === "armor" && i.attributes.bonus > 0);

	assert.ok(armours.length > 0, "no enchanted armour to check");
	for (const armour of armours) assert.ok(armour.attributes.ac > 10, `AC ${armour.attributes.ac} did not include the bonus`);
});

test("a rare find does not carry a trivial power", () => {
	// Caught by reading real output, not by a test: the engine cheerfully produced a
	// *very-rare* "Pendant of the Wayfinder" whose entire power was knowing which way
	// north is. If a legendary can carry an uncommon's effect, rarity means nothing.
	const minRarityOf = (effect) => tables.affixes.find((a) => a.effect === effect)?.minRarity;

	for (const item of allItems(sample({ source: "boss", partyLevel: 18 }, 1200).results)) {
		if (!item.effect) continue;

		const tier = RARITIES.indexOf(item.rarity);
		const affixTier = RARITIES.indexOf(minRarityOf(item.effect));
		assert.ok(affixTier >= 0, `effect on "${item.name}" matches no affix in the table`);
		assert.ok(
			affixTier >= tier - 1,
			`a ${item.rarity} "${item.name}" carried a ${RARITIES[affixTier]}-tier power`
		);
	}
});

test("a proper-named item is called by its name, not tacked onto its base", () => {
	// "Javelin the Sunderer" and "Dagger Whisperfang" both came out of a real roll.
	// An affix that is a proper noun replaces the base name; the base survives as
	// `baseName` so the UI and the DM still know what kind of thing it is.
	const proper = new Set(tables.affixes.filter((a) => a.naming === "proper").map((a) => a.label));
	assert.ok(proper.size > 0, "no proper-named affixes in the table to check");

	const items = allItems(sample({ source: "boss", partyLevel: 18 }, 1500).results);
	const named = items.filter((i) => proper.has(i.name.replace(/^\+\d+\s*/, "")));
	assert.ok(named.length > 0, "no proper-named items were generated");

	for (const item of named) {
		assert.ok(item.baseName, `"${item.name}" lost track of what it is`);
		assert.ok(!item.name.includes(item.baseName), `"${item.name}" still carries its base name`);
	}
});

test("an armour bonus is not also left lying about as a field to add again", () => {
	// `ac_bonus` is how the table computes; folding it into `ac` and *also* emitting
	// it invites the DM to count it twice.
	for (const item of allItems(sample({ source: "boss", partyLevel: 16 }, 1200).results)) {
		assert.equal(item.attributes.ac_bonus, undefined, `"${item.name}" exposed ac_bonus`);
	}
});

test("no effect text restates a bonus that is already in the numbers", () => {
	for (const item of allItems(sample({ source: "cache", partyLevel: 16 }, 1200).results)) {
		if (item.attributes.item_type !== "armor" || !item.effect) continue;
		assert.doesNotMatch(item.effect, /\+\d+\s*AC/i, `"${item.name}" restates an AC bonus already applied`);
	}
});

test("an item's effect is stated in words the DM can act on", () => {
	for (const item of allItems(sample({ source: "boss", partyLevel: 15 }, 600).results)) {
		if (!item.effect) continue;
		assert.ok(item.effect.length > 20, `effect "${item.effect}" is too thin to adjudicate`);
		assert.match(item.effect, /\.$/, `effect "${item.effect}" is not a sentence`);
	}
});

// ── Gold ─────────────────────────────────────────────────────────────────────

test("gold is more common than items but not guaranteed", () => {
	const { dropRate, goldRate } = sample({ source: "elite", partyLevel: 5 });

	assert.ok(goldRate > dropRate, `gold ${goldRate} was not more common than items ${dropRate}`);
	assert.ok(goldRate < 1, "gold was certain");
});

test("gold scales with party level", () => {
	const mean = (level) => {
		const { results } = sample({ source: "boss", partyLevel: level });
		return results.reduce((sum, r) => sum + r.gold, 0) / results.length;
	};

	assert.ok(mean(10) > mean(1) * 2, "a level 10 boss was not worth appreciably more than a level 1 one");
});

test("gold is always a whole, non-negative number", () => {
	for (const source of LOOT_SOURCES) {
		for (const result of sample({ source, partyLevel: 6 }, 300).results) {
			assert.ok(Number.isInteger(result.gold) && result.gold >= 0, `gold ${result.gold} from ${source}`);
		}
	}
});

// ── Pacing ───────────────────────────────────────────────────────────────────

test("a long drought raises the chance of a drop", () => {
	const dry = sample({ source: "trash", partyLevel: 3, turnsSinceLastItem: 40 }).dropRate;
	const fresh = sample({ source: "trash", partyLevel: 3, turnsSinceLastItem: 0 }).dropRate;

	assert.ok(dry > fresh, `a 40-turn drought (${dry}) was no better than a fresh kill (${fresh})`);
});

test("no drought, however long, makes a drop certain", () => {
	assert.ok(sample({ source: "trash", partyLevel: 3, turnsSinceLastItem: 100000 }).dropRate < 1);
});

test("searching the same scene again and again pays less each time", () => {
	// Without this, "I search the bodies" typed twenty times is a gold faucet: the
	// drop chance is low but the purse rolls every single attempt.
	const rate = (attemptsThisScene) => sample({ source: "search", partyLevel: 5, attemptsThisScene });

	const first = rate(0);
	const fourth = rate(3);

	assert.ok(fourth.dropRate < first.dropRate / 2, `attempt 4 (${fourth.dropRate}) was not appreciably worse than the first (${first.dropRate})`);
	assert.ok(fourth.goldRate < first.goldRate / 2, `gold on attempt 4 (${fourth.goldRate}) was not appreciably worse than the first (${first.goldRate})`);
});

test("a quest reward is not diminished by how much the party searched", () => {
	assert.equal(sample({ source: "quest", partyLevel: 5, attemptsThisScene: 9 }).dropRate, 1);
});

// ── Determinism and bad input ────────────────────────────────────────────────

test("the same seed produces the same loot", () => {
	const once = rollLoot({ source: "boss", partyLevel: 9, rng: seeded(7) });
	const twice = rollLoot({ source: "boss", partyLevel: 9, rng: seeded(7) });

	assert.deepEqual(once, twice);
});

test("an unknown source is treated as an ordinary search rather than throwing", () => {
	const result = rollLoot({ source: "bepis", partyLevel: 3, rng: seeded(3) });

	assert.equal(result.source, "search");
});

test("missing and malformed input resolves to something usable", () => {
	for (const opts of [{}, { source: null }, { partyLevel: -5 }, { partyLevel: "eight" }, { generosity: "lavish" }, { turnsSinceLastItem: -3 }]) {
		const result = rollLoot({ ...opts, rng: seeded(11) });

		assert.ok(Array.isArray(result.items), `items was not an array for ${JSON.stringify(opts)}`);
		assert.ok(Number.isInteger(result.gold) && result.gold >= 0, `gold was ${result.gold} for ${JSON.stringify(opts)}`);
	}
});

test("a random source that breaks its contract still yields a usable drop", () => {
	// rng() is specified to return [0, 1). One that returns exactly 1 walks off the
	// end of every weighted pick; the engine must land somewhere real rather than
	// hand back an undefined rarity.
	let alternating = 0;
	const rngs = [
		() => 1,
		() => 0.9999999999999999,
		// Mixed, so a call that decides *whether* something happens can still pass
		// while a later weighted pick receives the out-of-range value.
		() => (alternating++ % 2 ? 1 : 0),
	];

	for (const badRng of rngs) {
		const result = rollLoot({ source: "quest", partyLevel: 10, rng: badRng });

		assert.ok(Number.isInteger(result.gold) && result.gold >= 0);
		for (const item of result.items) {
			assert.ok(RARITIES.includes(item.rarity), `unusable rarity "${item.rarity}"`);
			assert.ok(item.name, "an item arrived with no name");
		}
	}
});

test("a level beyond the table is clamped rather than paying nothing", () => {
	// The same forgiveness ADR 0008 gives an invented "CR 40".
	const result = sample({ source: "boss", partyLevel: 99 }, 200);

	assert.ok(result.dropRate > 0.6, "a level 99 party got nothing");
});

test("an item never arrives with a duplicate of itself in the same drop", () => {
	for (const result of sample({ source: "boss", partyLevel: 12 }, 500).results) {
		const names = result.items.map((i) => i.name);
		assert.equal(new Set(names).size, names.length, `duplicate item in one drop: ${names.join(", ")}`);
	}
});
