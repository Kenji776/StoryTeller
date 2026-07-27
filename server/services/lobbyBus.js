/**
 * LobbyBus — the single writer for every lobby-room broadcast.
 *
 * Today ~90 call sites reach for `io.to(room(lobbyId)).emit(...)` directly, which
 * is why no client can tell it missed something: nothing stamps a broadcast with
 * anything a receiver could check. Routing every broadcast through one place buys
 * the sequence number, the replay journal, and a single truthful answer to "what
 * did this client miss?".
 *
 * The envelope rides as a *third* emit argument rather than inside the payload.
 * Socket.IO passes extra arguments through untouched, so the existing handlers —
 * all written as `socket.on("turn:update", ({ current, order }) => ...)` — keep
 * working unchanged and adopting the bus stays a mechanical substitution.
 */

import { classifyEvent, isSequenced, isReplayable, SNAPSHOT } from "./eventTaxonomy.js";

/**
 * Marks a journal entry as standing in for a snapshot whose payload was too bulky
 * to retain. `state:update` carries the whole story history, so keeping 256 of them
 * would dwarf everything else in memory.
 */
const SNAPSHOT_TOMBSTONE = { __snapshot: true };

/**
 * @description Creates the broadcast bus for a server instance.
 * @param {object} deps - Injected collaborators.
 * @param {import('socket.io').Server} deps.io - Socket.IO server; only `.to().emit()` is used.
 * @param {import('./eventJournal.js').EventJournal} deps.journal - Sequencer and replay buffer.
 * @param {number} deps.epoch - Identifies this server process. A client seeing a
 *   different epoch than it holds knows the sequence counter restarted and that a
 *   snapshot, not a replay, is the only sound recovery.
 * @param {function(string): object} deps.buildSnapshot - Returns the full public state
 *   for a lobby. Must be synchronous so the snapshot and its watermark are captured
 *   without an intervening await.
 * @returns {{emit: Function, seqOf: Function, sliceSince: Function, dropLobby: Function, epoch: number}}
 *   The bus.
 * @throws {TypeError} If `buildSnapshot` is not a function.
 */
export function createLobbyBus({ io, journal, epoch, buildSnapshot }) {
	if (typeof buildSnapshot !== "function") {
		throw new TypeError("createLobbyBus: buildSnapshot must be a function");
	}

	/**
	 * @description Builds a snapshot response. The watermark and the state are read in
	 *   one synchronous expression, so no event can be emitted between them. That is
	 *   what lets a client safely discard anything at or below `seq`: a broadcast still
	 *   in flight when this was built necessarily carries a lower sequence.
	 * @param {string} lobbyId - The lobby to snapshot.
	 * @returns {{mode: "snapshot", epoch: number, seq: number, state: object}} The response.
	 */
	function snapshotResponse(lobbyId) {
		return {
			mode: "snapshot",
			epoch,
			seq: journal.latestSeq(lobbyId),
			state: buildSnapshot(lobbyId),
		};
	}

	return {
		epoch,

		/**
		 * @description Broadcasts an event to a lobby room, sequencing and journaling it
		 *   unless its class says otherwise. Ephemeral events go out bare: they are
		 *   deliberately excluded from the sequence so that missing one never presents to
		 *   a client as a gap, and never provokes a replay that would be meaningless — a
		 *   re-delivered countdown or sound effect describes a moment that has passed.
		 * @param {string} lobbyId - The lobby room to broadcast into.
		 * @param {string} event - The socket event name.
		 * @param {object} payload - The event payload.
		 * @returns {{lid: string, seq: number, epoch: number, ts: number}|null} The envelope
		 *   that was attached, or `null` for an ephemeral event.
		 * @throws {TypeError} If `lobbyId` or `event` is not a non-empty string.
		 */
		emit(lobbyId, event, payload) {
			if (typeof lobbyId !== "string" || !lobbyId) {
				throw new TypeError(`lobbyBus.emit: lobbyId must be a non-empty string, received ${JSON.stringify(lobbyId)}`);
			}
			if (typeof event !== "string" || !event) {
				throw new TypeError(`lobbyBus.emit: event must be a non-empty string, received ${JSON.stringify(event)}`);
			}

			if (!isSequenced(event)) {
				io.to(lobbyId).emit(event, payload);
				return null;
			}

			// A snapshot occupies a sequence number but is stored as a tombstone: it is
			// never replayed, and retaining full history payloads would bloat the journal.
			const retained = classifyEvent(event) === SNAPSHOT ? SNAPSHOT_TOMBSTONE : payload;
			const entry = journal.record(lobbyId, event, retained);

			const meta = { lid: lobbyId, seq: entry.seq, epoch, ts: entry.at };
			io.to(lobbyId).emit(event, payload, meta);
			return meta;
		},

		/**
		 * @description Returns the latest sequence issued for a lobby.
		 * @param {string} lobbyId - The lobby to query.
		 * @returns {number} The latest sequence, or `0` if nothing has been sequenced.
		 */
		seqOf(lobbyId) {
			return journal.latestSeq(lobbyId);
		},

		/**
		 * @description Decides how a client that holds `haveSeq` should be brought current,
		 *   and returns everything needed to do it.
		 *
		 *   A replay is offered only when it is provably complete. Four situations rule it
		 *   out: a first-time client, a client from a previous server process, a gap older
		 *   than the journal retains, and — subtly — a gap spanning a snapshot. That last
		 *   one matters because `state:update` is the sole carrier of equipment, initiative
		 *   and pinned moments; no delta repeats them, so replaying the deltas around a
		 *   missed snapshot would leave the client confidently wrong.
		 * @param {string} lobbyId - The lobby to reconcile against.
		 * @param {number} haveSeq - The highest sequence the client has applied.
		 * @param {number} haveEpoch - The epoch the client believes it is synchronised to.
		 * @returns {{mode: "replay", epoch: number, fromSeq: number, toSeq: number, events: Array<object>}
		 *   | {mode: "snapshot", epoch: number, seq: number, state: object}} The recovery instruction.
		 * @throws {TypeError} If `haveSeq` is not a non-negative integer.
		 */
		sliceSince(lobbyId, haveSeq, haveEpoch) {
			if (!Number.isInteger(haveSeq) || haveSeq < 0) {
				throw new TypeError(`lobbyBus.sliceSince: haveSeq must be an integer >= 0, received ${JSON.stringify(haveSeq)}`);
			}

			if (haveSeq === 0 || haveEpoch !== epoch) return snapshotResponse(lobbyId);

			const slice = journal.since(lobbyId, haveSeq);
			if (!slice.ok) return snapshotResponse(lobbyId);

			// Compared by value, not identity: the journal deep-clones what it retains,
			// so the tombstone comes back as a copy rather than the original object.
			if (slice.events.some((e) => e.payload?.__snapshot === true)) {
				return snapshotResponse(lobbyId);
			}

			const events = slice.events
				.filter((e) => isReplayable(e.event))
				.map((e) => ({
					name: e.event,
					payload: e.payload,
					meta: { lid: lobbyId, seq: e.seq, epoch, ts: e.at },
				}));

			return {
				mode: "replay",
				epoch,
				fromSeq: haveSeq + 1,
				toSeq: slice.latestSeq,
				events,
			};
		},

		/**
		 * @description Forgets a deleted lobby's journal.
		 * @param {string} lobbyId - The lobby being torn down.
		 * @returns {void}
		 */
		dropLobby(lobbyId) {
			journal.drop(lobbyId);
		},
	};
}
