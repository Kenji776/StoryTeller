/**
 * onceOnly — answer a re-delivered durable event exactly once.
 *
 * `eventTaxonomy.js` marks several events DURABLE, and the sequenced bus
 * ([ADR 0004](../../../docs/decisions/0004-sequenced-event-bus-and-durable-sessions.md))
 * re-delivers those so a reconnecting client cannot miss one. A simulated player that
 * answers every delivery therefore answers the same prompt repeatedly.
 *
 * That is not theoretical. `roll:required` is durable, and a screen run turned 12
 * player actions into **191 DM calls** because the roll handler resubmitted the same
 * roll on every redelivery — sixteen times for one request. It burns money, it stalls
 * the run, and worst of all it inflates the transcript the model is then graded on.
 *
 * Fails **open**: when a delivery cannot be identified, it is answered. A duplicate
 * answer is wasteful; a dropped `roll:required` deadlocks the table forever, because
 * nothing else schedules a turn timer on that path.
 */

/** Default ledger size. Comfortably more than a long game's durable events. */
const DEFAULT_LIMIT = 512;

/**
 * Builds a ledger that reports whether a delivery is the first of its kind.
 *
 * @description Prefers the bus's own sequence number, which is exactly what makes a
 *   redelivery identifiable. Where there is none, it falls back to the payload's
 *   content, serialised with sorted keys so a reserialised payload is not mistaken for
 *   a new request.
 * @param {object} [options] - Options.
 * @param {number} [options.limit=512] - Maximum remembered deliveries. The oldest are
 *   evicted first, so the newest — the ones a redelivery would repeat — stay protected.
 * @returns {{claim: Function, size: Function}} The ledger. `claim` returns true the
 *   first time it sees a delivery and false thereafter.
 */
export function createOnceOnly({ limit = DEFAULT_LIMIT } = {}) {
	const seen = new Set();

	/**
	 * @description Serialises a value with sorted keys, so key order cannot make one
	 *   request look like two.
	 * @param {*} value - Any payload.
	 * @returns {string|null} A stable string, or null when it cannot be serialised.
	 */
	function stableKey(value) {
		if (value === undefined) return "";
		try {
			return JSON.stringify(value, (_k, v) => {
				if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
				return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
			});
		} catch {
			return null;   // cyclic or otherwise unserialisable
		}
	}

	return {
		/**
		 * @description Claims one delivery, reporting whether it should be acted on.
		 * @param {string} [event] - The event name.
		 * @param {object} [meta] - The bus metadata; `meta.seq` identifies a redelivery.
		 * @param {*} [payload] - The event payload, used only when there is no sequence.
		 * @returns {boolean} True when this delivery has not been seen before.
		 */
		claim(event, meta, payload) {
			const name = typeof event === "string" ? event : "(unnamed)";
			// Zero is a real sequence number, so the check is for finiteness rather
			// than truthiness — `if (meta.seq)` would answer seq 0 forever.
			const seq = Number.isFinite(meta?.seq) ? meta.seq : null;
			let key;
			if (seq !== null) {
				key = `${name}#${seq}`;
			} else {
				const body = stableKey(payload);
				if (body === null) return true;    // unidentifiable: fail open
				key = `${name}|${body}`;
			}

			if (seen.has(key)) return false;
			seen.add(key);
			// Sets iterate in insertion order, so the first key is the oldest.
			while (seen.size > limit) seen.delete(seen.values().next().value);
			return true;
		},

		/** @description Reports how many deliveries are remembered. @returns {number} The size. */
		size() { return seen.size; },
	};
}
