/**
 * Where a token can get to, and by what route.
 *
 * @description The third layer of the tactical map ([ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)).
 *
 *   This module exists so that neither the narrator nor a player agent ever has to work out
 *   whether a move is legal. A small model asked "can I reach the ghoul" will answer the
 *   question it wishes had been asked; the menu it is shown instead is built from
 *   `reachableCells`, so every option offered is one the server has already agreed to.
 *
 *   Costs are in feet throughout, because that is the unit a speed is written in. A diagonal
 *   costs the same as an orthogonal step, matching `distanceCells` — the distance a player is
 *   quoted has to be the distance they pay, or the menu lies.
 */

import {
	blocksMovement, moveCostFeet, tokenAt, inBounds, sameCell,
	cellLabel, parseCellLabel, neighbours, DEFAULT_FEET_PER_CELL,
} from "./grid.js";

/** Speed for a token that does not state one. Thirty feet is the ordinary human walk. */
const DEFAULT_SPEED_FEET = 30;

/**
 * @description Reads a token's movement allowance.
 * @param {object} map - The tactical map.
 * @param {string} tokenName - Whose allowance to read.
 * @returns {number} Feet of movement, or zero for a token that is not on the map. A token
 *   present but silent about its speed gets the default rather than zero: every character
 *   already in a stored lobby predates the field, and reading that as "cannot move" would
 *   pin the entire existing cast to the spot.
 */
export function movementBudgetFeet(map, tokenName) {
	const token = map?.tokens?.[tokenName];
	if (!token) return 0;
	const stated = Number(token.speedFeet);
	return Number.isFinite(stated) && stated >= 0 ? stated : DEFAULT_SPEED_FEET;
}

/**
 * @description Reports whether a caller supplied a movement budget.
 * @param {*} budgetFeet - The candidate.
 * @returns {boolean} True for any non-negative number, `Infinity` included.
 * @throws Nothing.
 *
 *   Written out rather than inlined as `Number.isFinite`, which is what it used to be and which
 *   is wrong here: `Number.isFinite(Infinity)` is false, so an explicit unlimited budget was read
 *   as "none given" and quietly replaced with the token's own speed. `session.applyMove` asks
 *   what an out-of-range move *would* have cost so its refusal can say so, and got nothing back.
 */
function budgetGiven(budgetFeet) {
	return typeof budgetFeet === "number" && !Number.isNaN(budgetFeet) && budgetFeet >= 0;
}

/**
 * @description Reports whether a diagonal step would squeeze between two blocked corners.
 *   Slipping through the join between two walls is the oldest grid cheat there is, and
 *   forbidding it costs nothing while stopping a character crossing a barrier that looks
 *   solid on the map.
 * @param {object} map - The tactical map.
 * @param {number[]} from - The cell being left.
 * @param {number[]} to - The diagonally adjacent cell being entered.
 * @returns {boolean} True when the step is a forbidden squeeze.
 */
function squeezes(map, from, to) {
	const diagonal = from[0] !== to[0] && from[1] !== to[1];
	if (!diagonal) return false;
	return blocksMovement(map, [to[0], from[1]]) && blocksMovement(map, [from[0], to[1]]);
}

/**
 * Whether a single step is allowed, and what it costs.
 *
 * @description The two occupancy rules lived as a comment inside the search loop until `npx
 *   fallow` put that loop at 21 cyclomatic. They are rules, so they get a name:
 *
 *   - **An enemy is a wall.** They cannot be passed at all, which is what makes holding a
 *     corridor mean something.
 *   - **A friend is a turnstile.** Squeeze past, never stop on. Treating an ally as solid would
 *     let a party seal itself into a passage — a softlock wearing the costume of a rule.
 * @param {object} map - The tactical map.
 * @param {string} tokenName - The token moving.
 * @param {string} faction - The mover's faction, which decides who counts as a friend.
 * @param {number[]} from - The cell being left.
 * @param {number[]} to - The cell being entered.
 * @returns {{costFeet: number, canRest: boolean}|null} The step, or `null` when it is not
 *   allowed at all.
 */
function stepInto(map, tokenName, faction, from, to) {
	if (!inBounds(map, to) || blocksMovement(map, to)) return null;
	if (squeezes(map, from, to)) return null;

	const occupant = tokenAt(map, to);
	const someoneElse = occupant && occupant.name !== tokenName;
	if (someoneElse && occupant.token?.faction !== faction) return null;

	return { costFeet: moveCostFeet(map, to), canRest: !someoneElse };
}

/**
 * The one search both public questions are answered from.
 *
 * @description Dijkstra rather than a breadth-first fill, because scenery makes steps cost
 *   different amounts — rubble at double price means the cheapest route is not always the
 *   shortest one.
 *
 *   Occupancy has two rules rather than one. An enemy cannot be passed at all, which is what
 *   makes holding a corridor mean something. A **friend can be squeezed past but not stood
 *   on**: treating an ally as a wall would let a party seal itself into a passage, which is a
 *   softlock wearing the costume of a rule.
 *
 *   Shared deliberately. "Where can I go" and "how do I get to this square" ran as two
 *   near-identical loops until `npx fallow` called them a clone, and it was right about the
 *   risk: a fix to the squeeze rule in one and not the other would have left `canReach` and
 *   `pathTo` quietly disagreeing about which moves are legal.
 * @param {object} map - The tactical map.
 * @param {string} tokenName - The token moving.
 * @param {number} budgetFeet - Feet available.
 * @returns {{best: Map<string, number>, cameFrom: Map<string, number[]>, restable: Set<string>}}
 *   Cheapest cost to each cell reached, the predecessor of each, and which of them a body
 *   could actually come to rest on.
 */
function search(map, tokenName, budgetFeet) {
	const token = map?.tokens?.[tokenName];
	const start = token?.cell;
	const best = new Map();
	const cameFrom = new Map();
	const restable = new Set();
	if (!start || !inBounds(map, start)) return { best, cameFrom, restable };

	const faction = token.faction;
	best.set(cellLabel(start), 0);
	restable.add(cellLabel(start));

	// A plain array sorted on each pass. Arenas are a few hundred cells at most, so a heap
	// would be more code to read for no measurable gain.
	const frontier = [{ cell: start, costFeet: 0 }];

	while (frontier.length) {
		// Cheapest first, then by label. The second key is what makes the result stable
		// across runs, which `TDD-8` requires and which stops a menu shown to a player being
		// reordered between the turn it was built and the turn it is checked.
		frontier.sort((a, b) => a.costFeet - b.costFeet || cellLabel(a.cell).localeCompare(cellLabel(b.cell)));
		const current = frontier.shift();
		if (current.costFeet > (best.get(cellLabel(current.cell)) ?? Infinity)) continue;

		for (const [dx, dy] of neighbours()) {
			const next = [current.cell[0] + dx, current.cell[1] + dy];
			const step = stepInto(map, tokenName, faction, current.cell, next);
			if (!step) continue;

			const cost = current.costFeet + step.costFeet;
			if (cost > budgetFeet) continue;

			const label = cellLabel(next);
			if (cost >= (best.get(label) ?? Infinity)) continue;
			best.set(label, cost);
			cameFrom.set(label, current.cell);
			frontier.push({ cell: next, costFeet: cost });

			if (step.canRest) restable.add(label);
			else restable.delete(label);
		}
	}

	return { best, cameFrom, restable };
}

/**
 * @description Every cell a token could legally finish its move on, and what getting there
 *   costs. Occupancy and squeeze rules are `search`'s.
 * @param {object} map - The tactical map.
 * @param {string} tokenName - The token moving.
 * @param {object} [options] - Options.
 * @param {number} [options.budgetFeet] - Override the token's own speed.
 * @returns {Map<string, {cell: number[], costFeet: number}>} Legal destinations keyed by cell
 *   label, including the token's own cell at a cost of nothing — standing still is a move,
 *   and holding a doorway is a tactic rather than an oversight. Empty for a token that is not
 *   on the map, or for a map too malformed to read.
 */
export function reachableCells(map, tokenName, { budgetFeet } = {}) {
	const budget = budgetGiven(budgetFeet) ? budgetFeet : movementBudgetFeet(map, tokenName);
	const { best, restable } = search(map, tokenName, budget);

	const results = new Map();
	for (const label of restable) {
		results.set(label, { cell: parseCellLabel(label), costFeet: best.get(label) });
	}
	return results;
}

/**
 * @description Reports whether a token could finish its move on a given cell.
 * @param {object} map - The tactical map.
 * @param {string} tokenName - The token moving.
 * @param {number[]|string} destination - A cell, or a label — one arrives from a click on the
 *   map and the other from a sentence a model wrote, and both have to work.
 * @returns {boolean} True when the destination is a legal move.
 */
export function canReach(map, tokenName, destination) {
	const cell = typeof destination === "string" ? parseCellLabel(destination) : destination;
	const label = cellLabel(cell);
	if (!label) return false;
	return reachableCells(map, tokenName).has(label);
}

/**
 * The route a token would walk to reach a cell.
 *
 * @description Walks `search`'s predecessor chain back from the destination. Sharing that
 *   search with `reachableCells` is what guarantees a route exists for every cell the menu
 *   offered, and that both agree on its price.
 * @param {object} map - The tactical map.
 * @param {string} tokenName - The token moving.
 * @param {number[]|string} destination - A cell or a label.
 * @param {object} [options] - Options.
 * @param {number} [options.budgetFeet] - Override the token's own speed.
 * @returns {{cells: number[][], costFeet: number}|null} The steps, excluding the starting
 *   cell and including the destination, with the total cost. `null` when the destination is
 *   unreachable — reported as no path rather than as a truncated one, because clamping would
 *   leave a character standing somewhere nobody chose.
 */
export function pathTo(map, tokenName, destination, { budgetFeet } = {}) {
	const target = typeof destination === "string" ? parseCellLabel(destination) : destination;
	const start = map?.tokens?.[tokenName]?.cell;
	if (!start || !cellLabel(target) || !inBounds(map, target)) return null;
	if (sameCell(start, target)) return { cells: [], costFeet: 0 };

	const budget = budgetGiven(budgetFeet) ? budgetFeet : movementBudgetFeet(map, tokenName);
	const { best, cameFrom, restable } = search(map, tokenName, budget);

	const targetLabel = cellLabel(target);
	if (!restable.has(targetLabel)) return null;

	const cells = [];
	let cursor = target;
	while (!sameCell(cursor, start)) {
		cells.unshift([...cursor]);
		cursor = cameFrom.get(cellLabel(cursor));
		if (!cursor) return null;
	}
	return { cells, costFeet: best.get(targetLabel) };
}

/**
 * Every cell walkable from a starting cell, ignoring speed and ignoring who is standing where.
 *
 * @description A different question from `reachableCells`, and deliberately so. That one
 *   answers "where can I go this turn" and is bounded by a budget and blocked by bodies; this
 *   one asks whether a room hangs together at all.
 *
 *   Generation is the caller. It needs to know that every enemy can be got at from every party
 *   spawn before it accepts an arena, and both qualifications matter: a five-foot speed must
 *   not make a perfectly traversable room look disconnected, and a creature parked in a
 *   doorway must not either — tokens move, terrain does not.
 * @param {object} map - The tactical map.
 * @param {number[]} start - Where to fill from.
 * @returns {Set<string>} Cell labels, including the start. Empty when the start is off the map,
 *   impassable, or malformed. A `Set` because the only question asked of it is membership, once
 *   per spawn per generation attempt.
 */
export function walkableRegion(map, start) {
	const region = new Set();
	if (!Array.isArray(start) || !inBounds(map, start) || blocksMovement(map, start)) return region;

	region.add(cellLabel(start));
	const pending = [start];
	while (pending.length) {
		const current = pending.pop();
		for (const [dx, dy] of neighbours()) {
			const next = [current[0] + dx, current[1] + dy];
			if (!inBounds(map, next) || blocksMovement(map, next)) continue;
			if (squeezes(map, current, next)) continue;
			const label = cellLabel(next);
			if (region.has(label)) continue;
			region.add(label);
			pending.push(next);
		}
	}
	return region;
}
