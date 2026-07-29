/**
 * enemyRound — the enemies take their turn, for whichever path is driving the game.
 *
 * @description The enemies' round lived inside `server.js`'s `action:submit` handler
 *   and nowhere else. A turn that expired on the clock went to the narrator without
 *   one, so the enemies simply did not attack: **not acting was mechanically safer
 *   than acting**, and in a hard fight that is the optimal play.
 *
 *   It is here rather than copied into the timer because a copy is a copy that drifts.
 *   The bookkeeping this wraps — which enemies still hold an action, recording that
 *   they spent it, the lobby's difficulty, the party size the share-out divides by —
 *   was added to the original path one piece at a time over a day, and a second
 *   hand-maintained version would have missed most of it.
 */

import { resolveEnemyAttacks, describeAttacks } from "./enemyTurns.js";

/**
 * Rolls the enemies' round for a lobby and records that they spent their actions.
 *
 * @description Mutates only `actedInRound` on the enemies that acted. Applying the
 *   damage is the caller's job, because the two entry points broadcast it differently
 *   and one of them has to check for a wipe partway through.
 * @param {object} lobby - The lobby record from `LobbyStore.index`.
 * @param {object} [dice] - Injected dice, forwarded to the resolver for tests.
 * @param {Function} [dice.rollD20] - The d20.
 * @param {Function} [dice.rollDamage] - The damage roll.
 * @returns {{attacks: Array<object>, hpUpdates: Array<object>, block: string}} What
 *   happened, the HP updates ready for `broadcastHPUpdates`, and the block to hand
 *   the narrator — empty when no enemy acted.
 */
export function takeEnemyRound(lobby, { rollD20, rollDamage } = {}) {
	const empty = { attacks: [], hpUpdates: [], block: "" };
	if (!lobby || typeof lobby !== "object") return empty;

	// Defaulted rather than passed through as undefined: the resolver reads a missing
	// round as "this caller does not know the round" and hands every enemy an action
	// on every turn, which is the bug this module exists downstream of.
	const round = Number(lobby.round) || 1;

	const turn = resolveEnemyAttacks({
		enemies: lobby.enemies,
		players: lobby.players,
		difficulty: lobby.difficulty,
		round,
		turnIndex: lobby.turnIndex,
		partySize: (lobby.initiative || []).filter((name) => !lobby.players?.[name]?.dead).length,
		...(rollD20 ? { rollD20 } : {}),
		...(rollDamage ? { rollDamage } : {}),
	});

	for (const name of turn.acted || []) {
		if (lobby.enemies?.[name]) lobby.enemies[name].actedInRound = round;
	}

	// `reason` is carried because `hp:update` without one is labelled "Manual change"
	// in the admin feed, which reads as an operator edit rather than a goblin.
	const hpUpdates = Object.entries(turn.damage).map(([player, amount]) => ({
		player,
		delta: -amount,
		reason: "Struck in combat",
	}));

	return { attacks: turn.attacks, hpUpdates, block: describeAttacks(turn.attacks) };
}
