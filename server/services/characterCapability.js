/**
 * characterCapability — the single truthful answer to "what can this character
 * do right now", shared by the feasibility gate and the newbie advisor.
 *
 * Built as one module because the alternative is two models that drift: an advisor
 * that recommends a spell the gate then rejects is worse than no advisor at all.
 *
 * Two principles run through this file.
 *
 * **Normalise every legacy shape.** Abilities and inventory entries may be bare
 * strings, conditions may be a comma-joined display string carrying "None"/"Dead"
 * sentinels, and stats may be missing or not even an object. Callers get one shape.
 *
 * **Never invent a fact.** Where the engine genuinely does not know something, the
 * value is `null` and a sibling flag says so. `max_hp` has four different fallbacks
 * across four existing consumers (1, 1, 10, 10) — adding a fifth guess here would
 * make this module authoritative about something nobody actually knows, and that
 * guess would then be laundered into an LLM prompt as though it were true.
 */

import classProgression from "../../client/config/classProgression.json" with { type: "json" };
import { armourClass } from "./armourClass.js";

/** Display sentinels that appear in condition strings but are not conditions. */
const CONDITION_SENTINELS = new Set(["none", "dead", "healthy", "alive", ""]);

/** Activations a level-one character starts with when the host has not chosen. */
export const DEFAULT_SLOT_BASE = 1;

/** Sentinel for a pool that never runs out. A string because Infinity does not survive JSON. */
export const UNLIMITED_SLOTS = "unlimited";

/** Keys that must never survive into an object built from persisted JSON. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @description Computes the character's remaining pool of ability activations.
 *
 *   Exported because five separate files currently recompute this inline
 *   (`client/app.js`, `client/uiComponents.js` twice, `client/sockets.js`,
 *   `lobbyPrompts.js`) and any of them can drift from the others.
 *
 *   Note what this pool actually is: a single flat counter whose maximum equals the
 *   character's level, spent by *every* ability — martial manoeuvres as well as
 *   spells — and refilled only by a long rest. A level-1 Fighter therefore has one
 *   activation of anything.
 * @param {object} player - A player record.
 * @returns {number} Activations remaining, never negative.
 */
export function remainingSlots(player, base = DEFAULT_SLOT_BASE) {
	const capacity = slotCapacity(player, base);
	if (capacity === Infinity) return Infinity;
	const used = Number(player?.spellSlotsUsed) || 0;
	return Math.max(0, capacity - used);
}

/**
 * @description Computes the size of the pool before anything is spent.
 *
 *   `base` is how many activations a level-1 character starts with, set by the host
 *   (`lobby.abilitySlotsBase`). Levelling still adds one per level on top, so the
 *   default of 1 reproduces the original `max = level` exactly while letting a host
 *   open the game up — one activation for an entire level-1 session is punishing,
 *   and it was not a decision anyone had made deliberately.
 * @param {object} player - A player record.
 * @param {number|"unlimited"} [base=1] - Activations at level one, or `"unlimited"`.
 * @returns {number} The capacity, or `Infinity` when unlimited.
 */
export function slotCapacity(player, base = DEFAULT_SLOT_BASE) {
	if (base === UNLIMITED_SLOTS) return Infinity;
	const level = Number(player?.level) || 1;
	const configured = Number(base);
	// A malformed setting falls back to the default rather than collapsing the pool
	// to zero, which would silently forbid every ability in the game.
	const effective = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SLOT_BASE;
	return Math.max(0, effective + (level - 1));
}

/**
 * @description Returns a finite number, or `null` when the value is absent or unusable.
 * @param {*} value - Candidate.
 * @returns {number|null} The number, or `null`.
 */
function numberOrNull(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * @description Deep-copies a plain data value, dropping prototype-polluting keys.
 *   Persisted lobby JSON is parsed from disk and has been shaped by LLM output, so
 *   it is treated as untrusted.
 * @param {*} value - Value to copy.
 * @returns {*} A safe copy.
 */
function safeCopy(value) {
	if (Array.isArray(value)) return value.map(safeCopy);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (FORBIDDEN_KEYS.has(k)) continue;
			out[k] = safeCopy(v);
		}
		return out;
	}
	return value;
}

/**
 * @description Normalises one ability, tolerating the bare-string legacy form.
 * @param {*} raw - An ability entry.
 * @returns {object|null} The normalised ability, or `null` if unusable.
 */
function normaliseAbility(raw) {
	if (typeof raw === "string" && raw.trim()) {
		return { name: raw.trim(), description: "", details: {}, usesTracked: false, legacy: true };
	}
	if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim()) return null;
	return {
		name: raw.name.trim(),
		description: typeof raw.description === "string" ? raw.description : "",
		details: safeCopy(raw.details ?? {}),
		// details.uses and details.recharge exist on much of the class table but no
		// code decrements or resets them, so reporting them as live budgets would be
		// a fiction. The shared pool is the only resource the engine actually spends.
		usesTracked: false,
		legacy: false,
	};
}

/**
 * @description Normalises one inventory entry, tolerating the bare-string legacy form.
 * @param {*} raw - An inventory entry.
 * @returns {object|null} The normalised item, or `null` if unusable.
 */
function normaliseItem(raw) {
	if (typeof raw === "string" && raw.trim()) {
		return { name: raw.trim(), count: 1, description: "", attributes: {}, chargesTracked: false, legacy: true };
	}
	if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim()) return null;
	return {
		name: raw.name.trim(),
		count: numberOrNull(raw.count) ?? 1,
		description: typeof raw.description === "string" ? raw.description : "",
		attributes: safeCopy(raw.attributes ?? {}),
		// No charges/uses field exists on items anywhere in the schema.
		chargesTracked: false,
		legacy: false,
	};
}

/**
 * @description Normalises conditions from either the array form (`conditions:update`)
 *   or the comma-joined display string with sentinels (`party:update`).
 * @param {*} raw - Conditions in either shape.
 * @returns {string[]} Lower-cased condition names, sentinels removed.
 */
function normaliseConditions(raw) {
	const parts = Array.isArray(raw)
		? raw
		: typeof raw === "string" ? raw.split(",") : [];
	return parts
		.map((c) => String(c).trim().toLowerCase())
		.filter((c) => c && !CONDITION_SENTINELS.has(c));
}

/**
 * @description Builds the capability model for one character.
 *
 *   Pure: reads the lobby, mutates nothing, and returns a fresh structure the caller
 *   cannot use to reach back into stored state.
 * @param {object} lobby - A lobby object from `store.index[lobbyId]`.
 * @param {string} playerName - The character to describe.
 * @returns {object} `{ok: false, reason}` when the character cannot be found, else the
 *   full capability: identity, health, resources, abilities, inventory, equipped
 *   gear, conditions, turn state, and any `warnings` raised while normalising.
 */
export function buildCapability(lobby, playerName) {
	const player = lobby?.players?.[playerName];
	if (!player || typeof player !== "object") {
		return { ok: false, reason: `Character "${playerName}" not found in this lobby.` };
	}

	const warnings = [];
	const stats = player.stats && typeof player.stats === "object" ? player.stats : {};
	if (player.stats && typeof player.stats !== "object") warnings.push("stats was not an object; treated as empty");

	// ── Abilities ──
	const rawAbilities = Array.isArray(player.abilities) ? player.abilities : [];
	if (player.abilities && !Array.isArray(player.abilities)) warnings.push("abilities was not an array; treated as empty");
	const abilities = rawAbilities.map(normaliseAbility).filter(Boolean);
	if (abilities.length !== rawAbilities.length) {
		warnings.push(`${rawAbilities.length - abilities.length} unusable ability entr(y/ies) dropped`);
	}

	// ── Inventory ──
	const rawInventory = Array.isArray(player.inventory) ? player.inventory : [];
	if (player.inventory && !Array.isArray(player.inventory)) warnings.push("inventory was not an array; treated as empty");
	const inventory = rawInventory.map(normaliseItem).filter(Boolean);
	if (inventory.length !== rawInventory.length) {
		warnings.push(`${rawInventory.length - inventory.length} unusable inventory entr(y/ies) dropped`);
	}

	const level = Number(player.level) || 1;
	const hp = numberOrNull(stats.hp);
	const conditions = normaliseConditions(player.conditions);
	const dead = !!player.dead;

	const current = Array.isArray(lobby.initiative) ? lobby.initiative[lobby.turnIndex ?? 0] : null;

	return {
		ok: true,

		identity: {
			name: typeof player.name === "string" ? player.name : String(playerName),
			className: typeof player.class === "string" ? player.class : null,
			race: typeof player.race === "string" ? player.race : null,
			level,
		},

		// The class table only covers 12 classes; the default "Adventurer" has no
		// entry, so getAbilityForLevel silently returns null forever for such a
		// character. Surfacing it stops the advisor promising progression that
		// will never arrive.
		classKnown: Object.prototype.hasOwnProperty.call(classProgression, player.class),

		health: {
			hp,
			maxHp: numberOrNull(stats.max_hp),
			dead,
		},

		resources: {
			slots: (() => {
				const base = lobby.abilitySlotsBase ?? DEFAULT_SLOT_BASE;
				const capacity = slotCapacity(player, base);
				const unlimited = capacity === Infinity;
				return {
					remaining: unlimited ? Infinity : remainingSlots(player, base),
					// Null rather than Infinity: there is no maximum to report, and
					// Infinity does not survive the trip through JSON to a client.
					max: unlimited ? null : capacity,
					unlimited,
					note: "One shared pool covering every ability, martial and magical alike. Refills only on a long rest.",
				};
			})(),
			gold: numberOrNull(player.gold) ?? 0,
		},

		abilities,
		inventory,

		equipped: {
			weapon: player.weapon?.name ? safeCopy(player.weapon) : null,
			armor: player.armor?.name ? safeCopy(player.armor) : null,
			trinket: player.trinket?.name ? safeCopy(player.trinket) : null,
			// The same function the enemies roll against. This used to report the bare
			// number printed on the armour, so a player was told AC 11 while combat used
			// 14 — or, before the dexterity rules landed, told 11 while being hit as 11
			// when going unarmoured would have made them 13.
			armorClass: armourClass(player),
		},

		conditions,

		isMyTurn: current === (player.name || playerName),
		// Zero HP counts as down even without the dead flag: HP and the flag are set
		// by separate code paths and can disagree.
		canAct: !dead && (hp === null || hp > 0),

		warnings,
	};
}
