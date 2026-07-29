/**
 * spellAttacks — what a cast spell actually does, before the DM writes.
 *
 * @description Magic was the last part of a turn the narrator decided alone. A spell
 *   reached `autoRollIfNeeded`, which rolled a d20 plus one ability modifier — `int`,
 *   whatever the class — and graded it on a flat ladder: 15 or better succeeds. The
 *   target's armour class decided nothing, so Fire Bolt was exactly as hard to land on a
 *   goblin at AC 15 as on a dragon at AC 19, and the damage was whatever the prose felt
 *   like. This is the argument of ADR 0018 applied to the other half of what a character
 *   can do; see ADR 0021 for where the spells themselves came from.
 *
 *   Mirrors `playerAttacks.js` on purpose, down to the injected dice, so a weapon swing
 *   and a spell are resolved by the same kind of code and can be read against each other.
 *
 *   Only one d20 is rolled per spell — the caster's attack, *or* the target's saving
 *   throw, never both — so a single injected `rollD20` is unambiguous.
 */

import { d20, mod, rollExpression } from "../helpers/dice.js";
import { difficultyModifiers } from "../../client/difficulty.js";
import { castingAbility } from "./spellbook.js";
import { proficiencyBonus } from "./playerAttacks.js";
import { crValue } from "./enemyTurns.js";

/** Armour class assumed for a creature the model described without one. */
const DEFAULT_ENEMY_AC = 12;

/** Damage a hit deals when the expression is unreadable — never nothing. */
const FALLBACK_DAMAGE = "1d4";

/**
 * A creature's bonus to a saving throw, by challenge rating.
 *
 * @description Deliberately coarse, and deliberately the same shape as
 *   `PROFICIENCY_BY_CR` in `enemyTurns.js`: the model invents these creatures and rarely
 *   gives them the six ability scores a real saving throw would need, so grading on the
 *   one number it does reliably supply beats inventing five it does not.
 */
const SAVE_BONUS_BY_CR = [
	{ upTo: 0.5, bonus: 0 },
	{ upTo: 4, bonus: 2 },
	{ upTo: 8, bonus: 3 },
	{ upTo: 12, bonus: 4 },
	{ upTo: Infinity, bonus: 5 },
];

/**
 * @description Picks the row covering a challenge rating.
 * @param {object[]} table - A table of `{upTo, bonus}` rows.
 * @param {number} cr - The numeric rating.
 * @returns {object} The matching row.
 */
function byCR(table, cr) {
	return table.find((row) => cr <= row.upTo) ?? table[table.length - 1];
}

/**
 * @description The caster's modifier in their own casting ability.
 * @param {object} caster - The character sheet.
 * @returns {number|null} The modifier, or null when the class does not cast.
 */
function castingMod(caster) {
	const ability = castingAbility(caster?.class);
	if (!ability) return null;
	return mod(Number(caster?.stats?.[ability]) || 10);
}

/**
 * The DC a target must beat to resist this caster's spells.
 *
 * @description `8 + proficiency + casting modifier`, as 5e has it. Null for a
 *   non-caster rather than a number: a Fighter has no spell save DC, and reporting one
 *   would be the same fiction as the `int` that used to be hardcoded for every class.
 * @param {object} caster - The character sheet.
 * @returns {number|null} The save DC, or null when the class does not cast.
 */
export function spellSaveDC(caster) {
	const ability = castingMod(caster);
	if (ability === null) return null;
	return 8 + proficiencyBonus(caster?.level) + ability;
}

/**
 * What the caster adds to a spell attack roll.
 *
 * @description Proficiency plus the casting modifier, plus the difficulty dial's effect
 *   on the party's own dice — the one place it touches them. A caster left out of that
 *   would find Casual no gentler for magic than Standard, which is the inconsistency
 *   `resolveAttack` already avoids for weapons.
 * @param {object} caster - The character sheet.
 * @param {string} [difficulty] - The lobby's difficulty.
 * @returns {number} The bonus. Zero-based for a non-caster, who should not be here.
 */
export function spellAttackBonus(caster, difficulty) {
	const ability = castingMod(caster) ?? 0;
	return ability + proficiencyBonus(caster?.level) + difficultyModifiers(difficulty).playerAttackBonus;
}

/**
 * @description Rolls a damage expression, twice over on a critical hit. An expression
 *   the roller cannot read falls back rather than dealing nothing — the catalogue is
 *   validated at boot, but a spell the DM granted mid-game is not.
 * @param {string} expression - A dice expression.
 * @param {boolean} critical - Whether to roll it twice.
 * @param {Function} rollDice - Injected roller.
 * @returns {number} The total, at least 1.
 */
function rollDamage(expression, critical, rollDice) {
	const usable = rollExpression(expression) ? expression : FALLBACK_DAMAGE;
	const once = rollDice(usable);
	return Math.max(1, critical ? once + rollDice(usable) : once);
}

/**
 * Resolves one cast spell.
 *
 * @description Attack spells roll against the target's real armour class. Save spells
 *   have the *target* roll against the caster's DC — so a natural 20 there is the
 *   target's win, not a critical hit, and `critical` stays false. `auto` simply lands.
 *   `utility` returns null, because there is no right answer for the server to compute
 *   and the narrator legitimately owns it.
 * @param {object} params - Inputs.
 * @param {object} params.caster - The character sheet casting.
 * @param {object} params.spell - A catalogue entry.
 * @param {object} [params.target] - The roster entry being cast at.
 * @param {string} [params.difficulty] - The lobby's difficulty.
 * @param {function(): number} [params.rollD20] - Injected d20.
 * @param {function(string): number} [params.rollDamage] - Injected damage roller.
 * @returns {object|null} The resolved spell, or null when there is nothing to resolve.
 */
export function resolveSpell({ caster, spell, target, difficulty, rollD20 = d20, rollDamage: rollDice } = {}) {
	if (!caster || !spell) return null;

	const roll = rollDice ?? ((expression) => rollExpression(expression)?.total ?? 1);
	const resolution = spell.resolution;

	if (resolution === "utility" || !resolution) return null;

	const common = {
		caster: caster.name,
		spellName: spell.name,
		resolution,
		level: Number(spell.level) || 0,
		damageType: spell.damageType || null,
	};

	if (resolution === "heal") {
		const healed = Math.max(1, roll(spell.healing) + (spell.addCastingMod ? (castingMod(caster) ?? 0) : 0));
		return { ...common, targetName: target?.name ?? null, hit: true, critical: false, damage: 0, healed };
	}

	// Everything below needs something to be cast at.
	if (!target) return null;

	const targetName = target.name;
	const ac = Number(target.ac) > 0 ? Number(target.ac) : DEFAULT_ENEMY_AC;

	if (resolution === "save") {
		const dc = spellSaveDC(caster) ?? 10;
		const saveBonus = byCR(SAVE_BONUS_BY_CR, crValue(target.cr)).bonus;
		const base = rollD20();
		const saveTotal = base + saveBonus;
		const saved = saveTotal >= dc;

		const full = rollDamage(spell.damage, false, roll);
		// Half only where the spell says so; "none" means a successful save takes
		// nothing. Rounded down, as 5e rounds.
		const damage = saved ? (spell.onSave === "half" ? Math.floor(full / 2) : 0) : full;

		return {
			...common, targetName, dc, saveAbility: spell.save || null,
			saveRoll: base, saveBonus, saveTotal, saved,
			hit: !saved, critical: false, damage, healed: 0,
		};
	}

	if (resolution === "auto") {
		return {
			...common, targetName, ac, hit: true, critical: false,
			damage: rollDamage(spell.damage, false, roll), healed: 0,
		};
	}

	// An attack roll.
	const bonus = spellAttackBonus(caster, difficulty);
	const base = rollD20();
	const total = base + bonus;
	const critical = base === 20;
	const hit = critical || (base !== 1 && total >= ac);

	return {
		...common, targetName, base, bonus, total, ac, hit, critical,
		// No ability modifier on the damage: a cantrip deals its dice alone, and adding
		// it would scale a caster's damage twice with one stat.
		damage: hit ? rollDamage(spell.damage, critical, roll) : 0,
		healed: 0,
	};
}

/**
 * @description Renders the damage and its type as one phrase, so a spell with no stated
 *   type does not leave a doubled space mid-sentence. The DM writes prose from this
 *   block; text that does not read as English produces narration that does not either.
 * @param {object} cast - A resolved spell.
 * @returns {string} For example `"7 fire damage"`, or `"7 damage"`.
 */
function damagePhrase(cast) {
	return cast.damageType ? `${cast.damage} ${cast.damageType} damage` : `${cast.damage} damage`;
}

/**
 * Renders a resolved spell as a fact for the DM to narrate.
 *
 * @description States the numbers explicitly, for the same reason `describeAttack` does:
 *   the model describes the spell that was actually cast rather than inventing a
 *   different one. The miss and the successful save are spelled out just as firmly,
 *   because a narrator left to itself does not let players fail.
 * @param {object|null} cast - The result of `resolveSpell`.
 * @param {object} [target] - The roster entry after damage was applied, for its state.
 * @returns {string} The block, or "" when there was nothing to narrate.
 */
export function describeSpell(cast, target) {
	if (!cast) return "";

	const lines = [
		"YOUR SPELL, ALREADY RESOLVED (the server rolled this and has applied it — narrate exactly it):",
	];

	if (cast.resolution === "heal") {
		lines.push(`- ${cast.caster} casts ${cast.spellName}: restores ${cast.healed} hit points.`);
	} else if (cast.resolution === "save") {
		const verb = cast.saved ? "SAVES" : "FAILS the save";
		const ability = cast.saveAbility ? `${String(cast.saveAbility).toUpperCase()} saving throw` : "saving throw";
		lines.push(
			`- ${cast.caster} casts ${cast.spellName} at ${cast.targetName}: DC ${cast.dc} ${ability} —`
				+ ` ${cast.targetName} rolled ${cast.saveTotal} and ${verb}, taking`
				+ ` ${damagePhrase(cast)}.`,
		);
		if (cast.saved && cast.damage === 0) {
			lines.push(
				`  The save was made and this spell allows no damage on a success. Narrate it resisted`,
				`  entirely — do not award partial damage or a glancing effect.`,
			);
		}
	} else if (!cast.hit) {
		lines.push(
			`- ${cast.caster} casts ${cast.spellName} at ${cast.targetName}: rolled ${cast.total} against`
				+ ` AC ${cast.ac} — MISSES.`,
			`  Narrate the miss. Do not let it connect, and do not award a graze, a stagger or any other`,
			`  partial success. A spell that misses is what makes the next one matter.`,
		);
	} else if (cast.resolution === "auto") {
		// No attack roll to report, and no "HITS" either — this spell does not miss, so
		// the sentence has one verb. It read "…strikes unerringly HITS for 10 force
		// damage" when the attack phrasing was reused here.
		lines.push(
			`- ${cast.caster} casts ${cast.spellName} at ${cast.targetName}: it strikes unerringly for`
				+ ` ${damagePhrase(cast)}. It cannot miss and cannot be dodged.`,
		);
	} else {
		const crit = cast.critical ? " CRITICAL HIT —" : "";
		lines.push(
			`- ${cast.caster} casts ${cast.spellName} at ${cast.targetName}: rolled ${cast.total} against`
				+ ` AC ${cast.ac} —${crit} HITS for ${damagePhrase(cast)}.`,
		);
	}

	const hp = Number(target?.hp);
	if (Number.isFinite(hp) && cast.resolution !== "heal") {
		lines.push(hp > 0
			? `  ${cast.targetName} is still standing on ${hp} hit point${hp === 1 ? "" : "s"}.`
			: `  ${cast.targetName} drops to 0 hit points and DIES. Narrate the kill.`);
	}

	lines.push(
		`Do NOT change these numbers, and do NOT include an "enemies" entry adjusting this target's`,
		`hit points — the server has already done it, and a second copy would wound them twice.`,
	);

	return lines.join("\n");
}
