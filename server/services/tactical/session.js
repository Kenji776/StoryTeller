/**
 * A lobby's map: when it exists, who is on it, and what it will and will not allow.
 *
 * @description Phase 4 of the tactical map ([ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)),
 *   and the first part of the feature that touches lobby state. Everything the
 *   `tacticalCombat` setting gates lives behind this one door, so the pipeline gets a single
 *   conditional rather than a dozen.
 *
 *   **With the setting off, nothing here writes a field.** Not a map that is generated and
 *   ignored — no map, no key, nothing. That is the whole safety argument for shipping this on a
 *   branch beside a game people are already playing, and it is the first thing the tests check.
 *
 *   The two mechanical promises of the phase are `applyMove` and `reachCheck`. Both refuse
 *   rather than approximate: an over-long move is rejected instead of clamped, because clamping
 *   leaves a character standing where nobody chose, and a target across the room is out of reach
 *   as a settled fact rather than something the narrator waves through.
 */

import { generateArena } from "./arena.js";
import { seedFrom } from "./random.js";
import { cellLabel, parseCellLabel, distanceFeet, inBounds, blocksMovement, tokenAt, isCell } from "./grid.js";
import { canReach, pathTo, walkableRegion } from "./movement.js";
import { hasLineOfSight, coverBetween, coverACBonus } from "./sight.js";

/** The lobby field that turns the whole feature on. */
export const TACTICAL_SETTING = "tacticalCombat";

/**
 * Range words translated into distance.
 *
 * @description `spells.json` describes range in words — `touch`, `ranged`, `self` — because until
 *   now nothing measured anything. This is where those words become feet, and it is deliberately
 *   the only such place. A spell that eventually needs its own number should gain a numeric field
 *   rather than a new word here.
 */
export const RANGE_FEET = { self: 0, touch: 5, melee: 5, ranged: 60 };

/** Races that walk twenty-five feet rather than thirty. */
const SHORT_LEGGED = new Set(["dwarf", "halfling", "gnome"]);

/** Reach for a creature that does not say otherwise. */
const DEFAULT_REACH_FEET = 5;
const DEFAULT_SPEED_FEET = 30;
const SHORT_SPEED_FEET = 25;

/**
 * @description Reports whether a lobby has asked for tactical combat.
 * @param {object} lobby - The lobby record.
 * @returns {boolean} True only for a literal `true`. Settings arrive from a browser, where "off"
 *   is a string and every string is truthy — so anything less strict would switch the feature on
 *   for a lobby that asked to switch it off.
 */
export function isTactical(lobby) {
	return lobby?.[TACTICAL_SETTING] === true;
}

/**
 * @description How far a character walks, from their race.
 * @param {object} character - A player record.
 * @returns {number} Feet per turn. An unstated or invented race walks at the ordinary pace:
 *   races are free text and the narrator makes them up, so guessing slow would be a stealth nerf
 *   applied to whatever it had not heard of.
 */
export function speedFeetFor(character) {
	const race = typeof character?.race === "string" ? character.race.trim().toLowerCase() : "";
	return SHORT_LEGGED.has(race) ? SHORT_SPEED_FEET : DEFAULT_SPEED_FEET;
}

/**
 * @description Lists the characters who belong on a map.
 * @param {object} lobby - The lobby record.
 * @returns {Array<object>} Creature descriptors for `generateArena`.
 */
function livingParty(lobby) {
	return Object.values(lobby?.players ?? {})
		.filter((player) => player?.name && !player.dead)
		.map((player) => ({ name: player.name, speedFeet: speedFeetFor(player), reachFeet: DEFAULT_REACH_FEET }));
}

/**
 * @description Lists the enemies who belong on a map.
 * @param {object} lobby - The lobby record.
 * @returns {Array<object>} Creature descriptors for `generateArena`.
 */
function livingEnemies(lobby) {
	return Object.values(lobby?.enemies ?? {})
		.filter((enemy) => enemy?.name && enemy.status !== "dead" && enemy.status !== "fled" && (Number(enemy.hp) || 0) > 0)
		.map((enemy) => ({ name: enemy.name, speedFeet: DEFAULT_SPEED_FEET, reachFeet: DEFAULT_REACH_FEET }));
}

/**
 * Makes sure the lobby has an arena, generating one if a fight has started.
 *
 * @description Called on every action, so it has to be idempotent: rebuilding the room each turn
 *   would teleport everybody standing in it.
 *
 *   The seed comes from the lobby id and the names of the opposition, which gives two properties
 *   worth having without storing a counter. A reload lays out the same room, and a *new* encounter
 *   — different enemies — lays out a different one.
 * @param {object} lobby - The lobby record; mutated on success.
 * @returns {object|null} The map, or `null` when the feature is off or there is no fight yet.
 */
export function ensureArena(lobby) {
	if (!isTactical(lobby)) return null;
	if (lobby.map) return lobby.map;

	const party = livingParty(lobby);
	const enemies = livingEnemies(lobby);
	if (!party.length || !enemies.length) return null;

	const seed = seedFrom(`${lobby.lobbyId}|${enemies.map((e) => e.name).sort().join(",")}`);
	const map = generateArena({ party, enemies, seed, archetype: lobby.mapArchetype });
	if (!map) return null;

	lobby.map = map;
	return map;
}

/**
 * @description Finds somewhere for a creature who has arrived after the room was laid out.
 * @param {object} map - The map.
 * @param {Array<number[]>} avoid - Cells to stay clear of, by at least two.
 * @returns {number[]|null} A cell, or `null` when the room is full.
 */
function arrivalCell(map, avoid) {
	const anchor = Object.values(map.tokens)[0]?.cell;
	const region = anchor ? walkableRegion(map, anchor) : null;

	let best = null;
	let bestGap = -1;
	for (let x = 0; x < map.width; x++) {
		for (let y = 0; y < map.height; y++) {
			const cell = [x, y];
			if (blocksMovement(map, cell) || tokenAt(map, cell)) continue;
			// Reachable from the fight, or the newcomer is walled off from it.
			if (region && !region.has(cellLabel(cell))) continue;
			const gap = Math.min(...avoid.map((other) => distanceFeet(map, cell, other)));
			// Furthest from everybody already here, which keeps a reinforcement out of melee.
			if (gap > bestGap) { bestGap = gap; best = cell; }
		}
	}
	return best;
}

/**
 * Reconciles the map's tokens with who is actually alive.
 *
 * @description Safe to call every turn, because it never moves anybody who is already standing
 *   somewhere — the narrator adds and kills enemies mid-fight, and a sync that repositioned the
 *   survivors would undo the tactics that had been played.
 * @param {object} lobby - The lobby record; mutated.
 * @returns {void}
 */
export function syncTokens(lobby) {
	if (!isTactical(lobby) || !lobby.map) return;
	const map = lobby.map;

	const belongs = new Map();
	for (const creature of livingParty(lobby)) belongs.set(creature.name, { ...creature, faction: "party" });
	for (const creature of livingEnemies(lobby)) belongs.set(creature.name, { ...creature, faction: "enemy" });

	for (const name of Object.keys(map.tokens)) {
		if (!belongs.has(name)) delete map.tokens[name];
	}

	for (const [name, creature] of belongs) {
		if (map.tokens[name]) continue;
		const cell = arrivalCell(map, Object.values(map.tokens).map((token) => token.cell));
		if (!cell) continue;
		map.tokens[name] = { ...creature, cell, size: 1 };
	}
}

/**
 * @description Removes the arena, because a map only exists while there is a fight on it.
 * @param {object} lobby - The lobby record; mutated.
 * @returns {void}
 */
export function clearArena(lobby) {
	if (!isTactical(lobby)) return;
	delete lobby.map;
}

/**
 * Moves a token, or explains why not.
 *
 * @description Refuses rather than clamps. A move trimmed to fit the budget puts a character
 *   somewhere nobody chose, and the reason a player is given for a refusal is the only way they
 *   learn what the rules are.
 * @param {object} lobby - The lobby record; mutated on success.
 * @param {string} tokenName - Who is moving.
 * @param {number[]|string} destination - A cell or a label; a click sends one and a sentence the
 *   other.
 * @returns {{ok: boolean, cell?: number[], costFeet?: number, reason?: string}} What happened.
 */
export function applyMove(lobby, tokenName, destination) {
	if (!isTactical(lobby) || !lobby.map) return { ok: false, reason: "There is no battle map." };
	const map = lobby.map;
	if (!map.tokens?.[tokenName]) return { ok: false, reason: `${tokenName} is not on the map.` };

	const target = typeof destination === "string" ? parseCellLabel(destination) : destination;
	if (!isCell(target) || !inBounds(map, target)) return { ok: false, reason: "That is not a square on this map." };

	if (!canReach(map, tokenName, target)) {
		const path = pathTo(map, tokenName, target, { budgetFeet: Infinity });
		const blocked = blocksMovement(map, target) || tokenAt(map, target);
		return {
			ok: false,
			reason: blocked
				? `${cellLabel(target)} is not somewhere you can stand.`
				: `${cellLabel(target)} is too far to reach this turn`
					+ (path ? ` — it would take ${path.costFeet} feet.` : "."),
		};
	}

	const path = pathTo(map, tokenName, target);
	map.tokens[tokenName].cell = [...target];
	return { ok: true, cell: [...target], costFeet: path?.costFeet ?? 0 };
}

/**
 * Whether one creature can act on another from where it stands.
 *
 * @description The phase's other promise: reach and line of sight become facts the resolver is
 *   handed rather than questions the narrator answers. Cover comes back as a number the attack
 *   roll can use directly.
 * @param {object} lobby - The lobby record.
 * @param {string} attackerName - Who is acting.
 * @param {string} targetName - Who they are acting on.
 * @param {object} [options] - Options.
 * @param {string} [options.range] - A range word from the spell catalogue.
 * @param {number} [options.rangeFeet] - An explicit distance, which wins over the word.
 * @returns {{ok: boolean, distanceFeet?: number, cover?: string, acBonus?: number, reason?: string}}
 *   Whether it can be attempted, and what the resolver needs if so.
 */
export function reachCheck(lobby, attackerName, targetName, { range, rangeFeet } = {}) {
	if (!isTactical(lobby) || !lobby.map) return { ok: false, reason: "There is no battle map." };
	const map = lobby.map;
	const attacker = map.tokens?.[attackerName];
	const target = map.tokens?.[targetName];
	if (!attacker || !target) return { ok: false, reason: "One of them is not on the map." };

	// An unrecognised word falls back to reach rather than to something generous: a spell whose
	// range nobody has heard of must not quietly become a sniper rifle.
	const allowed = Number.isFinite(Number(rangeFeet))
		? Number(rangeFeet)
		: (RANGE_FEET[String(range ?? "").trim().toLowerCase()] ?? (Number(attacker.reachFeet) || DEFAULT_REACH_FEET));

	const gap = distanceFeet(map, attacker.cell, target.cell);
	if (gap > allowed) {
		return { ok: false, distanceFeet: gap, reason: `${targetName} is ${gap} feet away, beyond ${allowed} feet.` };
	}
	if (!hasLineOfSight(map, attacker.cell, target.cell)) {
		return { ok: false, distanceFeet: gap, reason: `There is no clear line of sight to ${targetName}.` };
	}

	const cover = coverBetween(map, attacker.cell, target.cell);
	if (cover === "full") {
		return { ok: false, distanceFeet: gap, cover, reason: `${targetName} is behind full cover.` };
	}
	return { ok: true, distanceFeet: gap, cover, acBonus: coverACBonus(cover) };
}
