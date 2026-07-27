/**
 * EventJournal — assigns each lobby a monotonic event sequence and retains a
 * bounded window of recent events so a client that missed some can replay them.
 *
 * Socket.IO does not buffer room broadcasts for a member that is momentarily
 * disconnected, so any event emitted during a network blip is lost with no trace.
 * Stamping every state-changing broadcast with a per-lobby sequence number lets a
 * client notice the gap (it received seq N+2 while holding N) and ask for the
 * missing range instead of silently diverging.
 *
 * Retention is deliberately bounded: a lobby can run for hours and the journal is
 * a recovery aid for short outages, not an event store. A client whose gap has
 * already been evicted is told so explicitly and falls back to a full snapshot,
 * which is always correct if more expensive.
 */

const DEFAULT_CAPACITY = 256;

export class EventJournal {
	/**
	 * @description Creates an empty journal. The clock is injected rather than read
	 *   from `Date.now` directly so that tests are deterministic (`CQ-5`, `TDD-8`).
	 * @param {object} [options] - Construction options.
	 * @param {number} [options.capacity=256] - Events retained per lobby before the
	 *   oldest are evicted. Sized to comfortably cover a multi-minute outage.
	 * @param {function(): number} [options.now=Date.now] - Millisecond clock source.
	 * @throws {TypeError} If `capacity` is not an integer of at least 1.
	 */
	constructor({ capacity = DEFAULT_CAPACITY, now = Date.now } = {}) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new TypeError(`EventJournal: capacity must be an integer >= 1, received ${capacity}`);
		}
		this.capacity = capacity;
		this.now = now;
		/** @type {Map<string, {nextSeq: number, buffer: Array<object>}>} */
		this.lobbies = new Map();
	}

	/**
	 * @description Returns the mutable per-lobby record, creating it on first use.
	 * @param {string} lobbyId - The lobby to look up.
	 * @returns {{nextSeq: number, buffer: Array<object>}} The lobby's journal slot.
	 */
	_slot(lobbyId) {
		let slot = this.lobbies.get(lobbyId);
		if (!slot) {
			slot = { nextSeq: 1, buffer: [] };
			this.lobbies.set(lobbyId, slot);
		}
		return slot;
	}

	/**
	 * @description Stamps an event with the lobby's next sequence number and retains
	 *   it for replay. The payload is deep-copied so that later mutation by the caller
	 *   — a real risk given the server mutates lobby objects in place — cannot
	 *   retroactively rewrite what a reconnecting client is told happened.
	 * @param {string} lobbyId - The lobby the event belongs to.
	 * @param {string} event - The socket event name, e.g. `"hp:update"`.
	 * @param {object} payload - The event payload. Must be structured-cloneable,
	 *   which every Socket.IO payload already has to be.
	 * @returns {{seq: number, event: string, payload: object, at: number}} The sealed
	 *   envelope, ready to broadcast.
	 * @throws {TypeError} If `lobbyId` is not a non-empty string.
	 * @throws {TypeError} If `event` is not a non-empty string.
	 * @throws {DOMException} If `payload` cannot be structured-cloned.
	 */
	record(lobbyId, event, payload) {
		if (typeof lobbyId !== "string" || !lobbyId) {
			throw new TypeError(`EventJournal.record: lobbyId must be a non-empty string, received ${JSON.stringify(lobbyId)}`);
		}
		if (typeof event !== "string" || !event) {
			throw new TypeError(`EventJournal.record: event must be a non-empty string, received ${JSON.stringify(event)}`);
		}

		const slot = this._slot(lobbyId);
		const envelope = {
			seq: slot.nextSeq++,
			event,
			payload: structuredClone(payload),
			at: this.now(),
		};

		slot.buffer.push(envelope);
		if (slot.buffer.length > this.capacity) slot.buffer.shift();

		return envelope;
	}

	/**
	 * @description Returns every retained event newer than `afterSeq`, or explains why
	 *   it cannot. Two failures are possible and they need different client responses:
	 *   `"gap_too_old"` means the client was away longer than the journal retains, and
	 *   `"ahead"` means the client holds sequence numbers this journal never issued —
	 *   which is what a server restart looks like, since the journal is in-memory only.
	 *   Both are resolved by the client requesting a full snapshot.
	 * @param {string} lobbyId - The lobby to replay.
	 * @param {number} afterSeq - The highest sequence the caller has already applied;
	 *   `0` means it has seen nothing.
	 * @returns {{ok: true, events: Array<object>, latestSeq: number}
	 *   | {ok: false, reason: "gap_too_old"|"ahead", latestSeq: number, oldestSeq: number}}
	 *   The replayable events, or the reason a replay is impossible.
	 * @throws {TypeError} If `afterSeq` is not a non-negative integer.
	 */
	since(lobbyId, afterSeq) {
		if (!Number.isInteger(afterSeq) || afterSeq < 0) {
			throw new TypeError(`EventJournal.since: afterSeq must be an integer >= 0, received ${JSON.stringify(afterSeq)}`);
		}

		const slot = this.lobbies.get(lobbyId);
		const latestSeq = slot ? slot.nextSeq - 1 : 0;

		// The caller claims to have seen events this journal never issued. Its
		// sequence numbers belong to a previous process; nothing here can reconcile them.
		if (afterSeq > latestSeq) {
			return { ok: false, reason: "ahead", latestSeq, oldestSeq: slot?.buffer[0]?.seq ?? 0 };
		}

		if (afterSeq === latestSeq) return { ok: true, events: [], latestSeq };

		const oldestSeq = slot.buffer[0].seq;
		// The very next event the caller needs must still be retained, otherwise
		// replaying what is left would skip changes and leave it quietly wrong.
		if (afterSeq + 1 < oldestSeq) {
			return { ok: false, reason: "gap_too_old", latestSeq, oldestSeq };
		}

		return {
			ok: true,
			events: slot.buffer.filter((e) => e.seq > afterSeq),
			latestSeq,
		};
	}

	/**
	 * @description Returns the most recent sequence number issued for a lobby, which a
	 *   client stores alongside a full snapshot so it knows where to resume from.
	 * @param {string} lobbyId - The lobby to query.
	 * @returns {number} The latest sequence, or `0` if the lobby has recorded nothing.
	 */
	latestSeq(lobbyId) {
		const slot = this.lobbies.get(lobbyId);
		return slot ? slot.nextSeq - 1 : 0;
	}

	/**
	 * @description Forgets a lobby completely, releasing its retained events. Called
	 *   when a lobby is deleted; a lobby that is merely hibernating keeps its journal
	 *   so returning players can still replay.
	 * @param {string} lobbyId - The lobby to forget.
	 * @returns {void}
	 */
	drop(lobbyId) {
		this.lobbies.delete(lobbyId);
	}
}
