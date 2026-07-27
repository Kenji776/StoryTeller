/**
 * Turn attempts — tracks how many times the active player has had an action
 * rejected as impossible during their current turn.
 *
 * The rule this implements: a player gets three tries to propose something their
 * character could plausibly do, and is skipped after the third rejection. The
 * count therefore has to be per-turn (a skipped player must start their next turn
 * fresh) and per-player (one player's flailing must not spend another's chances).
 *
 * It lives on the persisted lobby object rather than in a Map keyed by socket id,
 * for the same reason the rest of this work exists: a player who reconnects
 * mid-turn must find their strikes intact. Holding it in memory against a socket
 * id would hand out unlimited retries to anyone who reconnected.
 */

/** Chances to propose a possible action before the turn is forfeited. */
export const MAX_ACTION_ATTEMPTS = 3;

export const turnAttemptMethods = {
	/**
	 * @description Records that the active player's proposed action was rejected.
	 *   Scoped to the player so a turn handed on mid-count cannot inherit strikes.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player whose action was rejected.
	 * @returns {{attempts: number, remaining: number, exhausted: boolean}} The attempt
	 *   just consumed, how many remain, and whether the turn should now be forfeited.
	 * @throws {TypeError} If `playerName` is not a non-empty string.
	 */
	recordRejectedAttempt(lobbyId, playerName) {
		if (typeof playerName !== "string" || !playerName) {
			throw new TypeError(`recordRejectedAttempt: playerName must be a non-empty string, received ${JSON.stringify(playerName)}`);
		}

		const s = this.index[lobbyId];
		if (!s) return { attempts: 0, remaining: MAX_ACTION_ATTEMPTS, exhausted: false };

		if (!s.turnAttempts || s.turnAttempts.player !== playerName) {
			s.turnAttempts = { player: playerName, count: 0 };
		}

		s.turnAttempts.count += 1;
		this.persist(lobbyId);

		const attempts = s.turnAttempts.count;
		return {
			attempts,
			remaining: Math.max(0, MAX_ACTION_ATTEMPTS - attempts),
			exhausted: attempts >= MAX_ACTION_ATTEMPTS,
		};
	},

	/**
	 * @description Reports how many rejected attempts stand against a player this turn.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player to query.
	 * @returns {number} Attempts used, or `0` if none or the lobby is unknown.
	 */
	attemptsUsed(lobbyId, playerName) {
		const attempts = this.index[lobbyId]?.turnAttempts;
		return attempts && attempts.player === playerName ? attempts.count : 0;
	},

	/**
	 * @description Clears the attempt counter, called whenever the turn moves on —
	 *   whether the player acted, was skipped, or ran out of chances.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {void}
	 */
	clearTurnAttempts(lobbyId) {
		const s = this.index[lobbyId];
		if (!s || !s.turnAttempts) return;
		s.turnAttempts = null;
		this.persist(lobbyId);
	},
};
