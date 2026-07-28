/**
 * Reconciles the two channels the Dungeon Master can pay treasure through.
 *
 * @description The schema gives the model an `inventory` channel and a `gold`
 *   channel, and nothing stops it using both for the same coins. It does: a live
 *   probe had Sylvie handed `"Gold Pieces (Goblin Pouch)" ×6` as an item *and*
 *   `+6 gold` for the same pouch, and Brannor `"Burial Coffer — a small iron coffer
 *   containing old coins"` alongside `+22 gold`. The coins bank correctly and the
 *   player is left carrying a permanent junk entry named after the bag they came in.
 *
 *   As with `stripResolvedDamage`, an instruction is not a mechanism. This is the
 *   mechanism.
 */

/**
 * Words that make an item currency rather than a container. Deliberately narrow:
 * "gold" alone would swallow a Golden Amulet, so only coin nouns count.
 */
const COIN_WORDS = /\b(coins?|gp|sp|cp|gold pieces?|silver pieces?|copper pieces?|currency)\b/i;

/** Containers that are currency only when their contents say so. */
const CONTAINER_WORDS = /\b(pouch|purse|sack|coffer|strongbox|chest|bag|satchel|lockbox)\b/i;

/** A stated quantity anywhere in the item's text, e.g. "a pouch of 40 gold pieces". */
const STATED_AMOUNT = /(\d+)\s*(?:gp|sp|cp|gold|silver|copper|coins?)\b/i;

/**
 * @description Decides whether an inventory entry is really money. An entry that
 *   carries equippable mechanics is never currency however it is named — a
 *   coin-studded shield is a shield.
 * @param {object} entry - One `updates.inventory` entry.
 * @returns {boolean} True when the entry represents coins.
 */
function isCurrency(entry) {
	const attrs = entry?.attributes || {};
	if (attrs.damage || attrs.damage_type || attrs.ac || attrs.armor_type) return false;

	const name = String(entry?.item || "");
	const description = String(entry?.description || "");

	if (COIN_WORDS.test(name)) return true;
	// A bare container is only money when its own description says it holds coins.
	return CONTAINER_WORDS.test(name) && COIN_WORDS.test(description);
}

/**
 * @description Reads an unambiguous coin count out of an entry, or 0 when the
 *   amount cannot be known. A stated number wins over the stack count, because
 *   `"Pouch of 40 gold" ×1` means forty coins and not one.
 * @param {object} entry - One `updates.inventory` entry.
 * @returns {number} The coins the entry is worth, or 0 when it cannot be told.
 */
function statedAmount(entry) {
	const stated = STATED_AMOUNT.exec(`${entry?.item || ""} ${entry?.description || ""}`);
	if (stated) {
		const value = Number(stated[1]);
		if (Number.isFinite(value) && value > 0) return value;
	}
	// `"Gold Pieces" ×6` is six coins. `"Coin Purse" ×1` is a purse of unknown size,
	// and inventing a number for it would be minting treasure the DM never granted.
	const change = Number(entry?.change);
	return Number.isFinite(change) && change > 1 ? change : 0;
}

/**
 * Reconciles the DM's inventory and gold updates so coins are paid exactly once.
 *
 * @description Three outcomes per currency entry, in order:
 *   1. A `gold` update already exists for that player — the coins are banked, so the
 *      item is dropped and the gold left alone.
 *   2. No gold update, but the amount is unambiguous — the item becomes gold.
 *   3. No gold update and no readable amount — the entry is left exactly as it is.
 *      Deleting it would silently destroy treasure the DM meant to grant, which is
 *      worse than a badly named item.
 * @param {*} inventory - The DM's `updates.inventory` array.
 * @param {*} gold - The DM's `updates.gold` array.
 * @returns {{inventory: Array<object>, gold: Array<object>}} The reconciled channels.
 */
export function reconcileCurrency(inventory, gold) {
	const items = Array.isArray(inventory) ? inventory : [];
	const golds = Array.isArray(gold) ? gold : [];

	// Who the DM already paid this turn. Matched loosely on the name it used, because
	// the canonical player key is resolved later by the broadcasters.
	const paid = new Set(
		golds
			.filter((g) => Number.isFinite(Number(g?.delta)) && Number(g.delta) !== 0)
			.map((g) => String(g?.player || "").trim().toLowerCase())
	);

	const keptItems = [];
	const mintedGold = [];

	for (const entry of items) {
		if (!isCurrency(entry) || Number(entry?.change) <= 0) {
			keptItems.push(entry);
			continue;
		}

		const player = String(entry?.player || "").trim().toLowerCase();
		if (paid.has(player)) continue;

		const amount = statedAmount(entry);
		if (amount > 0) {
			mintedGold.push({ player: entry.player, delta: amount, reason: entry.item });
			// One conversion per player per turn; a second coin entry for the same
			// player would otherwise be dropped as "already paid" by its own sibling.
			paid.add(player);
			continue;
		}

		keptItems.push(entry);
	}

	return { inventory: keptItems, gold: [...golds, ...mintedGold] };
}

/**
 * Drops the DM's own copy of loot the server has already applied.
 *
 * @description The prompt tells it plainly not to add these. `stripResolvedDamage`
 *   exists because saying so did not work for enemy damage — a character was wounded
 *   twice for one blow — and there is no reason to expect better here, where the
 *   consequence is a party carrying two of everything.
 *
 *   Narrow on purpose. Only an item the server actually granted is dropped, matched by
 *   name; a key or a potion the DM invented in the same breath survives. Gold is
 *   dropped only when the server granted some, and only when it is a *gain* — a player
 *   spending coin on the same turn keeps their purchase.
 * @param {*} inventory - The DM's `updates.inventory` array.
 * @param {*} gold - The DM's `updates.gold` array.
 * @param {object|null} granted - What `rollLoot` produced this turn, if anything.
 * @returns {{inventory: Array<object>, gold: Array<object>}} The surviving updates.
 */
export function stripGrantedLoot(inventory, gold, granted) {
	const items = Array.isArray(inventory) ? inventory : [];
	const golds = Array.isArray(gold) ? gold : [];
	if (!granted) return { inventory: items, gold: golds };

	const grantedNames = new Set((granted.items || []).map((i) => String(i?.name || "").trim().toLowerCase()));

	return {
		inventory: items.filter((entry) => !grantedNames.has(String(entry?.item || "").trim().toLowerCase())),
		gold: granted.gold > 0 ? golds.filter((g) => !(Number(g?.delta) > 0)) : golds,
	};
}
