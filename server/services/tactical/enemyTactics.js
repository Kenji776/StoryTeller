/**
 * What the monsters do with a map.
 *
 * @description Phase 5 of the tactical map, and the phase that makes the rest of it worth having.
 *   Until now the map constrained players and not enemies: standing in cover earned armour class
 *   against a shot, but nothing decided to shoot the exposed character instead. Positioning was
 *   enforced and never rewarded.
 *
 *   Two changes fix that, and both are about who the enemies pick:
 *
 *   - **Targets go to the nearest reachable enemy**, replacing `enemyTurns.js`'s round-robin. That
 *     is what makes a front line exist: step between the ghoul and the cleric and the ghoul comes
 *     for *you*, because you are nearer. Guarding is a consequence of geometry rather than a rule
 *     written for it.
 *   - **An enemy out of reach does not attack.** It closes instead. Distance becoming a real cost
 *     to them is the other half of it — before this, an enemy forty feet away hit you anyway.
 *
 *   Intent follows [ADR 0027](../../../docs/decisions/0027-enemies-are-given-intent-not-coordinates.md):
 *   the narrator may choose from a closed set of verbs and never a cell, every enemy has a
 *   deterministic default so a fight never depends on a working language model, and an order is
 *   re-validated every round so a stale one falls back rather than doing something absurd.
 */

import { isTactical } from "./session.js";
import { cellLabel, distanceFeet } from "./grid.js";
import { reachableCells, pathTo } from "./movement.js";
import { coverBetween, hasLineOfSight } from "./sight.js";

/**
 * The verbs an intent may use. Closed on purpose: an unknown verb is discarded rather than guessed
 * at, and the temptation to add a seventh should be met by composing two of these.
 */
export const INTENTS = ["close", "hold", "ranged", "seek_cover", "withdraw", "regroup"];

/** How far a `ranged` creature tries to stay from what it is shooting. */
const PREFERRED_RANGE_FEET = 30;

/**
 * @description Lists the tokens on a map that oppose a given faction and are still on it.
 * @param {object} map - The tactical map.
 * @param {string} faction - The asking side.
 * @returns {Array<object>} Named tokens, `{name, ...token}`.
 */
function opponentsOf(map, faction) {
	return Object.entries(map.tokens ?? {})
		.map(([name, token]) => ({ name, ...token }))
		.filter((token) => token.faction !== faction);
}

/**
 * @description Picks the closest of a set of tokens.
 * @param {object} map - The tactical map.
 * @param {number[]} from - Where to measure from.
 * @param {Array<object>} candidates - Named tokens.
 * @returns {object|null} The nearest, ties broken by name so the choice is stable — `TDD-8`, and it
 *   also stops a monster oscillating between two equidistant characters on consecutive rounds.
 */
function nearest(map, from, candidates) {
	let best = null;
	for (const candidate of candidates) {
		const gap = distanceFeet(map, from, candidate.cell);
		if (!best || gap < best.gap || (gap === best.gap && candidate.name < best.token.name)) {
			best = { token: candidate, gap };
		}
	}
	return best?.token ?? null;
}

/**
 * The intent an enemy follows when nobody has said otherwise.
 *
 * @description Deliberately legible: go for whoever is closest, and stop moving once you can hit
 *   them. This is what actually runs most of the time — it runs whenever the narrator says nothing,
 *   returns something unparseable, or the provider falls over — so it sets the felt quality of
 *   combat far more than any clever order does, and it is tuned as a feature rather than treated as
 *   a fallback nobody looks at.
 * @param {object} map - The tactical map.
 * @param {string} enemyName - Whose intent to choose.
 * @returns {{verb: string, target: string|null}} An intent.
 */
export function defaultIntent(map, enemyName) {
	const me = map?.tokens?.[enemyName];
	if (!me) return { verb: "hold", target: null };

	const quarry = nearest(map, me.cell, opponentsOf(map, me.faction));
	if (!quarry) return { verb: "hold", target: null };

	const reach = Number(me.reachFeet) || 5;
	return distanceFeet(map, me.cell, quarry.cell) <= reach
		? { verb: "hold", target: quarry.name }
		: { verb: "close", target: quarry.name };
}

/**
 * @description Takes whatever intent is on record and returns one that can actually be executed.
 * @param {object} map - The tactical map.
 * @param {string} enemyName - Whose intent to resolve.
 * @param {object} [order] - A standing order, possibly from the narrator and possibly stale.
 * @returns {{verb: string, target: string|null, fellBack: boolean}} A usable intent. `fellBack`
 *   records that the order was discarded, which is worth logging: an order chosen a round earlier
 *   can name somebody who has since died, and silently substituting the default would make a
 *   monster's behaviour impossible to account for.
 */
export function resolveIntent(map, enemyName, order) {
	const fallback = { ...defaultIntent(map, enemyName), fellBack: true };
	if (!order || !INTENTS.includes(order.verb)) return fallback;

	// A verb that needs somebody needs that somebody to still be on the map.
	const needsTarget = order.verb !== "hold" && order.verb !== "withdraw";
	if (needsTarget && !map?.tokens?.[order.target]) return fallback;

	return { verb: order.verb, target: order.target ?? null, fellBack: false };
}

/**
 * @description Finds the reachable cell that best satisfies an intent.
 * @param {object} map - The tactical map.
 * @param {string} enemyName - Who is moving.
 * @param {{verb: string, target: string|null}} intent - What they are trying to do.
 * @returns {number[]|null} A destination, or `null` to stay put.
 */
function destinationFor(map, enemyName, intent) {
	const me = map.tokens[enemyName];
	const reach = Number(me.reachFeet) || 5;
	const target = intent.target ? map.tokens[intent.target] : null;
	const options = reachableCells(map, enemyName);

	/**
	 * @description Picks the option scoring best, ties broken by cell label for stability.
	 *
	 *   Staying put is the baseline and a move has to beat it **strictly**. Without that the
	 *   tie-break produces pointless lateral shuffling: distance is Chebyshev, so every cell in a
	 *   column can be equally close to a target, and "get nearer" then picked whichever label sorted
	 *   first. A test caught a ghoul stepping K3 → K1 without reducing the distance by a foot, which
	 *   on a rendered map reads as the monster being broken.
	 * @param {Function} score - Lower is better; `null` rejects the cell.
	 * @returns {number[]|null} The winning cell, or `null` to stay where it is.
	 */
	const pickBy = (score) => {
		const staying = score({ cell: me.cell, costFeet: 0 });
		let best = staying === null ? null : { label: cellLabel(me.cell), cell: me.cell, value: staying };
		for (const [label, entry] of options) {
			const value = score(entry);
			if (value === null) continue;
			if (!best || value < best.value || (value === best.value && label < best.label && best.value !== staying)) {
				best = { label, cell: entry.cell, value };
			}
		}
		return best && best.value !== staying ? best.cell : null;
	};

	switch (intent.verb) {
		case "hold":
			return null;

		case "close":
			if (!target) return null;
			// Get within reach if possible; failing that, get as close as the budget allows.
			return pickBy((entry) => distanceFeet(map, entry.cell, target.cell));

		case "ranged": {
			if (!target) return null;
			// Somewhere it can see the target from, as near the preferred distance as it can manage.
			return pickBy((entry) => {
				if (!hasLineOfSight(map, entry.cell, target.cell)) return null;
				return Math.abs(distanceFeet(map, entry.cell, target.cell) - PREFERRED_RANGE_FEET);
			});
		}

		case "seek_cover": {
			if (!target) return null;
			// Cover first, then closeness — a sheltered cell it cannot shoot from is no use.
			return pickBy((entry) => {
				const shelter = coverBetween(map, target.cell, entry.cell);
				if (shelter === "none") return null;
				if (!hasLineOfSight(map, entry.cell, target.cell)) return null;
				return distanceFeet(map, entry.cell, target.cell);
			});
		}

		case "withdraw": {
			const threats = opponentsOf(map, me.faction);
			if (!threats.length) return null;
			// Furthest from the nearest threat, hence the negation.
			return pickBy((entry) => -Math.min(...threats.map((threat) => distanceFeet(map, entry.cell, threat.cell))));
		}

		case "regroup": {
			const ally = intent.target ? map.tokens[intent.target] : null;
			if (!ally) return null;
			return pickBy((entry) => {
				const gap = distanceFeet(map, entry.cell, ally.cell);
				// Beside them, not on top of them; `reachableCells` already excludes their square.
				return gap <= reach ? 0 : gap;
			});
		}

		default:
			return null;
	}
}

/**
 * Moves one enemy according to its intent.
 *
 * @param {object} lobby - The lobby record; the token is mutated on success.
 * @param {string} enemyName - Who is moving.
 * @returns {{name: string, from: number[], to: number[], costFeet: number, verb: string}|null} What
 *   happened, for the narrator's block and the log, or `null` when it stayed where it was.
 */
export function moveEnemy(lobby, enemyName) {
	if (!isTactical(lobby) || !lobby.map?.tokens?.[enemyName]) return null;
	const map = lobby.map;
	const me = map.tokens[enemyName];

	const intent = resolveIntent(map, enemyName, me.order);
	const destination = destinationFor(map, enemyName, intent);
	if (!destination || cellLabel(destination) === cellLabel(me.cell)) return null;

	const route = pathTo(map, enemyName, destination);
	if (!route) return null;

	const from = [...me.cell];
	me.cell = [...destination];
	return { name: enemyName, from, to: [...destination], costFeet: route.costFeet, verb: intent.verb };
}

/**
 * The tactics object `enemyTurns.js` consults when a map is in play.
 *
 * @description Passed in rather than imported there, so `enemyTurns.js` keeps knowing nothing about
 *   maps and the round-robin path stays exactly as it was for a lobby that never opted in. Omitting
 *   this is what "the feature is off" means at that layer.
 * @param {object} lobby - The lobby record.
 * @returns {object|null} `{beforeStrike, pickTarget, canStrike}`, or `null` when there is no map.
 */
export function tacticsFor(lobby) {
	if (!isTactical(lobby) || !lobby.map) return null;
	const map = lobby.map;

	return {
		/**
		 * @description Lets an enemy move before it swings. Called once per acting enemy, inside the
		 *   round, so movement is spent on the same schedule as attacks — moving everybody before
		 *   the round instead would have them travel once per player turn and strike once per round.
		 * @param {object} enemy - The enemy record.
		 * @returns {object|null} The movement, or `null`.
		 */
		beforeStrike: (enemy) => moveEnemy(lobby, enemy?.name),

		/**
		 * @description Picks who this enemy goes for: the nearest it can actually hit, and failing
		 *   that the nearest at all, so a creature that closed but fell short still has somebody
		 *   named for the narration.
		 * @param {object} enemy - The enemy record.
		 * @param {Array<object>} candidates - Standing party members.
		 * @returns {object|null} The chosen character.
		 */
		pickTarget: (enemy, candidates) => {
			const me = map.tokens[enemy?.name];
			if (!me) return null;
			const onMap = candidates.filter((player) => map.tokens[player?.name]);
			if (!onMap.length) return null;

			const reach = Number(me.reachFeet) || 5;
			const named = onMap.map((player) => ({ ...map.tokens[player.name], name: player.name, player }));
			const inReach = named.filter((token) => distanceFeet(map, me.cell, token.cell) <= reach);
			const chosen = nearest(map, me.cell, inReach.length ? inReach : named);
			return chosen?.player ?? null;
		},

		/**
		 * @description Whether the blow can actually be thrown. An enemy that has closed but not
		 *   arrived does not attack, which is what makes distance cost the monsters something too.
		 * @param {object} enemy - The enemy record.
		 * @param {object} target - The chosen character.
		 * @returns {boolean} True when the target is within reach.
		 */
		canStrike: (enemy, target) => {
			const me = map.tokens[enemy?.name];
			const them = map.tokens[target?.name];
			if (!me || !them) return false;
			return distanceFeet(map, me.cell, them.cell) <= (Number(me.reachFeet) || 5);
		},
	};
}
