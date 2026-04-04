/**
 * chatEvents.js
 * Registers all chat-related socket events for a given socket connection.
 */

/**
 * Registers all chat-related socket event handlers for a single socket connection.
 *
 * Registers the following socket events:
 *  - `chat:join`         – Player joins the chat room for a lobby; emits `chat:history` to the
 *                          joining socket and broadcasts `chat:users` to the room.
 *  - `chat:message`      – Player sends a chat message; persists it and broadcasts `chat:message`
 *                          to the room.
 *  - `chat:updateName`   – Player changes their display name; updates stored history, persists the
 *                          lobby, and broadcasts `chat:nameChange`, `chat:users`,
 *                          `chat:historyUpdate`, and a full lobby state update.
 *  - `chat:users:request`– Client requests the current user list; emits `chat:users` back to the
 *                          requesting socket only.
 *  - `chat:typing`       – Player starts or stops typing; relays `chat:typing` to the rest of the
 *                          room (excluding the sender).
 *
 * @param {import("socket.io").Socket} socket - The individual socket connection to attach handlers to.
 * @param {object} deps - Shared server-side dependencies.
 * @param {import("socket.io").Server} deps.io - The Socket.IO server instance used to broadcast to rooms.
 * @param {object} deps.store - The lobby/session data store with helpers such as
 *   `socketsAdd`, `getChat`, `appendChat`, `getChatUsers`, `persist`, and `index`.
 * @param {function(string): string} deps.room - Returns the Socket.IO room name for a given lobby ID.
 * @param {function(string): void} deps.log - Logging utility for server-side messages.
 * @param {function(string): void} deps.sendState - Broadcasts the full lobby state to all clients
 *   in the specified lobby room.
 * @returns {void}
 */
export function registerChatEvents(socket, deps) {
	const { io, store, room, log, sendState } = deps;

	/**
	 * Handles a player joining the chat room for a lobby.
	 * Adds the socket to the lobby's socket registry, joins the Socket.IO room,
	 * and emits the recent chat history back to the joiner. Broadcasts the
	 * updated user list to everyone in the room.
	 *
	 * @param {object} payload
	 * @param {string} payload.lobbyId - The ID of the lobby being joined.
	 * @param {string} payload.name - The display name of the joining player.
	 * @returns {void}
	 */
	socket.on("chat:join", ({ lobbyId, name }) => {
		if (!store.index[lobbyId]) return;
		store.socketsAdd(lobbyId, socket.id);
		store.index[lobbyId].sockets[socket.id].playerName = name;
		socket.join(room(lobbyId));

		// Send chat history
		const history = store.getChat(lobbyId, 50);
		socket.emit("chat:history", history);

		// Broadcast new user list
		const users = store.getChatUsers(lobbyId);
		io.to(room(lobbyId)).emit("chat:users", users);
		console.log(`💬 ${name} joined chat for lobby ${lobbyId}`);
	});

	/**
	 * Handles an incoming chat message from a player.
	 * Appends the message to the lobby's chat history and broadcasts it to all
	 * clients in the lobby room.
	 *
	 * @param {object} payload
	 * @param {string} payload.lobbyId - The ID of the target lobby.
	 * @param {string} payload.name - The display name of the sender.
	 * @param {string} payload.text - The message body.
	 * @returns {void}
	 */
	socket.on("chat:message", ({ lobbyId, name, text }) => {
		if (!store.index[lobbyId]) return;
		const msg = { name, text, timestamp: Date.now() };
		store.appendChat(lobbyId, name, text);
		io.to(room(lobbyId)).emit("chat:message", msg);
	});

	/**
	 * Handles a player renaming themselves in the chat.
	 * Updates all historical messages authored under the old name, persists the
	 * lobby state, and broadcasts the name change, refreshed user list, updated
	 * chat history, and full lobby state to all clients in the room.
	 *
	 * @param {object} payload
	 * @param {string} payload.lobbyId - The ID of the lobby where the rename occurs.
	 * @param {string} payload.oldName - The player's previous display name.
	 * @param {string} payload.newName - The player's new display name.
	 * @param {string} payload.clientId - The unique client identifier of the renaming player.
	 * @returns {void}
	 */
	socket.on("chat:updateName", ({ lobbyId, oldName, newName, clientId }) => {
		if (!store.index[lobbyId]) return;
		const lobby = store.index[lobbyId];

		log(`💬 chat:updateName: ${oldName} → ${newName}`);

		// Update chat history messages authored under the old name
		if (Array.isArray(lobby.chat)) {
			for (const msg of lobby.chat) {
				if (msg.name === oldName) msg.name = newName;
			}
		}

		store.persist(lobbyId);

		// Broadcast name change to chat windows
		io.to(room(lobbyId)).emit("chat:nameChange", { oldName, newName, clientId });

		// Refresh users list and chat history for all clients
		const users = store.getChatUsers(lobbyId);
		const updatedHistory = store.getChat(lobbyId, 50);
		io.to(room(lobbyId)).emit("chat:users", users);
		io.to(room(lobbyId)).emit("chat:historyUpdate", updatedHistory);

		// Push updated player list to the lobby so all clients see the new name
		sendState(lobbyId);
	});

	/**
	 * Handles a client's request for the current chat user list.
	 * Responds only to the requesting socket with the list of active chat users
	 * for the specified lobby.
	 *
	 * @param {object} payload
	 * @param {string} payload.lobbyId - The ID of the lobby whose user list is requested.
	 * @returns {void}
	 */
	socket.on("chat:users:request", ({ lobbyId }) => {
		const users = store.getChatUsers(lobbyId);
		socket.emit("chat:users", users);
	});

	/**
	 * Handles a typing-indicator event from a player.
	 * Relays the typing state to all other clients in the lobby room, excluding
	 * the sender.
	 *
	 * @param {object} payload
	 * @param {string} payload.lobbyId - The ID of the lobby where typing is occurring.
	 * @param {string} payload.name - The display name of the typing player.
	 * @param {boolean} payload.typing - `true` if the player started typing, `false` if they stopped.
	 * @returns {void}
	 */
	socket.on("chat:typing", ({ lobbyId, name, typing }) => {
		if (!store.index[lobbyId]) return;
		socket.to(room(lobbyId)).emit("chat:typing", { name, typing });
	});
}
