/**
 * vocab — the fixed enumerations the console's forms offer.
 *
 * These were spelled out inline in the old panel's markup, several of them twice:
 * the condition list appeared once for "add" and again for "remove", so the two
 * could drift. Declared once here, every control that offers a choice offers the
 * same one.
 *
 * These mirror what the server accepts. Where the server lower-cases a value on
 * receipt — conditions do, in `adminRepairs.js` — the ids here are already in that
 * form, so what is sent matches what comes back.
 */

/** Status conditions a character can carry. Lower-case, as the server stores them. */
export const CONDITIONS = Object.freeze([
	"blinded", "burning", "charmed", "deafened", "exhausted", "frightened",
	"grappled", "incapacitated", "invisible", "paralyzed", "petrified",
	"poisoned", "prone", "restrained", "stunned", "unconscious",
]);

/** Kinds of item an admin can grant. */
export const ITEM_TYPES = Object.freeze([
	{ id: "weapon", label: "Weapon" },
	{ id: "armor", label: "Armor" },
	{ id: "trinket", label: "Trinket" },
	{ id: "consumable", label: "Consumable" },
]);

/** Damage types a granted weapon can deal. */
export const DAMAGE_TYPES = Object.freeze([
	"slashing", "piercing", "bludgeoning", "fire", "cold",
	"lightning", "necrotic", "radiant", "force",
]);

/** How a granted weapon is used. */
export const WEAPON_RANGES = Object.freeze(["melee", "ranged", "thrown"]);

/** Categories of granted armour. */
export const ARMOR_TYPES = Object.freeze(["light", "medium", "heavy", "shield"]);

/** Ability scores a requested roll can draw on. */
export const ABILITY_SCORES = Object.freeze([
	{ id: "str", label: "STR" },
	{ id: "dex", label: "DEX" },
	{ id: "con", label: "CON" },
	{ id: "int", label: "INT" },
	{ id: "wis", label: "WIS" },
	{ id: "cha", label: "CHA" },
]);

/** Dice an admin can ask a player to roll. */
export const DICE = Object.freeze([4, 6, 8, 10, 12, 20]);

/** Phases a lobby can be moved to, with the ids `admin:phase` expects. */
export const PHASES = Object.freeze([
	{ id: "characterCreation", label: "Character creation" },
	{ id: "readyCheck", label: "Ready check" },
	{ id: "running", label: "Running" },
]);
