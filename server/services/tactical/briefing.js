/**
 * The two briefings the map produces, for the two audiences that need opposite things.
 *
 * @description Part of phase 4 of the tactical map ([ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)).
 *
 *   **The narrator needs prose anchors.** It is writing a paragraph, and "Dorn at B3" is not
 *   narratable — so a position comes with something to name it by, and the block says plainly that
 *   the layout is settled and nobody is to be moved. That sentence is load-bearing: without it the
 *   narrator repositions creatures in prose and becomes a second source of truth about the one
 *   thing the map exists to own.
 *
 *   **A player agent needs a decision, not a puzzle.** Every line of its menu is an answer. It is
 *   never asked how far anything is, because a small model asked that question will produce a
 *   confident wrong number at the moment somebody is deciding whether they die. It is also offered
 *   destinations *by name*, which is what makes its reply extractable — it repeats a cell it was
 *   given rather than inventing one.
 *
 *   Both are strings a model reads, so they are behaviour, not presentation. Their grammar is
 *   asserted.
 */

import { isTactical, RANGE_FEET } from "./session.js";
import { cellLabel, distanceFeet, distanceCells } from "./grid.js";
import { reachableCells, movementBudgetFeet } from "./movement.js";
import { hasLineOfSight, coverBetween, coverACBonus } from "./sight.js";
// The vocabulary lives with the tactics that execute it, so the block cannot drift from what the
// server will actually accept.
import { INTENTS } from "./enemyTactics.js";

/** How many allies and enemies a menu will name before it stops, to keep the prompt affordable. */
const MENU_LIMIT = 4;

/** An ally at or below this fraction of their maximum is worth pointing out. */
const TROUBLE_FRACTION = 0.5;

/**
 * @description Splits a map's tokens by faction.
 * @param {object} map - The tactical map.
 * @returns {{party: Array<object>, foes: Array<object>}} Named tokens, each `{name, ...token}`.
 */
function sides(map) {
	const all = Object.entries(map.tokens ?? {}).map(([name, token]) => ({ name, ...token }));
	return {
		party: all.filter((token) => token.faction === "party"),
		foes: all.filter((token) => token.faction !== "party"),
	};
}

/**
 * @description Describes where a creature is standing in terms somebody could say out loud.
 * @param {object} map - The tactical map.
 * @param {object} token - The creature.
 * @param {Array<object>} threats - Whoever it might be taking cover from.
 * @returns {string} A short phrase: beside a landmark, behind cover, or in the open.
 */
function situation(map, token, threats) {
	const landmark = (map.landmarks ?? []).find((mark) =>
		mark.cells.some((cell) => distanceCells(map, cell, token.cell) <= 1));
	if (landmark) return `by ${landmark.name}`;

	// Line of sight is asked first and separately. `coverBetween` reports "full" both for genuine
	// full cover and for no line of sight — one answer, which is right for the resolver, since
	// neither yields a shot. It is wrong for prose: reading it directly had every creature on the
	// map described as "under cover" when most of them were merely out of each other's view, and
	// it made this block contradict the player's own menu about the same square.
	const visible = threats.filter((threat) => hasLineOfSight(map, threat.cell, token.cell));
	if (threats.length && !visible.length) return "out of sight of the enemy";

	// Only the exposed get a phrase. Having *some* cover is the ordinary condition in a room with
	// scenery in it — every long shot across a pillared hall crosses a pillar — so labelling it
	// put "under cover" on all six lines of a rendered block, where it distinguished nobody and
	// cost tokens. What a narrator can use is who is caught in the open.
	const sheltered = visible.some((threat) => coverBetween(map, threat.cell, token.cell) !== "none");
	return sheltered ? "" : "caught in the open";
}

/**
 * The narrator's view: where everybody is, as settled fact.
 *
 * @param {object} lobby - The lobby record.
 * @param {object} [options] - Options.
 * @param {Array<{name: string, from: number[], to: number[], costFeet: number}>} [options.moved] -
 *   Movement resolved this turn, so the prose can carry it.
 * @returns {string|null} The block, or `null` when the feature is off or there is no map — a block
 *   injected while the feature is off would change narration in every existing game, quietly.
 */
export function narratorBlock(lobby, { moved = [] } = {}) {
	if (!isTactical(lobby) || !lobby.map) return null;
	const map = lobby.map;
	const { party, foes } = sides(map);
	if (!party.length && !foes.length) return null;

	const lines = [];
	lines.push("BATTLEFIELD — these positions are settled fact. Describe them; do not move anyone.");
	lines.push(`The ${map.archetype}, ${map.width} by ${map.height} squares of ${map.feetPerCell} feet.`);

	for (const mark of map.landmarks ?? []) {
		// Landmark names carry their own article — "the altar" — so the sentence needs the capital
		// putting back or every one of these lines opens in lower case.
		const named = `${mark.name} is at ${mark.cells.map(cellLabel).join(", ")}.`;
		lines.push(named.charAt(0).toUpperCase() + named.slice(1));
	}

	for (const token of [...party, ...foes]) {
		const opposing = token.faction === "party" ? foes : party;
		const reach = opposing.filter((other) =>
			distanceFeet(map, token.cell, other.cell) <= (Number(token.reachFeet) || 5));

		// Assembled from parts rather than interpolated, so an omitted phrase leaves no orphan
		// comma behind — the sort of thing that reads as a bug in whatever prose comes out of it.
		const notes = [cellLabel(token.cell), situation(map, token, opposing)].filter(Boolean);
		if (reach.length) {
			notes.push(`within reach of ${reach.map((r) => r.name).join(" and ")}`);
		} else if (opposing.length) {
			// A distance to the nearest opponent, because a bare cell is not narratable and that
			// was the whole reason this block exists. It also varies per creature, which the
			// cover phrase stopped doing once cover became the ordinary condition.
			const nearest = opposing.reduce((closest, other) =>
				distanceFeet(map, token.cell, other.cell) < distanceFeet(map, token.cell, closest.cell) ? other : closest);
			notes.push(`${distanceFeet(map, token.cell, nearest.cell)} feet from ${nearest.name}`);
		}
		lines.push(`${token.name}: ${notes.join(", ")}.`);
	}

	for (const step of moved) {
		if (!step?.name) continue;
		lines.push(`${step.name} moved ${cellLabel(step.from)} to ${cellLabel(step.to)}, ${step.costFeet} feet.`);
	}

	return lines.join("\n");
}

/**
 * @description Finds the cheapest reachable cell that puts a target within reach.
 * @param {object} map - The tactical map.
 * @param {string} name - Who is moving.
 * @param {Map} reachable - Output of `reachableCells`.
 * @param {object} target - The creature to get to.
 * @param {number} reachFeet - How far the mover can strike.
 * @returns {{label: string, costFeet: number}|null} The cell to move to, or `null` if none does.
 */
function approach(map, name, reachable, target, reachFeet) {
	let best = null;
	for (const [label, entry] of reachable) {
		if (distanceFeet(map, entry.cell, target.cell) > reachFeet) continue;
		if (!best || entry.costFeet < best.costFeet) best = { label, costFeet: entry.costFeet };
	}
	return best;
}

/**
 * A player's view: their options, with the geometry already resolved.
 *
 * @param {object} lobby - The lobby record.
 * @param {string} playerName - Whose turn it is.
 * @returns {string|null} The menu, or `null` when the feature is off, there is no map, or that
 *   character is not on it.
 */
export function moveMenu(lobby, playerName) {
	if (!isTactical(lobby) || !lobby.map) return null;
	const map = lobby.map;
	const me = map.tokens?.[playerName];
	if (!me) return null;

	const { party, foes } = sides(map);
	const reachFeet = Number(me.reachFeet) || 5;
	const budgetFeet = movementBudgetFeet(map, playerName);
	const reachable = reachableCells(map, playerName);
	const lines = [];

	// Where you are, and whether it is worth staying. Only enemies who can actually see you are
	// consulted: asking `coverBetween` about the rest reported "full", which then read as
	// "no cover" once it failed the finite check — the opposite of the truth, twice over.
	const watchers = foes.filter((foe) => hasLineOfSight(map, foe.cell, me.cell));
	const worst = watchers.length
		? watchers.map((foe) => coverBetween(map, foe.cell, me.cell))
			.reduce((a, b) => (coverACBonus(a) <= coverACBonus(b) ? a : b))
		: null;
	const coverNote = !foes.length ? "nothing watching you"
		: !watchers.length ? "out of sight of every enemy"
			: worst === "none" ? "no cover"
				: `${worst} cover against anything ranged, worth ${coverACBonus(worst)} armour class`;
	lines.push(`You are at ${cellLabel(me.cell)} — ${coverNote}.`);
	lines.push(`Movement: ${budgetFeet} feet, ${Math.max(0, Math.round(budgetFeet / (map.feetPerCell || 5)))} squares.`);

	// Enemies, split by what it would take to act on them.
	const here = [];
	const afterMoving = [];
	const tooFar = [];
	const unseen = [];
	for (const foe of foes.slice(0, MENU_LIMIT)) {
		const gap = distanceFeet(map, me.cell, foe.cell);
		if (!hasLineOfSight(map, me.cell, foe.cell)) { unseen.push(`${foe.name} (${gap} feet)`); continue; }
		if (gap <= reachFeet) { here.push(`${foe.name} (${gap} feet)`); continue; }
		const step = approach(map, playerName, reachable, foe, reachFeet);
		// Those with no approach go on their own line. Repeating "too far to close this turn" once
		// per enemy filled the menu with a sentence that carried one fact between them.
		if (step) afterMoving.push(`${foe.name} — move to ${step.label}, ${step.costFeet} feet`);
		else tooFar.push(`${foe.name} (${gap} feet)`);
	}
	if (here.length) lines.push(`In reach now: ${here.join("; ")}.`);
	if (afterMoving.length) lines.push(`In reach if you move: ${afterMoving.join("; ")}.`);
	if (tooFar.length) lines.push(`Too far to close with this turn: ${tooFar.join("; ")}.`);

	const inRange = foes.filter((foe) =>
		hasLineOfSight(map, me.cell, foe.cell) && distanceFeet(map, me.cell, foe.cell) <= RANGE_FEET.ranged);
	if (inRange.length) lines.push(`In spell or bow range: ${inRange.map((f) => f.name).join(", ")}.`);
	if (unseen.length) lines.push(`You cannot see: ${unseen.join("; ")}.`);

	// Allies worth worrying about, which is what makes a party behave like one.
	const hurt = party
		.filter((ally) => ally.name !== playerName)
		.map((ally) => ({ ally, sheet: lobby.players?.[ally.name] }))
		.filter(({ sheet }) => sheet && Number(sheet.stats?.hp) <= Number(sheet.stats?.max_hp) * TROUBLE_FRACTION)
		.slice(0, MENU_LIMIT)
		.map(({ ally, sheet }) =>
			`${ally.name} on ${sheet.stats.hp} of ${sheet.stats.max_hp}, ${distanceFeet(map, me.cell, ally.cell)} feet away`);
	if (hurt.length) lines.push(`Hurt allies: ${hurt.join("; ")}.`);

	return lines.join("\n");
}

/**
 * Tells the narrator that an attempt was impossible, and that it did not happen.
 *
 * @description Found live, and it is precisely the failure the map exists to prevent. The server
 *   refused a swing at a creature 35 feet away, correctly — and then told the narrator nothing, so
 *   the narrator saw the intent, saw no resolution block beside it, and wrote *"the blade cleaves
 *   clean through"*. `syncTokens` then removed the creature the DM had just killed.
 *
 *   A refusal is a settled fact in exactly the way a hit is, and it has to be handed over in the
 *   same way. Saying only that the attempt failed is not enough: a model given that much will
 *   narrate a graze, which is how it granted the kill to begin with. The instruction has to forbid
 *   the outcome explicitly.
 * @param {string} actorName - Who tried.
 * @param {string} targetName - Who they tried it on.
 * @param {string} reason - The server's own explanation, as given to the player.
 * @returns {string} A block for the prompt. Safe with anything missing, because it is assembled on
 *   a path that has already gone wrong once.
 */
export function refusalBlock(actorName, targetName, reason) {
	const who = actorName || "The character";
	const whom = targetName || "their target";
	const because = String(reason || "").trim().replace(/\.+$/, "");
	const explained = because ? `: ${because}` : "";
	return `IMPOSSIBLE ACTION — settled fact. ${who} could not reach ${whom}${explained}. `
		+ `No attack was made and no damage was dealt. Describe the attempt failing for that reason. `
		+ `Do not describe a hit, a graze, or ${whom} being wounded or killed.`;
}

/**
 * Asks the narrator what each creature intends, and only that.
 *
 * @description The half of [ADR 0027](../../../docs/decisions/0027-enemies-are-given-intent-not-coordinates.md)
 *   that faces the model. Enemy movement is the first combat decision in this project that goes *to*
 *   the narrator rather than away from it, because it has no right answer — whether a ghoul lunges at
 *   the wounded cleric or holds the archway is characterisation, not arithmetic.
 *
 *   Three things this block has to do, and each is a lesson from somewhere else in the codebase:
 *
 *   - **Quote the whole verb set.** An unrecognised verb is discarded, and a model told merely to
 *     "choose an intent" invents them freely.
 *   - **Name the creatures**, so an order can be matched to one. Only the enemies: offering the
 *     characters would invite the narrator to play them.
 *   - **Forbid squares and distances outright.** This is the line that keeps the split intact. The
 *     model chooses *who*; the server works out *where*, and a model handed a grid asserts range it
 *     has not measured.
 *
 *   Orders stand until changed, so this rides the reply the narrator was already making — no second
 *   call, and no turn latency added to a fight.
 * @param {object} lobby - The lobby record.
 * @returns {string|null} The block, or `null` when the feature is off, there is no map, or there are
 *   no enemies left to command.
 */
export function intentRequest(lobby) {
	if (!isTactical(lobby) || !lobby.map) return null;
	const { foes } = sides(lobby.map);
	if (!foes.length) return null;

	return [
		"ENEMY ORDERS — you decide what each creature intends. The server decides whether it can.",
		`Verbs, and nothing else: ${INTENTS.join(", ")}.`,
		`Creatures awaiting orders: ${foes.map((foe) => foe.name).join(", ")}.`,
		'Return them as "enemy_intents": [{"enemy": "Ghoul 1", "intent": "close", "target": "Sister Almath"}].',
		"hold and withdraw need no target. An order stands until you change it, so send only what changed.",
		"Never give a square, a cell, a coordinate or a distance — those are not yours to choose, and an "
			+ "order carrying one is discarded.",
	].join("\n");
}
