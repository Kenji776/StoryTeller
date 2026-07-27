/**
 * PlayerSessions — durable player identity that survives a changing socket id.
 *
 * Socket.IO issues a brand-new socket id on every reconnect. Because lobby
 * membership, turn order and host status are all keyed by socket id, a two-second
 * network blip currently orphans the old record, drops the player from their room,
 * and removes them from the turn order — while their browser shows no sign that
 * anything happened. A session token, handed to the client once and presented on
 * every reconnect, gives the server a stable name for a player that outlives the
 * transport.
 *
 * A disconnect therefore does not immediately mean "gone". A session enters a grace
 * window during which it still holds its character and its place in the turn order,
 * so the overwhelmingly common case — a brief drop the player never even notices —
 * costs nothing. Only when the grace window lapses is the seat genuinely released.
 */

import { randomUUID } from "crypto";

/**
 * Long enough to cover a wifi handover, a tunnel, or a phone changing cell — the
 * outages players do not think of as leaving — while staying well inside a turn
 * timer (default 3 minutes) so a player who has truly gone does not stall the table.
 */
const DEFAULT_GRACE_MS = 90_000;

/** Bound to a live socket. */
const ACTIVE = "active";

/** Disconnected, seat still held, waiting to see whether they come back. */
const GRACE = "grace";


export class PlayerSessions {
	/**
	 * @description Creates an empty registry. The clock and the token generator are
	 *   injected so tests can drive expiry deterministically instead of sleeping
	 *   (`CQ-5`, `TDD-8`).
	 * @param {object} [options] - Construction options.
	 * @param {number} [options.graceMs=90000] - How long a disconnected session keeps
	 *   its seat before being reclaimed.
	 * @param {function(): number} [options.now=Date.now] - Millisecond clock source.
	 * @param {function(): string} [options.newToken=randomUUID] - Session token factory.
	 * @throws {TypeError} If `graceMs` is not an integer of at least 1.
	 */
	constructor({ graceMs = DEFAULT_GRACE_MS, now = Date.now, newToken = randomUUID } = {}) {
		if (!Number.isInteger(graceMs) || graceMs < 1) {
			throw new TypeError(`PlayerSessions: graceMs must be an integer >= 1, received ${graceMs}`);
		}
		this.graceMs = graceMs;
		this.now = now;
		this.newToken = newToken;

		/** @type {Map<string, object>} token → session */
		this.sessions = new Map();
		/** @type {Map<string, string>} socketId → token */
		this.socketIndex = new Map();
		/** @type {Map<string, string>} JSON-encoded [lobbyId, playerName] → token */
		this.playerIndex = new Map();
	}

	/**
	 * @description Builds the composite key for the lobby+player index. Encoded as a
	 *   JSON array rather than joined with a separator character: spaces, colons and
	 *   punctuation are all legal in a character name, so any printable separator
	 *   would let one lobby+player pair collide with a differently-split one, and a
	 *   non-printable one is invisible to whoever reads this next.
	 * @param {string} lobbyId - The lobby.
	 * @param {string} playerName - The character name.
	 * @returns {string} The index key.
	 */
	_key(lobbyId, playerName) {
		return JSON.stringify([lobbyId, playerName]);
	}

	/**
	 * @description Asserts a value is a non-empty string.
	 * @param {*} value - The candidate.
	 * @param {string} name - Parameter name, used in the error message.
	 * @param {string} fn - Calling function, used in the error message.
	 * @returns {void}
	 * @throws {TypeError} If `value` is not a non-empty string.
	 */
	_assertString(value, name, fn) {
		if (typeof value !== "string" || !value) {
			throw new TypeError(`PlayerSessions.${fn}: ${name} must be a non-empty string, received ${JSON.stringify(value)}`);
		}
	}

	/**
	 * @description Registers a player who has identified themselves for the first time
	 *   and returns the token they must present to reconnect. Refuses if the character
	 *   is already claimed, distinguishing a live claim from one merely being held
	 *   through a grace window so the caller can word the refusal usefully — "already
	 *   in use" versus "reconnecting, try again shortly".
	 * @param {string} lobbyId - The lobby being joined.
	 * @param {string} playerName - The character being claimed.
	 * @param {string} socketId - The socket the player is currently on.
	 * @returns {{ok: true, token: string, session: object}
	 *   | {ok: false, reason: "name_active"|"name_in_grace", session: object}}
	 *   The new session, or the conflicting one.
	 * @throws {TypeError} If any argument is not a non-empty string.
	 */
	open(lobbyId, playerName, socketId) {
		this._assertString(lobbyId, "lobbyId", "open");
		this._assertString(playerName, "playerName", "open");
		this._assertString(socketId, "socketId", "open");

		const held = this.byPlayer(lobbyId, playerName);
		if (held) {
			return {
				ok: false,
				reason: held.state === GRACE ? "name_in_grace" : "name_active",
				session: held,
			};
		}

		const token = this.newToken();
		const session = {
			token,
			lobbyId,
			playerName,
			socketId,
			state: ACTIVE,
			connectedAt: this.now(),
			disconnectedAt: null,
		};

		this.sessions.set(token, session);
		this.socketIndex.set(socketId, token);
		this.playerIndex.set(this._key(lobbyId, playerName), token);

		return { ok: true, token, session };
	}

	/**
	 * @description Moves an existing session onto a new socket after a reconnect,
	 *   restoring it to active and clearing any grace. This is what makes a reconnect
	 *   a continuation rather than a new join.
	 * @param {string} token - The token issued by {@link PlayerSessions#open}.
	 * @param {string} socketId - The socket the player has reconnected on.
	 * @returns {{ok: true, session: object} | {ok: false, reason: "unknown_session"}}
	 *   The revived session, or a refusal if the token is unknown or already expired.
	 * @throws {TypeError} If `token` or `socketId` is not a non-empty string.
	 */
	rebind(token, socketId) {
		this._assertString(token, "token", "rebind");
		this._assertString(socketId, "socketId", "rebind");

		const session = this.sessions.get(token);
		if (!session) return { ok: false, reason: "unknown_session" };

		if (session.socketId !== socketId) this.socketIndex.delete(session.socketId);
		this.socketIndex.set(socketId, token);

		session.socketId = socketId;
		session.state = ACTIVE;
		session.disconnectedAt = null;
		session.connectedAt = this.now();

		return { ok: true, session };
	}

	/**
	 * @description Records that a socket has gone away, starting the grace window.
	 *
	 *   Deliberately ignores a socket that no longer owns its session. Socket.IO can
	 *   deliver the teardown for an old socket *after* the client has already
	 *   reconnected on a new one, and treating that late event as a fresh disconnect
	 *   would knock the player straight back out — the exact race that makes flaky
	 *   connections look like random disappearances.
	 * @param {string} socketId - The socket that disconnected.
	 * @returns {object|null} The session now in grace, or `null` if this socket owns
	 *   no session or has already been superseded.
	 */
	markDisconnected(socketId) {
		const token = this.socketIndex.get(socketId);
		if (!token) return null;

		const session = this.sessions.get(token);
		if (!session || session.socketId !== socketId) return null;

		// Already counting down: leave the original timestamp alone so repeated
		// teardown events cannot extend the window indefinitely.
		if (session.state === GRACE) return session;

		session.state = GRACE;
		session.disconnectedAt = this.now();
		return session;
	}

	/**
	 * @description Reclaims every session whose grace window has fully elapsed. The
	 *   caller is handed the lapsed sessions so it can perform the visible
	 *   consequences — removing the player from the turn order, announcing that they
	 *   left, releasing their character — which this registry deliberately knows
	 *   nothing about.
	 * @returns {Array<object>} The sessions that were reclaimed, possibly empty.
	 */
	sweepExpired() {
		const cutoff = this.now() - this.graceMs;
		const expired = [];

		for (const session of this.sessions.values()) {
			if (session.state !== GRACE) continue;
			if (session.disconnectedAt > cutoff) continue;
			expired.push(session);
		}

		for (const session of expired) this._forget(session);
		return expired;
	}

	/**
	 * @description Removes a session from every index.
	 * @param {object} session - The session to forget.
	 * @returns {void}
	 */
	_forget(session) {
		this.sessions.delete(session.token);
		this.playerIndex.delete(this._key(session.lobbyId, session.playerName));
		if (this.socketIndex.get(session.socketId) === session.token) {
			this.socketIndex.delete(session.socketId);
		}
	}

	/**
	 * @description Finds the session currently bound to a socket.
	 * @param {string} socketId - The socket to resolve.
	 * @returns {object|null} The session, or `null` if the socket owns none.
	 */
	bySocket(socketId) {
		const token = this.socketIndex.get(socketId);
		return token ? this.sessions.get(token) ?? null : null;
	}

	/**
	 * @description Finds a session by the token the client presents on reconnect.
	 * @param {string} token - The session token.
	 * @returns {object|null} The session, or `null` if unknown or expired.
	 */
	byToken(token) {
		return this.sessions.get(token) ?? null;
	}

	/**
	 * @description Finds the session holding a character, whether active or in grace.
	 *   A session in grace still counts as holding the seat.
	 * @param {string} lobbyId - The lobby.
	 * @param {string} playerName - The character name.
	 * @returns {object|null} The holding session, or `null` if the seat is free.
	 */
	byPlayer(lobbyId, playerName) {
		const token = this.playerIndex.get(this._key(lobbyId, playerName));
		return token ? this.sessions.get(token) ?? null : null;
	}

	/**
	 * @description Lists every session in a lobby, for the admin connection view —
	 *   which is the only place the difference between "active" and "quietly in grace"
	 *   is currently visible to a human.
	 * @param {string} lobbyId - The lobby to report on.
	 * @returns {Array<object>} The lobby's sessions, possibly empty.
	 */
	listLobby(lobbyId) {
		const out = [];
		for (const session of this.sessions.values()) {
			if (session.lobbyId === lobbyId) out.push(session);
		}
		return out;
	}

	/**
	 * @description Ends a session immediately without waiting for grace, for a
	 *   deliberate departure such as a kick or a player leaving on purpose.
	 * @param {string} token - The session to end.
	 * @returns {boolean} `true` if a session was removed, `false` if none matched.
	 */
	close(token) {
		const session = this.sessions.get(token);
		if (!session) return false;
		this._forget(session);
		return true;
	}

	/**
	 * @description Drops every session belonging to a lobby, for when the lobby itself
	 *   is deleted.
	 * @param {string} lobbyId - The lobby being torn down.
	 * @returns {number} How many sessions were removed.
	 */
	dropLobby(lobbyId) {
		const doomed = this.listLobby(lobbyId);
		for (const session of doomed) this._forget(session);
		return doomed.length;
	}
}
