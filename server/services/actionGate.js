/**
 * actionGate — orchestrates feasibility checking around a submitted action.
 *
 * Decides nothing itself. `actionFeasibility` judges; this module owns the
 * consequences: telling the player, spending one of their three chances, putting
 * the turn clock back, and forfeiting the turn once the chances are gone.
 *
 * Restoring the timer is the part that matters most. `action:submit` cancels the
 * turn timer before it validates anything, so every early return has to put it
 * back — the existing `roll:required` path does not, which is why an unanswered
 * dice check currently freezes a lobby permanently with nothing to recover it.
 *
 * Four modes, so this can be introduced without surprising a live table:
 *   off      — allow everything, consult nothing
 *   observe  — form a verdict and log it, but allow everything and charge nothing
 *   hard     — enforce the deterministic checks only; never spends a model call
 *   judge    — deterministic checks, then the model for anything ambiguous
 */

import { buildCapability } from "./characterCapability.js";
import { hardChecks, judgeAction, REJECT_CODES } from "./actionFeasibility.js";
import { MAX_ACTION_ATTEMPTS } from "./lobby/turnAttempts.js";

/**
 * @description Creates the gate.
 * @param {object} deps - Injected collaborators.
 * @param {object} deps.store - The LobbyStore, for capability and attempt tracking.
 * @param {function(...*): void} deps.log - Logger.
 * @param {"off"|"observe"|"hard"|"judge"} [deps.mode="observe"] - Enforcement level.
 * @param {function} deps.getLLMResponse - Model call, forwarded to the judge.
 * @param {function(string): object|object} deps.llmOpts - Per-lobby provider options.
 * @param {function(string): void} deps.resumeTurnTimer - Restores the turn clock with
 *   the time that was left, so a rejection does not hand the player a fresh budget.
 * @param {function(string, string, string): void} deps.skipTurn - Forfeits the turn.
 * @returns {{check: function(object): Promise<object>}} The gate.
 */
export function createActionGate({ store, log, mode = "observe", getLLMResponse, llmOpts, resumeTurnTimer, skipTurn }) {
	/**
	 * @description Evaluates one submitted action and applies the consequences.
	 * @param {object} params - Submission details.
	 * @param {string} params.lobbyId - The lobby.
	 * @param {object} params.socket - The submitting player's socket.
	 * @param {string} params.playerName - The acting character.
	 * @param {string} params.text - The submitted action.
	 * @returns {Promise<{allow: boolean, wouldReject?: boolean, verdict?: object}>}
	 *   `allow: false` means the caller must stop; the gate has already told the
	 *   player and dealt with the clock.
	 */
	async function check({ lobbyId, socket, playerName, text }) {
		if (mode === "off") return { allow: true };

		const lobby = store.index?.[lobbyId];
		if (!lobby) return { allow: false };

		const capability = buildCapability(lobby, playerName);

		let verdict = hardChecks(capability, text);

		// Only pay for a model call when code could not settle it, and only in the
		// modes that actually consult one.
		if (verdict.allow && verdict.escalate && (mode === "judge" || mode === "observe")) {
			const judged = await judgeAction({
				capability,
				text,
				getLLMResponse,
				llmOpts: typeof llmOpts === "function" ? llmOpts(lobbyId) : llmOpts,
				hint: verdict.hint,
			});
			if (judged.verdict === "reject") {
				verdict = {
					allow: false,
					code: REJECT_CODES.IMPLAUSIBLE,
					reason: judged.reason || "That is not something your character could do here.",
					strike: true,
				};
			}
		}

		if (verdict.allow) {
			// A turn that lands cleanly wipes the slate, so earlier misfires this turn
			// do not shorten a later one.
			store.clearTurnAttempts(lobbyId);
			return { allow: true, verdict };
		}

		// Observing only: record what would have happened and let it through.
		if (mode === "observe") {
			log(`[gate:observe] would reject ${playerName} in ${lobbyId} (${verdict.code}): ${verdict.reason}`);
			return { allow: true, wouldReject: true, verdict };
		}

		const strike = verdict.strike === true
			? store.recordRejectedAttempt(lobbyId, playerName)
			: { attempts: store.attemptsUsed(lobbyId, playerName), remaining: MAX_ACTION_ATTEMPTS, exhausted: false };

		socket.emit("action:rejected", {
			reason: verdict.reason,
			code: verdict.code,
			strikes: strike.attempts,
			maxStrikes: MAX_ACTION_ATTEMPTS,
			retry: !strike.exhausted,
		});

		log(`[gate] rejected ${playerName} in ${lobbyId} (${verdict.code}) strike ${strike.attempts}/${MAX_ACTION_ATTEMPTS}`);

		if (strike.exhausted) {
			store.clearTurnAttempts(lobbyId);
			skipTurn(lobbyId, playerName, "three rejected actions");
		} else {
			// The clock was cancelled before validation; give back what was left of it.
			resumeTurnTimer(lobbyId);
		}

		return { allow: false, verdict };
	}

	return { check };
}
