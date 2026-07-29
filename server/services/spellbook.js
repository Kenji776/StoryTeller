/**
 * spellbook — what a character can cast, what they may learn next, and what casting costs.
 *
 * @description Casters had no spells. `classProgression.json` begins at level 2, so a
 *   level-1 caster's `abilities` array was empty, and `hardChecks` rejected "I cast
 *   magic missile" as an unknown ability — with a strike. Only the vague "I cast a
 *   spell" got through, and that fell to a flat 15/8 ladder rolling `int` whatever the
 *   class. 102 of the 115 characters in stored lobbies are level 1 and a third of them
 *   are casters, so this was most of what magic did in this game.
 *
 *   Mechanics are structured fields on `spells.json`, never prose. The class table's
 *   own `details.damage` shows why: `"20d10 force on hit; 10d10 in 20-ft radius (DEX
 *   save half)"` is not parseable, and two of its entries deal damage on a *successful*
 *   save, so a reader that guessed would get them backwards.
 *
 *   A caster knows a *chosen* list rather than their whole class list: three picks in
 *   the character builder, one more per level thereafter, from anything on the class
 *   list at or below their spell level. Cantrips are at will; levelled spells spend the
 *   shared activation pool. See docs/modules/spells.md.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { normaliseForMatch as normalise } from "../helpers/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read from disk rather than imported as a JSON module: `import ... with {type:"json"}`
 * is still experimental and prints a warning on every server boot. `classProgression.js`
 * reads its config the same way.
 */
const CATALOGUE = JSON.parse(
	fs.readFileSync(path.join(__dirname, "..", "..", "client", "config", "spells.json"), "utf8"),
).spells;

/**
 * Which ability score each class casts with.
 *
 * @description The defect this replaces was a hardcoded `statKey = "int"` covering every
 *   caster, so a Cleric with WIS 18 and INT 8 cast at their worst stat. Absence is
 *   meaningful: a class that is not a key here does not cast at all.
 */
const CASTING_ABILITY = Object.freeze({
	wizard: "int",
	cleric: "wis",
	druid: "wis",
	ranger: "wis",
	sorcerer: "cha",
	warlock: "cha",
	bard: "cha",
	paladin: "cha",
});

/** Classes that cast from level 1. Paladins and rangers gain spells at level 2 in 5e. */
const LATE_CASTERS = new Set(["paladin", "ranger"]);

/**
 * How many spells a caster picks when their character is created.
 *
 * @description Chosen freely from everything available to the class — cantrips and
 *   level-1 spells alike — in the character builder. Exported so the builder renders the
 *   right number rather than hardcoding its own.
 */
export const STARTING_SPELL_PICKS = 3;

/** The ceiling on spell level, as 5e has it. */
const MAX_SPELL_LEVEL = 9;

/**
 * @description Returns a caller-owned copy, so a consumer that sorts or splices the
 *   result cannot change what the next caster sees. The catalogue is module state read
 *   once at boot and handed to a prompt builder, so this is not optional.
 * @param {object[]} spells - Catalogue entries.
 * @returns {object[]} Deep copies.
 */
function copyAll(spells) {
	return spells.map((spell) => structuredClone(spell));
}

/**
 * @description Which ability score a class casts with.
 * @param {*} className - The character's class.
 * @returns {"int"|"wis"|"cha"|null} The ability key, or null for a non-caster.
 */
export function castingAbility(className) {
	if (typeof className !== "string") return null;
	return CASTING_ABILITY[normalise(className)] ?? null;
}

/**
 * @description Whether the class casts spells at all.
 * @param {*} className - The character's class.
 * @returns {boolean} True for a spellcasting class.
 */
export function isCaster(className) {
	return castingAbility(className) !== null;
}

/**
 * @description The highest spell level a character of this level may learn or cast.
 *
 *   Half character level rounded up. A malformed level falls back to 1 rather than 0:
 *   collapsing the ceiling would silently leave a caster unable to cast anything, which
 *   is the exact failure this module exists to end.
 * @param {*} characterLevel - The character's level.
 * @returns {number} A spell level between 1 and 9.
 */
export function maxSpellLevel(characterLevel) {
	const level = Math.floor(Number(characterLevel));
	if (!Number.isFinite(level) || level < 1) return 1;
	return Math.min(MAX_SPELL_LEVEL, Math.max(1, Math.ceil(level / 2)));
}

/**
 * @description Whether a catalogue entry sits on a class's list.
 * @param {object} spell - A catalogue entry.
 * @param {string} classKey - The normalised class name.
 * @returns {boolean} True when the class may learn it.
 */
function onClassList(spell, classKey) {
	return Array.isArray(spell.classes) && spell.classes.some((c) => normalise(c) === classKey);
}

/**
 * @description Every spell this class could learn at this level — the pool a level-up
 *   pick is drawn from, not what the character knows.
 * @param {*} className - The character's class.
 * @param {*} characterLevel - The character's level.
 * @returns {object[]} The available spells, in catalogue order.
 */
export function spellsAvailableTo(className, characterLevel) {
	if (!isCaster(className)) return [];

	const classKey = normalise(className);
	const level = Math.floor(Number(characterLevel));
	// A paladin or ranger has no magic at level 1; every other caster does.
	if (LATE_CASTERS.has(classKey) && Number.isFinite(level) && level < 2) return [];

	const ceiling = maxSpellLevel(characterLevel);
	return copyAll(CATALOGUE.filter((s) => onClassList(s, classKey) && Number(s.level) <= ceiling));
}

/**
 * @description The loadout a caster falls back to when nobody has picked for them.
 *
 *   The player chooses {@link STARTING_SPELL_PICKS} in the character builder; this is
 *   what a character gets without that — an import, a character created before this
 *   feature, or a class changed after the fact. Catalogue order puts cantrips first, so
 *   the default is all-cantrip: at-will, so the character can always act, and it never
 *   silently hands out the scarce levelled spells the player should be choosing.
 * @param {*} className - The character's class.
 * @returns {object[]} The starting spells.
 */
export function startingSpells(className) {
	return spellsAvailableTo(className, 1).slice(0, STARTING_SPELL_PICKS);
}

/**
 * @description Validates the picks submitted from the character builder.
 *
 *   The boundary validator for character creation — the names arrive from a browser, so
 *   `CQ-6` applies: check once, here, and let everything downstream trust the result. A
 *   name that is not a real spell, or not on this class's list, is dropped rather than
 *   rejected, so one stale entry cannot block a character save; picking *too many* is a
 *   refusal, because silently keeping the first three would misreport what the player
 *   chose.
 * @param {*} className - The character's class.
 * @param {*} names - The submitted spell names.
 * @returns {{ok: boolean, spells: object[], dropped: string[], reason?: string}} The verdict.
 * @throws {never} Returns a verdict for every input rather than throwing.
 */
export function validateStartingSpells(className, names) {
	// A non-caster is not an error — a player who switches class after picking should
	// lose the spells, not the character.
	if (!isCaster(className)) return { ok: true, spells: [], dropped: [] };

	if (!Array.isArray(names)) {
		return { ok: false, spells: [], dropped: [], reason: "Spell picks must be a list." };
	}

	const available = spellsAvailableTo(className, 1);
	const byName = new Map(available.map((s) => [normalise(s.name), s]));

	const spells = [];
	const dropped = [];
	const seen = new Set();
	for (const entry of names) {
		const raw = typeof entry === "string" ? entry : entry?.name;
		const key = normalise(raw);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		if (byName.has(key)) spells.push(byName.get(key));
		else dropped.push(String(raw ?? ""));
	}

	if (spells.length > STARTING_SPELL_PICKS) {
		return {
			ok: false,
			spells: [],
			dropped,
			reason: `Choose ${STARTING_SPELL_PICKS} spells; you chose ${spells.length}.`,
		};
	}

	return { ok: true, spells, dropped };
}

/**
 * @description The spells a character actually knows.
 *
 *   A stored list is resolved against the catalogue rather than trusted: player records
 *   are written by the DM and reloaded from disk, so an entry naming a spell that does
 *   not exist, or one the class cannot cast, is dropped rather than honoured. A caster
 *   with no list at all predates this feature and gets the starting loadout — the 38
 *   casters already in stored lobbies must not be left mute by this landing.
 *
 *   An *empty* array is a decision and is respected; only a missing or malformed one
 *   falls back.
 * @param {object} player - A player record.
 * @returns {object[]} The known spells.
 */
export function knownSpells(player) {
	if (!player || typeof player !== "object") return [];
	if (!isCaster(player.class)) return [];

	if (!Array.isArray(player.spells)) return startingSpells(player.class);

	const available = spellsAvailableTo(player.class, player.level);
	const byName = new Map(available.map((s) => [normalise(s.name), s]));
	const seen = new Set();
	const known = [];
	for (const entry of player.spells) {
		const key = normalise(typeof entry === "string" ? entry : entry?.name);
		if (!key || seen.has(key) || !byName.has(key)) continue;
		seen.add(key);
		known.push(byName.get(key));
	}
	return known;
}

/**
 * @description What this character may pick on levelling: available, minus known.
 *   Lower-level spells stay on offer — a pick is "from that level or lower".
 * @param {object} player - A player record.
 * @returns {object[]} The choices.
 */
export function spellChoicesFor(player) {
	if (!player || typeof player !== "object" || !isCaster(player.class)) return [];
	const known = new Set(knownSpells(player).map((s) => normalise(s.name)));
	return spellsAvailableTo(player.class, player.level).filter((s) => !known.has(normalise(s.name)));
}

/**
 * @description Whether this character may learn this spell.
 *
 *   The validation behind the level-up socket, where the name arrives from a client and
 *   is therefore untrusted — `CQ-6`, validated once at the boundary. Every refusal
 *   carries a reason, because this one is shown to a player.
 * @param {object} player - A player record.
 * @param {*} spellName - The requested spell.
 * @returns {{ok: boolean, reason?: string, spell?: object}} The verdict.
 */
export function canLearn(player, spellName) {
	if (!player || typeof player !== "object") {
		return { ok: false, reason: "That character could not be found." };
	}
	if (!isCaster(player.class)) {
		return { ok: false, reason: `A ${player.class || "character"} of that kind cannot cast spells.` };
	}

	const key = normalise(spellName);
	if (!key) return { ok: false, reason: "No spell was named." };

	const entry = CATALOGUE.find((s) => normalise(s.name) === key);
	if (!entry) return { ok: false, reason: "There is no such spell." };

	if (!onClassList(entry, normalise(player.class))) {
		return { ok: false, reason: `${entry.name} is not on the ${player.class} class spell list.` };
	}

	const ceiling = maxSpellLevel(player.level);
	if (Number(entry.level) > ceiling) {
		return { ok: false, reason: `${entry.name} is a level ${entry.level} spell; you can reach level ${ceiling}.` };
	}

	if (knownSpells(player).some((s) => normalise(s.name) === key)) {
		return { ok: false, reason: `You already know ${entry.name}.` };
	}

	return { ok: true, spell: structuredClone(entry) };
}

/**
 * @description Finds which of a set of spells the player's text names.
 *
 *   Matched on word boundaries over the normalised text, not as a substring: "I delight
 *   in the chaos" must not cast Light. The longest name wins, so a bare "Touch" cannot
 *   beat "Chill Touch" — the same precedence `chooseTarget` uses for enemy names.
 * @param {*} text - The action text.
 * @param {object[]} spells - Spells the character knows.
 * @returns {object|null} The named spell, or null.
 */
export function findSpellIn(text, spells) {
	if (typeof text !== "string" || !Array.isArray(spells)) return null;

	const flat = normalise(text);
	if (!flat) return null;

	const candidates = spells
		.filter((s) => s && typeof s.name === "string" && s.name.trim())
		.sort((a, b) => b.name.length - a.name.length);

	for (const spell of candidates) {
		const key = normalise(spell.name);
		if (!key) continue;
		if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(flat)) return spell;
	}
	return null;
}

/**
 * @description Whether casting this spell spends one of the shared ability activations.
 *
 *   Only a cantrip — a spell that states level 0 — is free. Anything unreadable costs a
 *   slot, because the dangerous default is the other one: it would turn every malformed
 *   entry into an at-will spell.
 * @param {object} spell - A spell.
 * @returns {boolean} True when it costs a slot.
 */
export function costsSlot(spell) {
	if (!spell || typeof spell !== "object") return true;
	const level = Number(spell.level);
	if (!Number.isFinite(level)) return true;
	return level !== 0;
}
