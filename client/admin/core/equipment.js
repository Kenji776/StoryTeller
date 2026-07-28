/**
 * equipment — building the payload that grants a character an item.
 *
 * A grant is an `inventory:update` with an `attributes` object the game reads for
 * mechanics and the model reads for narration. The old panel assembled it inline
 * and silently substituted defaults for anything malformed, so a mistyped damage
 * expression became a d6 without saying so.
 *
 * Here a malformed value is refused with a message naming the field, and only an
 * *absent* value falls back to a default.
 */

import { ITEM_TYPES, DAMAGE_TYPES, WEAPON_RANGES, ARMOR_TYPES } from "./vocab.js";

/** Damage when a weapon grant does not state one. */
export const DEFAULT_DAMAGE = "1d6";

/** Armour class when an armour grant does not state one. */
export const DEFAULT_AC = 12;

/** Dice expressions the game can roll: `2d6`, `1d8+2`, `3d4-1`. */
export const DAMAGE_PATTERN = /^\d+d\d+(\s*[+-]\s*\d+)?$/i;

/** Item type ids, for validation. */
const TYPE_IDS = ITEM_TYPES.map((type) => type.id);

/**
 * @description Trims a value that must be a non-empty string.
 * @param {*} value - The candidate.
 * @returns {string} The trimmed text, or `""` when it is not usable text.
 */
function text(value) {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * @description Picks a stated value from a vocabulary, or the vocabulary's first
 *   entry when nothing was stated.
 * @param {*} value - What the form held.
 * @param {Array<string>} allowed - The permitted values.
 * @param {string} label - The field's name, for the refusal message.
 * @returns {string} The chosen value.
 * @throws {RangeError} When a value was stated but is not in the vocabulary.
 */
function fromVocabulary(value, allowed, label) {
	const chosen = text(value);
	if (!chosen) return allowed[0];
	if (!allowed.includes(chosen.toLowerCase())) {
		throw new RangeError(`Unknown ${label} "${chosen}". Expected one of: ${allowed.join(", ")}.`);
	}
	return chosen.toLowerCase();
}

/**
 * @description Builds the attributes for a weapon.
 * @param {object} form - The grant form's values.
 * @returns {object} The weapon's attributes.
 * @throws {RangeError} When the damage expression, damage type or range is malformed.
 */
function weaponAttributes(form) {
	const damage = text(form.damage) || DEFAULT_DAMAGE;
	if (!DAMAGE_PATTERN.test(damage)) {
		throw new RangeError(`"${damage}" is not a damage expression the game can roll. Try 2d6 or 1d8+2.`);
	}
	return {
		damage: damage.replace(/\s+/g, ""),
		damage_type: fromVocabulary(form.damageType, DAMAGE_TYPES, "damage type"),
		range: fromVocabulary(form.range, WEAPON_RANGES, "range"),
	};
}

/**
 * @description Builds the attributes for a piece of armour.
 * @param {object} form - The grant form's values.
 * @returns {object} The armour's attributes.
 * @throws {RangeError} When the armour class or armour type is malformed.
 */
function armorAttributes(form) {
	// Absent means "use the default"; present-but-nonsense is a mistake worth
	// reporting, so the two are distinguished rather than both falling back.
	const stated = form.ac !== undefined && form.ac !== null && form.ac !== "";
	const ac = stated ? Number(form.ac) : DEFAULT_AC;
	if (!Number.isInteger(ac) || ac < 0) {
		throw new RangeError(`"${form.ac}" is not an armour class. Expected a whole number of 0 or more.`);
	}
	return { ac, armor_type: fromVocabulary(form.armorType, ARMOR_TYPES, "armour type") };
}

/**
 * @description Builds the `inventory:update` payload for granting an item.
 * @param {object} form - The grant form's values.
 * @param {string} form.player - Who receives it.
 * @param {string} form.name - The item's name.
 * @param {string} form.type - An {@link ITEM_TYPES} id.
 * @param {string} [form.description] - Free text the model interprets on use.
 * @param {string} [form.damage] - Weapons: a dice expression.
 * @param {string} [form.damageType] - Weapons: a {@link DAMAGE_TYPES} entry.
 * @param {string} [form.range] - Weapons: a {@link WEAPON_RANGES} entry.
 * @param {number|string} [form.ac] - Armour: the armour class.
 * @param {string} [form.armorType] - Armour: an {@link ARMOR_TYPES} entry.
 * @returns {object} The payload for `admin:event` of type `inventory:update`.
 * @throws {TypeError} When the player or item name is missing, or the item type is
 *   not one the game knows.
 * @throws {RangeError} When a stated damage expression, damage type, range, armour
 *   class or armour type is malformed.
 */
export function buildGrantPayload(form = {}) {
	const player = text(form.player);
	if (!player) throw new TypeError("A grant needs a player to give the item to.");

	const name = text(form.name);
	if (!name) throw new TypeError("A grant needs an item name.");

	const type = text(form.type);
	if (!TYPE_IDS.includes(type)) {
		throw new TypeError(`Unknown item type "${type}". Expected one of: ${TYPE_IDS.join(", ")}.`);
	}

	// Mechanics are read per type rather than merged, so switching the type after
	// filling the weapon fields cannot grant a trinket that deals damage.
	let attributes = { item_type: type };
	if (type === "weapon") attributes = { ...attributes, ...weaponAttributes(form) };
	else if (type === "armor") attributes = { ...attributes, ...armorAttributes(form) };

	return {
		player,
		item: name,
		change: 1,
		// The model reads this when the item is used; falling back to the name gives
		// it something truthful rather than an empty string.
		description: text(form.description) || name,
		attributes,
	};
}
