/**
 * What drinking a consumable does.
 *
 * @description Potions were unusable. The DM handed them out freely — a live probe
 *   produced four healing potions in six turns — and there was no path anywhere in
 *   client or server to drink one: `uiComponents.js` returned null for a consumable
 *   and no socket event consumed anything. A player's only recourse was to type "I
 *   drink the potion" and hope the narrator remembered to emit an inventory removal
 *   and an HP update. Often it did not.
 *
 *   This resolves the item's effect. Applying it, spending the item and telling the
 *   room are the caller's job — this stays pure so the effect can be pinned in a
 *   test, per `CQ-5`.
 */

import { rollExpression } from "../helpers/dice.js";
import { canonicalCondition } from "./conditions.js";
// Classification lives with the other item-kind questions so the browser can ask it
// too — the Use button needs the same answer this module does. Same crossing the
// server already makes for the portrait prompt builder.
import { isConsumable } from "../../client/itemSlots.js";

/** How the character builder phrases a potion in prose, when it sets no attribute. */
const HEALING_IN_PROSE = /restores?\s+([0-9d+\-\s]+?)\s*(?:hit\s*points?|hp)\b/i;

/**
 * @description Reads how much an item heals, from its attribute or its prose.
 * @param {object} item - The item.
 * @param {object} attrs - Its attributes.
 * @param {Function} rng - Random source.
 * @returns {number} Hit points restored; 0 when the item heals nothing or the
 *   expression cannot be read.
 */
function healingFrom(item, attrs, rng) {
	const stated = attrs.healing ? String(attrs.healing) : null;
	const prose = stated ? null : HEALING_IN_PROSE.exec(String(item.description || ""))?.[1];
	const expression = stated ?? prose;
	if (!expression) return 0;

	// "2d4 + 2" carries spaces the roller strips; an unreadable value heals nothing
	// rather than propagating NaN into a character's hit points.
	return rollExpression(expression, rng)?.total ?? 0;
}

/**
 * @description Reads which conditions an item clears, discarding any the game does
 *   not recognise and — when the character's state is known — any they do not have.
 * @param {object} attrs - The item's attributes.
 * @param {string[]|null} held - The character's current conditions, or null when the
 *   caller does not know them.
 * @returns {string[]} Canonical condition names, in the order the item gave them.
 */
function curesFrom(attrs, held) {
	const raw = Array.isArray(attrs.cures) ? attrs.cures : (attrs.cures ? [attrs.cures] : []);
	const named = raw.map(canonicalCondition).filter(Boolean);
	if (!held) return named;

	const on = new Set(held.map(canonicalCondition).filter(Boolean));
	return named.filter((c) => on.has(c));
}

/**
 * Resolves what happens when a character consumes an item.
 *
 * @param {object} item - The inventory item being consumed.
 * @param {object} [deps] - Injected collaborators.
 * @param {Function} [deps.rng=Math.random] - Random source for dice.
 * @param {string[]} [deps.conditions] - The character's current conditions. Given,
 *   the summary reports only what actually changed; omitted, every cure the item
 *   names is attempted, so a caller that does not track conditions loses nothing.
 * @returns {{hp: number, conditions: {add: string[], remove: string[]}, summary: string}|null}
 *   The effect, or null when the item is not consumable.
 */
export function resolveConsumable(item, { rng = Math.random, conditions = null } = {}) {
	if (!isConsumable(item)) return null;

	const attrs = item.attributes && typeof item.attributes === "object" ? item.attributes : {};
	const name = String(item.name || "Something");

	const hp = healingFrom(item, attrs, rng);
	const remove = curesFrom(attrs, Array.isArray(conditions) ? conditions : null);

	const parts = [];
	if (hp > 0) parts.push(`restoring ${hp} HP`);
	if (remove.length) parts.push(`clearing ${remove.join(", ")}`);

	// An unknown vial is still drunk. Whether anything happens is the DM's to
	// narrate; what must not happen is the item staying in the bag.
	const summary = parts.length
		? `Used ${name}, ${parts.join(" and ")}.`
		: `Used ${name}. Nothing obvious happens.`;

	return { hp, conditions: { add: [], remove }, summary };
}
