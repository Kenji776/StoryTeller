/**
 * The loot engine — what the party finds, and how often they find nothing.
 *
 * @description The narrator decided loot until now, and it is not a random number
 *   generator. A probe of six loot-seeking turns paid out six times; two of three
 *   *failed* rolls still paid out. The roll gated access to a container and never the
 *   reward inside it, so "you find nothing" was unreachable. What it did hand over
 *   had no mechanical effect: seventeen items, no armour, and weapons that were 1d6
 *   sidegrades of what the party already carried.
 *
 *   This is the same argument [ADR 0008](../../docs/decisions/0008-xp-for-kills-is-awarded-by-the-server.md)
 *   made for XP, with the sign flipped — XP never came, loot always came. Both are
 *   bookkeeping asked of something mid-prose.
 *
 *   Pure, and its randomness is a parameter, so a drop is reproducible from a seed.
 */

import weaponCatalogue from "../../client/config/weapons.json" with { type: "json" };
import armourCatalogue from "../../client/config/armor.json" with { type: "json" };
import tables from "../config/loot-tables.json" with { type: "json" };

/** Rarity tiers, ascending. Index into this is the tier number used throughout. */
export const RARITIES = Object.freeze(["common", "uncommon", "rare", "very-rare", "legendary"]);

/** Where a drop came from. Anything else is treated as an ordinary `search`. */
export const LOOT_SOURCES = Object.freeze(["trash", "elite", "boss", "cache", "search", "quest"]);

/**
 * Per-source odds and generosity.
 *
 * `item` and `gold` are the base probabilities of each; `goldDice` is how many d6
 * the purse is worth before level scaling; `shift` biases the rarity table up or
 * down. A trash mob is deliberately near-barren — the point of the whole exercise is
 * that most corpses have nothing worth taking.
 */
const SOURCE_PROFILE = Object.freeze({
	trash: { item: 0.07, gold: 0.35, goldDice: 2, shift: -1 },
	search: { item: 0.18, gold: 0.30, goldDice: 3, shift: -1 },
	elite: { item: 0.33, gold: 0.60, goldDice: 6, shift: 0 },
	cache: { item: 0.60, gold: 0.75, goldDice: 10, shift: 1 },
	boss: { item: 0.80, gold: 0.85, goldDice: 14, shift: 1 },
	quest: { item: 1.00, gold: 0.90, goldDice: 10, shift: 1 },
});

const GENEROSITY = Object.freeze({ sparse: 0.5, fair: 1, generous: 1.6 });

/**
 * Nothing but a promised quest reward is ever certain. Without this ceiling a
 * generous cache would reach 96% and the party would learn that opening a chest is
 * a formality.
 */
const MAX_ITEM_CHANCE = 0.95;

/** How much a drought adds to the odds, per turn, and the most it can ever add. */
const PITY_PER_TURN = 0.01;
const MAX_PITY = 0.25;

/** Rarity weights by source bias. Index matches `RARITIES`. */
const RARITY_WEIGHTS = Object.freeze({
	"-1": [70, 25, 5, 0.5, 0.1],
	0: [50, 32, 14, 3.5, 0.5],
	1: [30, 35, 25, 8, 2],
});

/** The enchantment bonus each tier carries. Trinkets ignore it — a +1 ring is not a thing. */
const TIER_BONUS = [0, 1, 1, 2, 3];

/** The highest rarity tier a party of a given level may find. */
const LEVEL_CAPS = Object.freeze([
	{ upTo: 4, maxTier: 1 },
	{ upTo: 8, maxTier: 2 },
	{ upTo: 12, maxTier: 3 },
	{ upTo: Infinity, maxTier: 4 },
]);

// A catalogue entry has to be a real, wieldable thing. "Unarmed Strike" and
// "Unarmored" are states of having no equipment, and handing one over as treasure
// would be a joke at the player's expense.
const WEAPONS = weaponCatalogue.filter((w) => /^\d+d\d+$/.test(w.damage || "") && w.name !== "Unarmed Strike");
const ARMOURS = armourCatalogue.filter((a) => Number(a.ac) > 10 && a.type && a.type !== "none");

/**
 * @description Picks one entry from a list.
 * @param {Array} list - The candidates.
 * @param {Function} rng - Random source.
 * @returns {*} One entry, or undefined when the list is empty.
 */
function pick(list, rng) {
	return list.length ? list[Math.floor(rng() * list.length)] : undefined;
}

/**
 * @description Picks an index from a weight table.
 * @param {number[]} weights - Relative weights; zeroes are never chosen.
 * @param {Function} rng - Random source.
 * @returns {number} The chosen index.
 */
function pickWeighted(weights, rng) {
	const total = weights.reduce((sum, w) => sum + w, 0);
	let roll = rng() * total;
	for (let i = 0; i < weights.length; i++) {
		roll -= weights[i];
		if (roll < 0) return i;
	}
	// Unreachable for any rng honouring [0, 1): `roll` starts below `total`, so some
	// subtraction takes it negative. Kept as the answer for a random source that
	// breaks its contract, and deliberately left uncovered — reaching it would mean
	// a test that counts this function's calls, which is the kind of test that breaks
	// on every refactor (`TDD-6`).
	return 0;
}

/**
 * @description Normalises a party level to something the tables can answer for. A
 *   level beyond the table is clamped rather than paying nothing, the same
 *   forgiveness `ADR 0008` gives an invented "CR 40".
 * @param {*} level - The level as supplied.
 * @returns {number} A level between 1 and 20.
 */
function normaliseLevel(level) {
	const n = Math.floor(Number(level));
	return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 1;
}

/**
 * @description The highest tier a party of this level may find.
 * @param {number} level - A normalised party level.
 * @returns {number} An index into `RARITIES`.
 */
function maxTierFor(level) {
	return LEVEL_CAPS.find((band) => level <= band.upTo).maxTier;
}

/**
 * @description Rolls a rarity, never above what the party's level allows.
 * @param {number} shift - The source's bias.
 * @param {number} level - A normalised party level.
 * @param {Function} rng - Random source.
 * @returns {number} A tier index.
 */
function rollTier(shift, level, rng) {
	const cap = maxTierFor(level);
	const weights = RARITY_WEIGHTS[String(shift)].map((w, i) => (i <= cap ? w : 0));
	return pickWeighted(weights, rng);
}

/**
 * Chooses an affix legal at this tier for this slot.
 *
 * @description The power has to match the promise. An earlier version drew from
 *   everything at or below the tier, and produced a *very-rare* "Pendant of the
 *   Wayfinder" whose entire effect was knowing which way north is — a legendary
 *   carrying an uncommon's power makes the whole rarity ladder decorative. Affixes
 *   are drawn from the item's own tier and the one below it, falling back to the full
 *   eligible set only when that window is empty.
 * @param {string} slot - "weapon", "armor" or "trinket".
 * @param {number} tier - The tier index.
 * @param {Function} rng - Random source.
 * @returns {object|undefined} The affix, or undefined when none fits.
 */
function pickAffix(slot, tier, rng) {
	const eligible = tables.affixes.filter(
		(a) => a.slots.includes(slot) && RARITIES.indexOf(a.minRarity) <= tier
	);
	const inWindow = eligible.filter((a) => RARITIES.indexOf(a.minRarity) >= tier - 1);
	return pick(inWindow.length ? inWindow : eligible, rng);
}

/** Where each slot's base items come from. */
const BASES = {
	weapon: () => WEAPONS,
	armor: () => ARMOURS,
	trinket: () => tables.trinketBases,
};

/**
 * @description Builds the attribute block for a base item in a slot.
 * @param {string} slot - "weapon", "armor" or "trinket".
 * @param {object} base - The catalogue entry.
 * @param {number} bonus - The enchantment bonus.
 * @param {object|undefined} affix - The affix, if any.
 * @returns {object} The attributes.
 */
function attributesFor(slot, base, bonus, affix) {
	if (slot === "weapon") {
		return {
			item_type: "weapon",
			damage: base.damage,
			damage_type: base.damageType,
			range: base.range || "melee",
		};
	}
	if (slot === "armor") {
		return {
			item_type: "armor",
			// Folded into `ac` because `enemyTurns.js` rolls against that field and reads
			// nothing else. A bonus kept beside it would be decoration.
			ac: Number(base.ac) + bonus + Number(affix?.attributes?.ac_bonus || 0),
			armor_type: base.type,
		};
	}
	return { ...base.attributes };
}

/**
 * @description Names an item.
 * @param {object} base - The catalogue entry.
 * @param {number} bonus - The enchantment bonus.
 * @param {object|undefined} affix - The affix, if any.
 * @returns {string} The name.
 */
function nameFor(base, bonus, affix) {
	// An affix that is a proper noun *is* the name — "Javelin the Sunderer" and
	// "Dagger Whisperfang" both came out of real rolls. The base survives in
	// `baseName` so the UI and the narrator still know what kind of thing it is.
	const prefix = bonus ? `+${bonus} ` : "";
	const stem = affix?.naming === "proper"
		? affix.label
		: `${base.name}${affix ? ` ${affix.label}` : ""}`;

	return `${prefix}${stem}`.trim();
}

/**
 * @description Builds one item at a given tier.
 * @param {number} tier - The tier index.
 * @param {Function} rng - Random source.
 * @returns {object|null} The item, or null when nothing could be built.
 */
function buildItem(tier, rng) {
	// A plain trinket is a ring with no ring in it. Trinkets carry an effect or they
	// do not appear, so the bottom tier is weapons and armour only.
	const slot = pick(tier === 0 ? ["weapon", "armor"] : ["weapon", "armor", "trinket"], rng);

	const bonus = slot === "trinket" ? 0 : TIER_BONUS[tier];
	const affix = tier === 0 ? undefined : pickAffix(slot, tier, rng);

	// Above common, an item with neither a bonus nor an effect would be a lie: the
	// rarity would promise something the stats do not deliver.
	if (tier > 0 && !affix && !bonus) return null;

	const base = pick(BASES[slot](), rng);
	if (!base) return null;

	const attributes = attributesFor(slot, base, bonus, affix);
	if (bonus) attributes.bonus = bonus;
	if (affix) Object.assign(attributes, affix.attributes);
	// A table field, not an item attribute: it is already inside `ac`, and leaving it
	// here invites the DM to add it a second time.
	delete attributes.ac_bonus;

	return {
		name: nameFor(base, bonus, affix),
		rarity: RARITIES[tier],
		slot,
		baseName: base.name,
		bonus,
		effect: affix?.effect || "",
		attributes,
	};
}

/**
 * @description Rolls the purse. Scales with level so a level 10 boss is worth
 *   appreciably more than a level 1 one, which was not true when the model decided.
 * @param {object} profile - The source profile.
 * @param {number} level - A normalised party level.
 * @param {number} multiplier - The generosity multiplier.
 * @param {Function} rng - Random source.
 * @returns {number} Gold, a whole number and never negative.
 */
function rollGold(profile, level, multiplier, rng) {
	if (rng() >= profile.gold * multiplier) return 0;

	let total = 0;
	for (let i = 0; i < profile.goldDice; i++) total += Math.floor(rng() * 6) + 1;

	return Math.max(0, Math.floor(total * (1 + level / 2)));
}

/**
 * Rolls what the party finds.
 *
 * @description Always returns a result. An empty one — no items, no gold — is a
 *   first-class outcome and the most common answer for an ordinary corpse.
 * @param {object} [opts] - The roll.
 * @param {string} [opts.source="search"] - One of `LOOT_SOURCES`; anything else is
 *   treated as `search` rather than throwing, because a typo must not kill a turn.
 * @param {number} [opts.partyLevel=1] - Average party level; clamped to 1–20.
 * @param {string} [opts.generosity="fair"] - The lobby's `lootGenerosity`.
 * @param {number} [opts.turnsSinceLastItem=0] - Turns since the party last found an
 *   item, which nudges the odds up so a session cannot go entirely dry.
 * @param {number} [opts.attemptsThisScene=0] - How many times the party has already
 *   searched here. Each repeat pays less, or "I search the bodies" typed twenty times
 *   is a gold faucet.
 * @param {Function} [opts.rng=Math.random] - Random source, injected for testability.
 * @returns {{source: string, rarity: string|null, gold: number, items: object[]}} The drop.
 */
export function rollLoot({
	source = "search",
	partyLevel = 1,
	generosity = "fair",
	turnsSinceLastItem = 0,
	attemptsThisScene = 0,
	rng = Math.random,
} = {}) {
	const kind = LOOT_SOURCES.includes(source) ? source : "search";
	const profile = SOURCE_PROFILE[kind];
	const level = normaliseLevel(partyLevel);
	const multiplier = GENEROSITY[generosity] ?? GENEROSITY.fair;

	// A promised reward is owed however thoroughly the room was already turned over.
	const repeats = kind === "quest" ? 0 : Math.max(0, Math.floor(Number(attemptsThisScene)) || 0);
	const exhaustion = 1 / (1 + repeats);

	const drought = Math.min(MAX_PITY, Math.max(0, Number(turnsSinceLastItem) || 0) * PITY_PER_TURN);
	const chance = kind === "quest"
		? 1
		: Math.min(MAX_ITEM_CHANCE, (profile.item * multiplier + drought) * exhaustion);

	const gold = rollGold(profile, level, multiplier * exhaustion, rng);

	const items = [];
	if (rng() < chance) {
		const first = buildItem(rollTier(profile.shift, level, rng), rng);
		if (first) items.push(first);

		// A hoard or a slain champion may yield a second thing. One reroll for a
		// distinct name, then let it go — a duplicate in one drop reads as a bug.
		if ((kind === "boss" || kind === "cache") && rng() < 0.3) {
			const second = buildItem(rollTier(profile.shift, level, rng), rng);
			if (second && !items.some((i) => i.name === second.name)) items.push(second);
		}
	}

	return {
		source: kind,
		rarity: items.length ? items[items.length - 1].rarity : null,
		gold,
		items,
	};
}
