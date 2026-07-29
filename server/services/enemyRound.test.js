/**
 * Tests for taking an enemy round.
 *
 * @description The enemies' round was resolved in `server.js`'s `action:submit`
 *   handler and nowhere else. A turn that timed out went to the narrator without one,
 *   so the enemies simply did not attack — which made *not acting* mechanically safer
 *   than acting, and in a hard fight that is the optimal play.
 *
 *   Both entry points now share this, because a copy in the timer would be a copy that
 *   drifts: it would have had to remember the round bookkeeping, the difficulty, and
 *   the damage strip, all of which were added to the other path one at a time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { takeEnemyRound } from "./enemyRound.js";

/**
 * @description A lobby with a fight in progress, in the shape `LobbyStore` holds.
 * @param {object} [over] - Fields merged onto the lobby.
 * @returns {object} The lobby record.
 */
function lobby(over = {}) {
	return {
		lobbyId: "L",
		round: 3,
		turnIndex: 0,
		difficulty: "standard",
		initiative: ["A", "B"],
		players: {
			A: { name: "A", stats: { hp: 30, max_hp: 30, dex: 10 }, armor: null },
			B: { name: "B", stats: { hp: 30, max_hp: 30, dex: 10 }, armor: null },
		},
		enemies: {
			G1: { name: "G1", hp: 7, max_hp: 7, ac: 15, str: 10, cr: "1/4", status: "active" },
			G2: { name: "G2", hp: 7, max_hp: 7, ac: 15, str: 10, cr: "1/4", status: "active" },
		},
		...over,
	};
}

/** Dice that always land. */
const hitting = { rollD20: () => 20, rollDamage: () => 3 };

test("the enemies attack and the damage comes back as hp updates ready to apply", () => {
	const l = lobby();
	const result = takeEnemyRound(l, hitting);

	assert.ok(result.attacks.length > 0);
	assert.ok(result.hpUpdates.length > 0);
	for (const u of result.hpUpdates) {
		assert.ok(u.delta < 0, `expected damage, got ${u.delta}`);
		assert.ok(u.player);
		assert.ok(u.reason, "an unexplained hp change shows as a manual edit in the admin feed");
	}
});

test("the round is recorded on the enemies that acted", () => {
	// Without this an enemy would come round again on the next player's turn, which is
	// the whole bug the round tracking exists to prevent.
	const l = lobby();
	takeEnemyRound(l, hitting);

	const acted = Object.values(l.enemies).filter((e) => e.actedInRound === 3);
	assert.ok(acted.length > 0, "nobody was marked as having acted");
});

test("an enemy that has already acted this round does not act again", () => {
	const l = lobby();
	l.enemies.G1.actedInRound = 3;
	l.enemies.G2.actedInRound = 3;

	const result = takeEnemyRound(l, hitting);

	assert.deepEqual(result.attacks, []);
	assert.deepEqual(result.hpUpdates, []);
});

test("the narrator gets a block stating exactly what happened", () => {
	const result = takeEnemyRound(lobby(), hitting);

	assert.match(result.block, /ENEMY ACTIONS THIS ROUND/);
	assert.match(result.block, /HITS for \d+ damage/);
});

test("a round where nothing happened produces no block to paste", () => {
	const result = takeEnemyRound(lobby({ enemies: {} }), hitting);

	assert.equal(result.block, "");
	assert.deepEqual(result.attacks, []);
	assert.deepEqual(result.hpUpdates, []);
});

test("the lobby's difficulty is applied", () => {
	const damageAt = (difficulty) => {
		const l = lobby({ difficulty });
		return takeEnemyRound(l, hitting).hpUpdates.reduce((sum, u) => sum + Math.abs(u.delta), 0);
	};

	assert.ok(damageAt("merciless") > damageAt("standard"), "merciless did not hit harder");
	assert.ok(damageAt("casual") < damageAt("standard"), "casual did not hit softer");
});

test("only living, undefeated players are counted for the share-out", () => {
	// A dead character still sitting in the initiative array must not hold a seat, or
	// the survivors face fewer attackers than they should.
	const l = lobby();
	l.players.B.dead = true;

	const result = takeEnemyRound(l, hitting);

	assert.ok(result.attacks.every((a) => a.target === "A"), JSON.stringify(result.attacks));
});

test("a lobby with no fight in it is harmless", () => {
	for (const empty of [null, undefined, {}, lobby({ enemies: null, players: null })]) {
		const result = takeEnemyRound(empty, hitting);

		assert.deepEqual(result.attacks, []);
		assert.deepEqual(result.hpUpdates, []);
		assert.equal(result.block, "");
	}
});

test("a lobby with no round number still resolves once rather than repeatedly", () => {
	// `round` defaults to 1 rather than being left undefined, which would drop the
	// resolver into its "caller does not know the round" fallback and hand every enemy
	// an action on every turn — the bug, reintroduced by omission.
	const l = lobby({ round: undefined });
	takeEnemyRound(l, hitting);

	assert.ok(Object.values(l.enemies).some((e) => Number.isFinite(e.actedInRound)));
});
