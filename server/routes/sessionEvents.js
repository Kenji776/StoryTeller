/**
 * sessionEvents — reconnection: durable player identity, a disconnect grace
 * window, and catching a returning client up on what it missed.
 *
 * The problem this exists to solve: Socket.IO issues a new socket id on every
 * reconnect, while lobby membership, room membership and turn order are all keyed
 * to the old one. A player whose connection blipped came back in no room at all —
 * receiving nothing, their actions answered with "Unknown player" — while the rest
 * of the party had been told they left and their name had been pulled from the
 * initiative order. Nothing on their screen changed, so they had no way to know.
 *
 * Two changes fix it. A session token, issued once and presented on reconnect,
 * gives the server a name for the player that outlives the transport. And a
 * disconnect no longer means "gone": the session enters a grace window during
 * which it keeps its character and its place in the order, so the overwhelmingly
 * common case — a brief drop nobody noticed — costs nothing at all.
 */

/**
 * @description Creates the session subsystem.
 * @param {object} deps - Injected collaborators.
 * @param {import('socket.io').Server} deps.io - Socket.IO server.
 * @param {object} deps.store - The LobbyStore.
 * @param {function(string): string} deps.room - lobbyId → room name.
 * @param {function(...*): void} deps.log - Logger.
 * @param {import('../services/playerSessions.js').PlayerSessions} deps.sessions - Session registry.
 * @param {object} deps.bus - The lobby bus, for sequence numbers and replay.
 * @param {function(string): object} deps.resolveActiveTurn - Resolves the active turn.
 * @param {function(string, number=): void} deps.startTurnTimer - Starts the turn clock.
 * @param {function(string): void} deps.cancelTurnTimer - Cancels the turn clock.
 * @param {function(): void} deps.broadcastLobbies - Refreshes the public lobby list.
 * @returns {{registerSessionEvents: Function, openSession: Function,
 *   handleDisconnecting: Function, sweep: Function}} The subsystem.
 */
export function createSessionSystem({ io, store, room, log, sessions, bus, resolveActiveTurn, startTurnTimer, cancelTurnTimer, broadcastLobbies }) {
	/**
	 * @description Registers a player's session and hands them the token they will
	 *   present if they reconnect. Also sends the current sequence number, so the
	 *   client knows where its watermark starts and can detect the very first gap.
	 * @param {string} lobbyId - The lobby.
	 * @param {string} playerName - The character they are playing.
	 * @param {object} socket - Their socket.
	 * @returns {{token: string}|null} The issued session, or `null` if the seat was
	 *   already claimed by a live connection.
	 */
	function openSession(lobbyId, playerName, socket) {
		// A reconnect that arrives before the old session expired would otherwise be
		// refused its own seat, so adopt the existing session instead of failing.
		const held = sessions.byPlayer(lobbyId, playerName);
		if (held) {
			sessions.rebind(held.token, socket.id);
			socket.emit("session:token", { token: held.token, lobbyId, seq: bus.seqOf(lobbyId), epoch: bus.epoch });
			return { token: held.token };
		}

		const opened = sessions.open(lobbyId, playerName, socket.id);
		if (!opened.ok) {
			log(`⚠️ Could not open a session for ${playerName} in ${lobbyId}: ${opened.reason}`);
			return null;
		}

		socket.emit("session:token", { token: opened.token, lobbyId, seq: bus.seqOf(lobbyId), epoch: bus.epoch });
		log(`🔑 Session issued to ${playerName} in ${lobbyId}`);
		return { token: opened.token };
	}

	/**
	 * @description Re-establishes a returning player: rebinds the session to the new
	 *   socket, puts them back in the room and the lobby's socket registry, clears the
	 *   disconnected flag, restores their seat in the turn order if the grace already
	 *   lapsed, and sends a full snapshot.
	 * @param {object} socket - The reconnected socket.
	 * @param {string} token - The token issued when the session opened.
	 * @returns {void}
	 */
	function resume(socket, token) {
		if (typeof token !== "string" || !token) {
			return socket.emit("session:resumed", { ok: false, reason: "no_token" });
		}

		const bound = sessions.rebind(token, socket.id);
		if (!bound.ok) {
			// Expired or never issued. The client falls back to the explicit rejoin
			// flow, which verifies character ownership properly.
			return socket.emit("session:resumed", { ok: false, reason: bound.reason });
		}

		const { lobbyId, playerName } = bound.session;
		const lobby = store.index[lobbyId];
		if (!lobby) return socket.emit("session:resumed", { ok: false, reason: "lobby_gone" });

		socket.join(room(lobbyId));

		// Re-key the socket registry: drop any record for sockets this session has
		// outlived, then register the live one.
		for (const [sid, rec] of Object.entries(lobby.sockets || {})) {
			if (rec?.playerName === playerName && sid !== socket.id) delete lobby.sockets[sid];
		}
		lobby.sockets[socket.id] = { ...(lobby.sockets[socket.id] || {}), playerName };

		if (lobby.players?.[playerName]) delete lobby.players[playerName].disconnected;

		// If the grace lapsed before they made it back, their seat was released.
		if (Array.isArray(lobby.initiative) && !lobby.initiative.includes(playerName) && lobby.players?.[playerName]) {
			store.insertIntoInitiative(lobbyId, playerName);
			log(`↩️ ${playerName} restored to the turn order in ${lobbyId}`);
		}

		store.persist(lobbyId);

		socket.emit("session:resumed", {
			ok: true,
			lobbyId,
			playerName,
			seq: bus.seqOf(lobbyId),
			epoch: bus.epoch,
		});
		socket.emit("state:update", store.publicState(lobbyId));
		io.to(room(lobbyId)).emit("player:reconnected", { player: playerName });

		log(`🔄 ${playerName} resumed in ${lobbyId} on ${socket.id}`);
	}

	/**
	 * @description Handles a socket going away. Starts the grace window rather than
	 *   tearing the player out of the game, and tells the table they are reconnecting
	 *   rather than that they left — which is both kinder and, usually, true.
	 * @param {object} socket - The departing socket.
	 * @returns {void}
	 */
	function handleDisconnecting(socket) {
		const session = sessions.markDisconnected(socket.id);
		// Null means this socket owns no session, or has already been superseded by a
		// reconnect. Either way there is nothing to mourn.
		if (!session) return;

		const { lobbyId, playerName } = session;
		const lobby = store.index[lobbyId];
		if (!lobby) return;

		if (lobby.players?.[playerName]) lobby.players[playerName].disconnected = true;
		store.persist(lobbyId);

		io.to(room(lobbyId)).emit("player:reconnecting", { player: playerName });
		log(`⏳ ${playerName} dropped in ${lobbyId} — holding their seat`);
	}

	/**
	 * @description Reclaims sessions whose grace has fully elapsed, performing the
	 *   visible consequences the registry deliberately knows nothing about: releasing
	 *   the seat, announcing the departure, and moving the turn on if it was theirs.
	 * @returns {number} How many players were released.
	 */
	function sweep() {
		const expired = sessions.sweepExpired();
		for (const { lobbyId, playerName } of expired) {
			const lobby = store.index[lobbyId];
			if (!lobby) continue;

			const wasTheirTurn = store.turnInfo(lobbyId).current === playerName;

			store.removeFromTurnOrder(lobbyId, playerName);
			io.to(room(lobbyId)).emit("player:left", { player: playerName });

			if (wasTheirTurn) {
				cancelTurnTimer(lobbyId);
				resolveActiveTurn(lobbyId);
				io.to(room(lobbyId)).emit("turn:update", store.turnInfo(lobbyId));
				startTurnTimer(lobbyId);
			}

			store.persist(lobbyId);
			log(`👋 ${playerName} released from ${lobbyId} — grace expired`);
		}
		if (expired.length) broadcastLobbies();
		return expired.length;
	}

	/**
	 * @description Registers the session-related handlers on a connecting socket.
	 * @param {object} socket - The socket to wire.
	 * @returns {void}
	 */
	function registerSessionEvents(socket) {
		socket.on("session:resume", ({ token } = {}) => resume(socket, token));

		// Answered through an acknowledgement callback rather than a reply event, so
		// the client gets request/response correlation and a timeout for free, and the
		// replayed events never pass through the client's own gap detector.
		socket.on("sync:request", ({ lobbyId, haveSeq, haveEpoch } = {}, ack) => {
			if (typeof ack !== "function") return;
			try {
				if (!lobbyId || !store.index[lobbyId]) return ack({ mode: "denied", reason: "unknown_lobby" });
				ack(bus.sliceSince(lobbyId, haveSeq, haveEpoch));
			} catch (err) {
				log(`⚠️ sync:request failed for ${lobbyId}: ${err.message}`);
				ack({ mode: "denied", reason: "bad_request" });
			}
		});
	}

	return { registerSessionEvents, openSession, handleDisconnecting, sweep };
}
