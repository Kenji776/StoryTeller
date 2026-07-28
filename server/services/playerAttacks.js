/**
 * playerAttacks — resolves what a player's blow actually does, before the DM writes.
 *
 * @description The enemies' half of a fight has been rolled server-side since
 *   `enemyTurns.js`; the players' half never was. `autoRollIfNeeded` rolled a d20 plus
 *   one ability modifier and graded it on a flat ladder — 15 or better succeeds — so
 *   the armour class stored on every enemy and shown to the model decided nothing at
 *   all. A goblin at AC 15 and an adult dragon at AC 19 were exactly as hard to hit.
 *
 *   Damage was never rolled. The model picked a number, and `updateEnemies` wrote it
 *   into the roster verbatim. That is why a `+3` weapon meant nothing, why the loot
 *   engine's bonuses were decorative, and why a character's weapon was a line of
 *   prompt text rather than a statistic.
 *
 *   This mirrors `resolveEnemyAttacks` on purpose, down to the injected dice, so the
 *   two halves of a fight are resolved by the same kind of code and can be read
 *   against each other.
 */

import { d20, mod, rollExpression } from "../helpers/dice.js";

/** What you hit with when you are holding nothing. */
const UNARMED = { name: "Unarmed Strike", damage: "1d4", damageType: "bludgeoning", range: "melee" };

/** Weapons a character may swing with either strength or dexterity. */
const FINESSE = /\b(dagger|rapier|scimitar|shortsword|whip|dart|sickle)\b/i;

/** How the roster spells a status that cannot be attacked. */
const GONE = new Set(["dead", "fled"]);

/** Armour class assumed for a creature the model described without one. */
const DEFAULT_ENEMY_AC = 12;

/**
 * Actions that are an attack and so call for an attack roll.
 *
 * @description "fire" is deliberately not matched on its own: a player lighting a
 *   campfire or casting a fire bolt is not making a bow attack. It counts only when
 *   followed by something one actually fires, or by "at".
 *
 *   Lives here rather than in `lobbyCombat.js`, where it started, so the question
 *   "is this an attack?" has one answer shared by the roll path and the resolver.
 */
const ATTACK_ACTION = new RegExp([
	String.raw`\b(?:attacks?|strikes?|shoots?|swings?|stabs?|slashes|lunges?|hacks?)\b`,
	String.raw`\bfires?\s+(?:at\b|(?:an?\s+|my\s+|the\s+)?(?:arrow|bolt|shot|round|bow|crossbow)\b)`,
	String.raw`\blooses?\s+(?:an?\s+)?(?:arrow|bolt)\b`,
].join("|"), "i");

/**
 * @description Whether the player is swinging at something.
 * @param {*} action - The action text.
 * @returns {boolean} True when this is an attack.
 */
export function isAttackAction(action) {
	return typeof action === "string" && ATTACK_ACTION.test(action);
}

/**
 * The 5e proficiency progression.
 *
 * @description Enemies have had a challenge-rating equivalent of this since
 *   `enemyTurns.js` landed. Players had none, so the party's chance to hit stayed flat
 *   while its opposition's climbed — the wrong way round for a game about getting
 *   stronger.
 * @param {*} level - The character's level.
 * @returns {number} A bonus between 2 and 6.
 */
export function proficiencyBonus(level) {
	const n = Math.floor(Number(level));
	const safe = Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 1;
	return 2 + Math.floor((safe - 1) / 4);
}

/**
 * @description Whether a creature is still a legal target.
 * @param {object} enemy - A roster entry.
 * @returns {boolean} True when it can be attacked.
 */
function isFighting(enemy) {
	return Boolean(enemy) && !GONE.has(String(enemy.status || "").toLowerCase()) && (Number(enemy.hp) || 0) > 0;
}

/**
 * Picks which enemy a player is swinging at.
 *
 * @description Named enemies win. Failing that the most wounded one does — finishing
 *   what the party started is what a table would do, and it beats picking at random
 *   when the player wrote "I attack!".
 * @param {string} action - The player's action text.
 * @param {object} enemies - The lobby's enemy roster.
 * @returns {object|null} The target, or null when there is nobody to hit.
 */
export function chooseTarget(action, enemies) {
	const text = typeof action === "string" ? action.toLowerCase() : "";
	const live = Object.values(enemies ?? {}).filter(isFighting);
	if (!text || !live.length) return null;

	// Longest name first, so "Goblin 1" is preferred over a bare "Goblin" when both
	// would match.
	const byName = [...live].sort((a, b) => String(b.name).length - String(a.name).length);
	const named = byName.find((e) => text.includes(String(e.name).toLowerCase()));
	if (named) return named;

	// "I attack the goblin" — the species without the number the roster gave it.
	const bySpecies = byName.find((e) => {
		const species = String(e.name).replace(/\s*\d+$/, "").toLowerCase();
		return species && text.includes(species);
	});
	if (bySpecies) return bySpecies;

	return live.reduce((worst, e) => ((Number(e.hp) || 0) < (Number(worst.hp) || 0) ? e : worst), live[0]);
}

/**
 * @description Which ability a character swings with. Ranged is always dexterity; a
 *   finesse weapon uses whichever the character is better at.
 * @param {object} attacker - The character sheet.
 * @param {object} weapon - The weapon in hand.
 * @returns {"str"|"dex"} The ability key.
 */
function attackAbility(attacker, weapon) {
	const range = String(weapon.range || "melee").toLowerCase();
	if (range.includes("ranged")) return "dex";

	const strMod = mod(Number(attacker?.stats?.str) || 10);
	const dexMod = mod(Number(attacker?.stats?.dex) || 10);
	if (FINESSE.test(String(weapon.name || ""))) return dexMod > strMod ? "dex" : "str";

	return "str";
}

/**
 * @description Rolls a damage expression, twice over on a critical hit. Only the dice
 *   double — the ability modifier is added once, as 5e has it.
 * @param {string} expression - A dice expression such as "1d6".
 * @param {boolean} critical - Whether the blow was a critical hit.
 * @param {Function} rollDice - Injected roller taking the expression.
 * @returns {number} The dice total.
 */
function rollDamageDice(expression, critical, rollDice) {
	const once = rollDice(expression);
	if (!critical) return once;
	return once + rollDice(expression);
}

/**
 * @description Works out what a landed blow takes off. Split out of `resolveAttack`,
 *   which was carrying the roll, the hit determination and this at once.
 * @param {object} params - Inputs.
 * @param {object} params.weapon - The weapon in hand.
 * @param {boolean} params.critical - Whether the blow was a critical hit.
 * @param {number} params.abilityMod - The attacker's ability modifier.
 * @param {number} params.enchantment - The weapon's `+N`.
 * @param {Function} params.rollDice - Injected roller taking a dice expression.
 * @returns {{damage: number, bonusDamage: number}} What the blow deals.
 */
function computeDamage({ weapon, critical, abilityMod, enchantment, rollDice }) {
	// An invented expression like "1d6+1" is not something the roller accepts, and a
	// weapon that deals nothing would be worse than a fist.
	const expression = /^\s*\d*d\d+\s*$/.test(String(weapon.damage || "")) ? weapon.damage : UNARMED.damage;

	const bonusDamage = weapon.bonus_damage ? rollDamageDice(weapon.bonus_damage, critical, rollDice) : 0;
	const weaponDamage = Math.max(1, rollDamageDice(expression, critical, rollDice) + abilityMod + enchantment);

	return { damage: weaponDamage + bonusDamage, bonusDamage };
}

/**
 * Resolves one attack.
 *
 * @param {object} params - Inputs.
 * @param {object} params.attacker - The character sheet swinging.
 * @param {object} params.target - The roster entry being swung at.
 * @param {function(): number} [params.rollD20] - Injected d20.
 * @param {function(string): number} [params.rollDamage] - Injected damage roller,
 *   taking a dice expression.
 * @returns {object|null} The resolved attack, or null when there is nothing to resolve.
 */
export function resolveAttack({ attacker, target, rollD20 = d20, rollDamage } = {}) {
	if (!attacker || !target) return null;

	const rollDice = rollDamage ?? ((expression) => rollExpression(expression)?.total ?? 1);

	const weapon = attacker.weapon?.name ? attacker.weapon : UNARMED;
	const ability = attackAbility(attacker, weapon);
	const abilityMod = mod(Number(attacker?.stats?.[ability]) || 10);
	const enchantment = Number(weapon.bonus) || 0;

	const bonus = abilityMod + proficiencyBonus(attacker.level) + enchantment;
	const base = rollD20();
	const total = base + bonus;

	const ac = Number(target.ac) > 0 ? Number(target.ac) : DEFAULT_ENEMY_AC;

	// A natural 20 always lands and a natural 1 always fails, as on the enemies' side.
	const critical = base === 20;
	const hit = critical || (base !== 1 && total >= ac);

	const { damage, bonusDamage } = hit
		? computeDamage({ weapon, critical, abilityMod, enchantment, rollDice })
		: { damage: 0, bonusDamage: 0 };

	return {
		attacker: attacker.name,
		targetName: target.name,
		weaponName: weapon.name,
		ability,
		base,
		bonus,
		total,
		ac,
		hit,
		critical,
		damage,
		damageType: weapon.damageType || weapon.damage_type || "bludgeoning",
		bonusDamage,
		bonusDamageType: weapon.bonus_damage_type || null,
	};
}

/**
 * Renders a resolved attack as a fact for the DM to narrate.
 *
 * @description States the numbers explicitly, for the same reason `describeAttacks`
 *   does on the enemies' side: the model describes the blow that was actually struck
 *   rather than inventing a different one. The miss case is spelled out just as
 *   firmly, because a narrator left to its own devices does not let players miss.
 * @param {object|null} attack - The result of `resolveAttack`.
 * @param {object} [target] - The roster entry after damage was applied, for its state.
 * @returns {string} The block, or "" when there was no attack.
 */
export function describeAttack(attack, target) {
	if (!attack) return "";

	const lines = [
		"YOUR ATTACK, ALREADY RESOLVED (the server rolled this and has applied it — narrate exactly it):",
	];

	if (!attack.hit) {
		lines.push(
			`- ${attack.attacker} attacks ${attack.targetName} with ${attack.weaponName}: rolled ${attack.total} against AC ${attack.ac} — MISSES.`,
			`  Narrate the miss. Do not let it connect, and do not award a graze, a stagger or any other`,
			`  partial success. A blow that misses is what makes the next one matter.`
		);
	} else {
		const crit = attack.critical ? " CRITICAL HIT —" : "";
		const extra = attack.bonusDamage
			? ` (including ${attack.bonusDamage} ${attack.bonusDamageType || "extra"})`
			: "";
		lines.push(
			`- ${attack.attacker} attacks ${attack.targetName} with ${attack.weaponName}: rolled ${attack.total} against`
				+ ` AC ${attack.ac} —${crit} HITS for ${attack.damage} ${attack.damageType} damage${extra}.`
		);

		const hp = Number(target?.hp);
		if (Number.isFinite(hp)) {
			lines.push(hp > 0
				? `  ${attack.targetName} is still standing on ${hp} hit points.`
				: `  ${attack.targetName} drops to 0 hit points and DIES. Narrate the kill.`);
		}
	}

	lines.push(
		`Do NOT change these numbers, and do NOT include an "enemies" entry adjusting this target's`,
		`hit points — the server has already done it, and a second copy would wound them twice.`
	);

	return lines.join("\n");
}
