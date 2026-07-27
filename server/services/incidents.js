/**
 * incidents — a per-lobby record of things that went wrong and could not be
 * fixed automatically.
 *
 * The gap this closes: when the Dungeon Master says a player took nine damage and
 * the update silently fails to apply — because the name it used does not match any
 * character in the lobby — the only trace today is a `console.warn` on the server.
 * The player watches their HP not change and has no idea why; nobody with the power
 * to fix it ever finds out. Several failure paths behave the same way.
 *
 * So: anything the server cannot heal by itself gets raised here, where an admin can
 * see it, and — paired with the repair operations in `adminEvents` — put it right.
 *
 * Deliberately in memory only. These describe *this run* of the process, and a
 * restart clears every condition they were reporting anyway.
 */

import { randomUUID } from "crypto";

/** How the interface should weight an incident. */
export const SEVERITY = { INFO: "info", WARNING: "warning", ERROR: "error" };

/** Incidents retained per lobby before the oldest are dropped. */
const DEFAULT_CAPACITY = 100;

/** Longest stored message; anything more is a stack trace or a model dump. */
const MAX_MESSAGE = 500;

/**
 * @description Creates an incident log.
 * @param {object} [deps] - Injected collaborators.
 * @param {function(): number} [deps.now=Date.now] - Clock, injected for tests.
 * @param {number} [deps.capacity=100] - Incidents kept per lobby.
 * @param {function(string, object): void} [deps.notify] - Called with each incident so
 *   watching admins can be told live.
 * @returns {{raise: Function, list: Function, unresolved: Function, resolve: Function, clear: Function}}
 *   The log.
 */
export function createIncidentLog({ now = Date.now, capacity = DEFAULT_CAPACITY, notify = () => {} } = {}) {
	/** @type {Map<string, Array<object>>} lobbyId → incidents, oldest first */
	const byLobby = new Map();

	/**
	 * @description Builds the identity used to recognise a repeat. Two incidents are
	 *   "the same" when they share a kind, a message and a detail — a parse failure
	 *   recurring every turn should read as one ongoing problem rather than fifty.
	 * @param {object} incident - The candidate.
	 * @returns {string} A comparison key.
	 */
	function fingerprint({ kind, message, detail }) {
		return JSON.stringify([kind, message, detail ?? null]);
	}

	return {
		/**
		 * @description Records something that went wrong, collapsing repeats.
		 * @param {string} lobbyId - The affected lobby.
		 * @param {object} incident - What happened.
		 * @param {string} incident.kind - Machine-readable category, e.g. `"update_dropped"`.
		 * @param {string} incident.message - One line a human can act on.
		 * @param {string} [incident.severity="warning"] - One of {@link SEVERITY}.
		 * @param {object} [incident.detail] - Structured context for a repair, such as the
		 *   player and field involved.
		 * @param {string} [incident.suggestedFix] - What an admin could do about it.
		 * @returns {object} The stored incident.
		 * @throws {TypeError} If `lobbyId` or `kind` is missing.
		 */
		raise(lobbyId, incident = {}) {
			if (typeof lobbyId !== "string" || !lobbyId) {
				throw new TypeError(`incidents.raise: lobbyId must be a non-empty string, received ${JSON.stringify(lobbyId)}`);
			}
			if (typeof incident.kind !== "string" || !incident.kind) {
				throw new TypeError(`incidents.raise: kind must be a non-empty string, received ${JSON.stringify(incident.kind)}`);
			}

			const message = String(incident.message ?? "").slice(0, MAX_MESSAGE);
			const record = {
				kind: incident.kind,
				message,
				severity: incident.severity ?? SEVERITY.WARNING,
				detail: incident.detail,
				suggestedFix: incident.suggestedFix,
			};

			if (!byLobby.has(lobbyId)) byLobby.set(lobbyId, []);
			const list = byLobby.get(lobbyId);

			const key = fingerprint(record);
			const existing = list.find((i) => !i.resolved && fingerprint(i) === key);

			let stored;
			if (existing) {
				existing.count += 1;
				existing.lastAt = now();
				stored = existing;
			} else {
				stored = {
					id: randomUUID(),
					...record,
					at: now(),
					lastAt: now(),
					count: 1,
					resolved: false,
					resolution: null,
				};
				list.push(stored);
				if (list.length > capacity) list.shift();
			}

			// A broken admin socket must not take down the failure handler that is
			// reporting to it.
			try { notify(lobbyId, stored); } catch { /* reporting is best-effort */ }

			return stored;
		},

		/**
		 * @description Every incident recorded for a lobby, oldest first.
		 * @param {string} lobbyId - The lobby.
		 * @returns {Array<object>} The incidents, possibly empty.
		 */
		list(lobbyId) {
			return byLobby.get(lobbyId) ?? [];
		},

		/**
		 * @description Only the incidents still awaiting attention.
		 * @param {string} lobbyId - The lobby.
		 * @returns {Array<object>} Unresolved incidents.
		 */
		unresolved(lobbyId) {
			return (byLobby.get(lobbyId) ?? []).filter((i) => !i.resolved);
		},

		/**
		 * @description Marks an incident handled. The record is kept rather than deleted,
		 *   so the history of what went wrong and what was done about it survives.
		 * @param {string} lobbyId - The lobby.
		 * @param {string} id - The incident id.
		 * @param {string} [resolution] - What was done.
		 * @returns {boolean} `true` if an incident was marked, `false` if none matched.
		 */
		resolve(lobbyId, id, resolution = "") {
			const found = (byLobby.get(lobbyId) ?? []).find((i) => i.id === id);
			if (!found) return false;
			found.resolved = true;
			found.resolution = resolution;
			return true;
		},

		/**
		 * @description Forgets a lobby's incidents, for when the lobby itself is gone.
		 * @param {string} lobbyId - The lobby.
		 * @returns {void}
		 */
		clear(lobbyId) {
			byLobby.delete(lobbyId);
		},
	};
}
