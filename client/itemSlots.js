/**
 * Which equipment slot an inventory item fits, if any.
 *
 * @description Extracted from `uiComponents.js` so it can be unit tested, following
 *   the same split the admin console uses: the decision is a pure module, the
 *   rendering stays a thin layer over it. `index.html` bridges the two, as it
 *   already does for the portrait prompt builder.
 *
 *   The order of the checks is the whole point. A stated `item_type` is
 *   authoritative and is consulted first — including the types that mean "not
 *   equipment at all", which the previous version tested *after* its name-keyword
 *   pass, so an Orb of Alchemist's Fire was offered as a trinket because "orb" is a
 *   trinket word.
 */

/**
 * Item types that are carried rather than worn or wielded. A `quest` item — a
 * letter, a key, a map — is not gear, and there is only one trinket slot for it to
 * crowd out.
 */
export const NON_EQUIPPABLE_TYPES = new Set(["consumable", "quest"]);

/**
 * Reports whether an item can be drunk, eaten or otherwise spent.
 *
 * @description Lives here rather than beside the effect resolver because it is the
 *   same question as `equipSlotFor` — what kind of thing is this? — and the browser
 *   needs the answer to decide whether to offer a Use button. The server imports it
 *   back across, as it already does for the portrait prompt builder.
 *
 *   A stated type is the signal, but the starting Healing Potion predates the type
 *   field and carries only `healing`, so that counts too: refusing to drink the
 *   potion every character starts with would be the worst possible introduction to
 *   the feature.
 * @param {object} item - An inventory item.
 * @returns {boolean} True when the item is consumable.
 */
export function isConsumable(item) {
	if (!item || typeof item !== "object") return false;
	const attrs = item.attributes && typeof item.attributes === "object" ? item.attributes : {};
	if (String(attrs.item_type || "").trim().toLowerCase() === "consumable") return true;
	return Boolean(attrs.healing);
}

/** Types that name their own slot. */
const TYPE_SLOTS = {
	weapon: "weapon",
	armor: "armor",
	trinket: "trinket",
	ring: "trinket",
	amulet: "trinket",
	necklace: "trinket",
	bracelet: "trinket",
	cloak: "trinket",
};

const WEAPON_WORDS = ["sword", "axe", "bow", "dagger", "mace", "staff", "spear", "hammer", "blade", "crossbow", "halberd", "flail", "rapier", "scimitar", "warhammer", "greataxe", "greatsword", "glaive", "trident", "whip", "javelin", "sling", "wand", "club", "morningstar", "pike", "lance", "scythe"];
const ARMOR_WORDS = ["armor", "shield", "mail", "plate", "leather armor", "chainmail", "breastplate", "splint", "studded", "half plate", "scale mail", "padded armor", "hide armor", "buckler"];
const TRINKET_WORDS = ["ring", "amulet", "necklace", "bracelet", "cloak", "pendant", "brooch", "circlet", "charm", "talisman", "torc", "cape", "mantle", "crown", "tiara", "belt", "sash", "orb", "gem", "jewel"];

/**
 * Decides which slot an item can be equipped into.
 *
 * @param {object} item - An inventory item; `name` and `attributes` are read.
 * @returns {"weapon"|"armor"|"trinket"|null} The slot, or null when the item is not
 *   equipment.
 */
export function equipSlotFor(item) {
	if (!item || typeof item !== "object") return null;

	const attrs = item.attributes && typeof item.attributes === "object" ? item.attributes : {};
	const type = String(attrs.item_type || "").trim().toLowerCase();

	// 1. A stated type is authoritative — including a type that means "not gear".
	if (NON_EQUIPPABLE_TYPES.has(type)) return null;
	if (TYPE_SLOTS[type]) return TYPE_SLOTS[type];

	// 2. Mechanical attributes imply the slot when the model named no type.
	if (attrs.damage || attrs.damage_type) return "weapon";
	if (attrs.ac || attrs.armor_type) return "armor";

	// 3. Name keywords, last, because they are the guess most likely to be wrong.
	const name = String(item.name || "").toLowerCase();
	if (!name) return null;
	if (WEAPON_WORDS.some((w) => name.includes(w))) return "weapon";
	if (ARMOR_WORDS.some((w) => name.includes(w))) return "armor";
	if (TRINKET_WORDS.some((w) => name.includes(w))) return "trinket";

	return null;
}
