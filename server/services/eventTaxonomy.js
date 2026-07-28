/**
 * Event taxonomy — classifies each broadcast event as durable, ephemeral, or a
 * full snapshot, which decides what may be sequenced and what may be replayed.
 *
 * The distinction exists because replaying an event to a reconnecting client is
 * only ever correct for events that describe *state*. Replaying a countdown, an
 * audio chunk, or a sound effect is actively wrong: the moment they described has
 * passed. Sequencing follows the same split — ephemeral events deliberately carry
 * no sequence number, so a client that misses one never mistakes it for a gap and
 * never asks for a replay that would be meaningless to deliver.
 */

/** State-bearing; replayed in order when a client reconnects with a gap. */
export const DURABLE = "durable";

/** Moment-bound; never replayed, never sequenced. */
export const EPHEMERAL = "ephemeral";

/** A complete state document; sequenced so a client learns where to resume, but
 *  never replayed, because only the newest snapshot has any meaning. */
export const SNAPSHOT = "snapshot";

/**
 * Explicit classification for every event the server broadcasts to a lobby room.
 * Targeted single-socket emits (`player:levelup`, `join:confirmed`, `lobby:created`,
 * and similar) are absent by design: they address one recipient, so replaying them
 * into a room would disclose one player's private state to everybody.
 */
export const EVENT_CLASSES = {
	// ── Full state ──
	"state:update": SNAPSHOT,

	// ── Story content ──
	"narration": DURABLE,
	"action:log": DURABLE,
	"adventure:name": DURABLE,

	// ── Character and party state ──
	"hp:update": DURABLE,
	"xp:update": DURABLE,
	"gold:update": DURABLE,
	"inventory:update": DURABLE,
	"conditions:update": DURABLE,
	"spellslots:update": DURABLE,
	"abilities:update": DURABLE,
	"party:update": DURABLE,

	// ── Flow control the player cannot afford to miss ──
	"turn:update": DURABLE,
	"roll:required": DURABLE,
	"turn:skipped": DURABLE,
	"player:death": DURABLE,
	"player:joined": DURABLE,
	"player:left": DURABLE,
	"game:over": DURABLE,

	// ── Scene state that publicState() does not carry, so a missed event is
	//    otherwise unrecoverable over the socket ──
	"map:update": DURABLE,
	"suggestions:update": DURABLE,

	// ── Recoverable from a snapshot, so replaying is needless and disruptive ──
	// currentMusic is already carried by publicState() and the client re-requests
	// the mood on every state:update, so a replayed change would only restart a
	// track that is already playing correctly.
	"music:change": EPHEMERAL,
	// The roll feed and its log line are purely visual; the outcome that matters
	// reaches the client through the narration and history instead. A duplicated
	// roll reads as a second roll, which is worse than a missing feed entry.
	"dice:result": EPHEMERAL,

	// ── Rest voting ──
	"rest:vote:start": DURABLE,
	"rest:vote:update": DURABLE,
	"rest:vote:result": DURABLE,

	// ── Streamed audio: bound to a live playback session ──
	"narration:start": EPHEMERAL,
	"narration:audio": EPHEMERAL,
	"narration:audio:end": EPHEMERAL,
	"narration:alignment": EPHEMERAL,

	// ── Countdowns: a replayed deadline is a wrong deadline ──
	"timer:start": EPHEMERAL,
	"timer:pending": EPHEMERAL,
	"timer:cancel": EPHEMERAL,

	// ── Transient interface signals ──
	"ui:lock": EPHEMERAL,
	"ui:unlock": EPHEMERAL,
	"toast": EPHEMERAL,
	"sfx:play": EPHEMERAL,

	// ── Diagnostics and cross-lobby chatter ──
	// These two carry the DM's raw JSON — hidden DCs and full enemy stat blocks —
	// and are addressed to the admin room, never to players. They stay classified
	// here because the taxonomy is consulted by name regardless of audience.
	"debug:llm": EPHEMERAL,
	"debug:setup": EPHEMERAL,
	"lobbies:update": EPHEMERAL,
	"game:starting": EPHEMERAL,
	"game:ready": EPHEMERAL,
	"chat:typing": EPHEMERAL,
};

/**
 * @description Asserts that an event name is usable as a table key.
 * @param {string} event - The candidate event name.
 * @param {string} fn - The calling function, used in the error message.
 * @returns {void}
 * @throws {TypeError} If `event` is not a non-empty string.
 */
function assertEventName(event, fn) {
	if (typeof event !== "string" || !event) {
		throw new TypeError(`${fn}: event must be a non-empty string, received ${JSON.stringify(event)}`);
	}
}

/**
 * @description Returns the class of an event. An unrecognised name is treated as
 *   durable rather than ephemeral, deliberately: this system's failure mode is
 *   silent desync, so a newly added event that nobody remembered to classify should
 *   fail toward being delivered. The cost of guessing wrong is a redundant state
 *   application on reconnect, which the client applies idempotently; the cost of the
 *   opposite default is the invisible drift this whole mechanism exists to prevent.
 * @param {string} event - The socket event name.
 * @returns {DURABLE|EPHEMERAL|SNAPSHOT} The event's class.
 * @throws {TypeError} If `event` is not a non-empty string.
 */
export function classifyEvent(event) {
	assertEventName(event, "classifyEvent");
	return EVENT_CLASSES[event] ?? DURABLE;
}

/**
 * @description Reports whether an event should be stamped with a sequence number.
 *   Ephemeral events are excluded so that missing one never presents as a gap.
 * @param {string} event - The socket event name.
 * @returns {boolean} `true` for durable events and snapshots.
 * @throws {TypeError} If `event` is not a non-empty string.
 */
export function isSequenced(event) {
	assertEventName(event, "isSequenced");
	return classifyEvent(event) !== EPHEMERAL;
}

/**
 * @description Reports whether an event may be re-delivered to a client that missed
 *   it. Snapshots are excluded: a client recovering a gap is sent the current
 *   snapshot directly, so replaying superseded ones would only undo newer state.
 * @param {string} event - The socket event name.
 * @returns {boolean} `true` only for durable events.
 * @throws {TypeError} If `event` is not a non-empty string.
 */
export function isReplayable(event) {
	assertEventName(event, "isReplayable");
	return classifyEvent(event) === DURABLE;
}
