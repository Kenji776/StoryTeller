/**
 * Registers all admin-related Socket.IO event handlers for a connected socket.
 *
 * Destructures the full set of shared dependencies from `deps` and wires up
 * the following socket events:
 *
 * - `host:auth`           — Authenticates a host socket using their characterId,
 *                           granting scoped admin access to their lobby.
 * - `admin:connect`       — Joins the socket to the lobby room and emits the
 *                           current public state back to the admin client.
 * - `admin:event`         — Dispatches a typed game-state mutation (see sub-types
 *                           below) and broadcasts the resulting change to all
 *                           lobby clients:
 *     - `xp:update`           Adds or removes XP for a player; triggers a level-up
 *                             event if the threshold is crossed.
 *     - `hp:update`           Applies an HP delta to a player and re-broadcasts
 *                             party state.
 *     - `gold:update`         Applies a gold delta to a player.
 *     - `spellslots:update`   Adjusts used spell slots for a player.
 *     - `inventory:update`    Adds or removes an item in a player's inventory and
 *                             pushes a full state refresh.
 *     - `player:death`        Forces a player death, appends DM narration, removes
 *                             them from turn order, and checks for a total-party-kill.
 *     - `player:kick`         Removes a player from the lobby and notifies their
 *                             socket.
 *     - `roll:required`       Requests a dice roll from a specific player.
 *     - `conditions:update`   Adds or removes status conditions from a player.
 *     - `player:forceLevelUp` Sends a level-up modal to a player without immediately
 *                             incrementing their level (the confirm flow does that).
 * - `admin:phase`         — Changes the current game phase of a lobby.
 * - `admin:nextTurn`      — Cancels the current turn timer, advances the turn
 *                           order, and restarts the timer.
 * - `admin:music`         — Changes or stops the background music mood for the
 *                           entire lobby.
 * - `admin:llm`           — Switches the LLM provider and model used by the lobby.
 * - `admin:sfx`           — Tests a sound-effect description, resolving or
 *                           generating the clip and playing it in the lobby.
 * - `admin:dm`            — Appends a Dungeon Master narration message to the
 *                           lobby history and broadcasts it to all clients.
 * - `admin:deleteLobby`   — Notifies all lobby members, removes the lobby from
 *                           the store, and broadcasts the updated lobby list.
 *
 * @param {import('socket.io').Socket} socket - The Socket.IO socket instance for
 *   the connecting client.
 * @param {Object} deps - Shared server-side dependencies injected by the caller.
 * @param {import('socket.io').Server}  deps.io                  - The Socket.IO server instance.
 * @param {Object}                      deps.store               - In-memory game-state store.
 * @param {function(string): string}    deps.room                - Converts a lobbyId to a
 *   Socket.IO room name.
 * @param {function(...*): void}        deps.log                 - Logging utility.
 * @param {Map<string, string>}         deps.hostAdminSockets    - Maps socket IDs to the lobby
 *   code they are authorized to administrate as host.
 * @param {Map<string, Object>}         deps.adminSessions       - Active full-admin password
 *   sessions keyed by token.
 * @param {Map<string, Object>}         deps.hostAdminTokens     - Active host-scoped admin
 *   tokens keyed by token string.
 * @param {function(string): Object}    deps.parseCookie         - Parses a cookie header string
 *   into a key/value object.
 * @param {function(Map): void}         deps.cleanExpired        - Removes expired entries from
 *   a token map in place.
 * @param {function(string): void}      deps.sendState           - Broadcasts the full public
 *   state of a lobby to all its members.
 * @param {function(): void}            deps.broadcastLobbies    - Broadcasts the updated list
 *   of all lobbies to the lobby-list room.
 * @param {function(Object, Object, string): void} deps.broadcastPartyState - Broadcasts the
 *   current party health/status summary to a lobby room.
 * @param {function(string): void}      deps.cancelTurnTimer     - Cancels the active turn timer
 *   for a lobby.
 * @param {function(string): Object}    deps.resolveActiveTurn   - Returns the resolved turn
 *   state (current player + order) for a lobby.
 * @param {function(string): void}      deps.startTurnTimer      - Starts (or restarts) the turn
 *   timer for a lobby.
 * @param {function(string): Promise<void>} deps.checkAndEndIfAllDead - Checks whether all
 *   players are dead and, if so, ends the game.
 * @param {function(string): Promise<Array>} deps.resolveSfx     - Resolves or generates a list
 *   of sound effects by description.
 * @param {function(string): Object|null}    deps.findSfxMatch   - Finds a pre-existing SFX
 *   library entry matching a description.
 * @param {string}                      deps.ELEVEN_API_KEY      - API key for ElevenLabs sound
 *   generation.
 * @param {function(string, number): Object|null} deps.getAbilityForLevel - Returns the class
 *   ability unlocked at a given level, or null if none.
 * @returns {void}
 */
export function registerAdminEvents(socket, deps) {
	const {
		io,
		store,
		room,
		log,
		hostAdminSockets,
		adminSessions,
		hostAdminTokens,
		parseCookie,
		cleanExpired,
		sendState,
		broadcastLobbies,
		broadcastPartyState,
		cancelTurnTimer,
		resolveActiveTurn,
		startTurnTimer,
		checkAndEndIfAllDead,
		resolveSfx,
		findSfxMatch,
		ELEVEN_API_KEY,
		getAbilityForLevel,
	} = deps;

	/**
	 * Determines whether the current socket is authorised to perform admin actions
	 * on the specified lobby.
	 *
	 * Two levels of access are accepted:
	 * 1. **Full admin** — the socket's handshake cookie contains an `admin_token`
	 *    that matches an active entry in `adminSessions` (unrestricted access to
	 *    any lobby).
	 * 2. **Host admin** — either the socket ID is present in `hostAdminSockets`
	 *    with a matching lobby code, or the `admin_token` cookie matches an active
	 *    entry in `hostAdminTokens` whose `lobbyCode` equals `code` (access scoped
	 *    to that lobby only).
	 *
	 * Expired sessions are purged from both token maps as a side-effect of each
	 * call.
	 *
	 * @param {string} code - The short lobby code (e.g. "ABCD") to check access for.
	 * @returns {boolean} `true` if the socket holds a valid admin credential for
	 *   the given lobby, `false` otherwise.
	 */
	function isSocketAdmin(code) {
		// Check host-admin authorization (scoped to their lobby only)
		const hostCode = hostAdminSockets.get(socket.id);
		if (hostCode && hostCode === code) return true;
		// Check cookies from the socket handshake
		const cookieStr = socket.handshake?.headers?.cookie || "";
		const token = parseCookie(cookieStr).admin_token;
		if (token) {
			// Full admin password session — unrestricted
			cleanExpired(adminSessions);
			if (adminSessions.has(token)) return true;
			// Host token — scoped to their lobby only
			cleanExpired(hostAdminTokens);
			const hostEntry = hostAdminTokens.get(token);
			if (hostEntry && hostEntry.lobbyCode === code) return true;
		}
		return false;
	}

	// === HOST SOCKET VERIFICATION ===
	// The host authenticates by presenting their signed .stchar file via HTTP (host-verify),
	// which sets a cookie. Then when they open the admin page the cookie grants access.
	// On the socket side, we authorize via the host:auth event with their characterId.
	socket.on("host:auth", ({ lobbyCode, characterId }) => {
		if (!lobbyCode || !characterId) return socket.emit("toast", { type: "error", message: "Missing auth data" });
		const lobbyId = store.findLobbyByCode(lobbyCode);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found" });
		const lobby = store.index[lobbyId];
		if (!lobby.hostCharacterId || lobby.hostCharacterId !== characterId) {
			log(`⚠️ host:auth failed — characterId mismatch for lobby ${lobbyCode} from ${socket.id}`);
			return socket.emit("toast", { type: "error", message: "Not authorized as host" });
		}
		hostAdminSockets.set(socket.id, lobbyCode);
		log(`🔓 Host socket ${socket.id} authorized for lobby ${lobbyCode}`);
		socket.emit("host:auth:ok", { lobbyCode });
	});

	// ===== ADMIN SOCKET EVENTS =====
	socket.on("admin:connect", ({ code }) => {
		log(`🧭 ADMIN connect request for lobby code ${code} from ${socket.id}`);
		if (!isSocketAdmin(code)) {
			log(`⚠️ Unauthorized admin:connect attempt by ${socket.id} for lobby ${code}`);
			return socket.emit("toast", { type: "error", message: "Not authorized" });
		}
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ Admin tried to connect to invalid code: ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		socket.join(room(lobbyId));
		const state = store.publicState(lobbyId);
		socket.emit("admin:connected", state);
		log(`✅ ADMIN connected to lobby ${lobbyId} (${code}) with ${Object.keys(state.players).length} players`);
	});

	socket.on("admin:event", async ({ code, type, payload }) => {
		if (!isSocketAdmin(code)) {
			return socket.emit("toast", { type: "error", message: "Not authorized" });
		}
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return;

		// Apply effects server-side and broadcast updates
		switch (type) {
			case "xp:update": {
				const newXP = store.addXP(lobbyId, payload.player, payload.amount);
				io.to(room(lobbyId)).emit("xp:update", {
					player: payload.player,
					xp: newXP,
					amount: payload.amount,
					reason: payload.reason || "Manual adjustment",
				});
				if (store.checkLevelUp(lobbyId, payload.player)) {
					const sid = store.sidByPlayerName(lobbyId, payload.player);
					if (sid) {
						const playerData = store.index[lobbyId].players[payload.player];
						const newLvl = (playerData?.level || 1) + 1;
						const upcomingAbility = getAbilityForLevel(playerData?.class, newLvl);
						io.to(sid).emit("player:levelup", { newLevel: newLvl, upcomingAbility: upcomingAbility || null });
					}
				}
				break;
			}
			case "hp:update": {
				const newHP = store.applyHPChange(lobbyId, payload.player, payload.delta);
				io.to(room(lobbyId)).emit("hp:update", {
					player: payload.player,
					hp: newHP,
					delta: payload.delta,
					reason: payload.reason || "Manual change",
				});
				broadcastPartyState(io, store, lobbyId);
				break;
			}
			case "gold:update": {
				const newGold = store.applyGoldChange(lobbyId, payload.player, payload.delta);
				io.to(room(lobbyId)).emit("gold:update", {
					player: payload.player,
					gold: newGold,
					delta: payload.delta,
					reason: payload.reason || "Manual change",
				});
				break;
			}
			case "spellslots:update": {
				const newUsed = store.applySpellSlotChange(lobbyId, payload.player, payload.delta);
				const maxSlots = store.index[lobbyId]?.players[payload.player]?.level || 1;
				io.to(room(lobbyId)).emit("spellslots:update", {
					player: payload.player,
					spellSlotsUsed: newUsed,
					maxSlots,
				});
				broadcastPartyState(io, store, lobbyId);
				break;
			}
			case "inventory:update": {
				const newCount = store.applyInventoryChange(lobbyId, payload.player, payload.item, payload.change, payload.description || "", payload.attributes || {});
				io.to(room(lobbyId)).emit("inventory:update", {
					player: payload.player,
					item: payload.item,
					change: payload.change,
					newCount,
					description: payload.description || "",
					attributes: payload.attributes || {},
				});
				// Push full state so the game UI re-renders with the new item
				io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
				break;
			}
			case "player:death": {
				const { player, reason } = payload;
				console.log(`💀 Admin forced death for ${player} in lobby ${code}${reason ? ` — ${reason}` : ""}`);

				// Append death event to history so the LLM has context
				const deathNarration = reason
					? `${player} has been killed: ${reason}`
					: `${player} has been struck down by a fatal blow.`;
				store.appendDM(lobbyId, deathNarration);
				io.to(room(lobbyId)).emit("narration", { content: deathNarration });

				store.markPlayerDead(lobbyId, player);
				store.removeFromTurnOrder(lobbyId, player);

				// Emit player:death BEFORE checking for TPK so clients get the
				// individual death event before any potential wipe epilogue/game:over
				const { current: dCurrent, order: dOrder } = store.turnInfo(lobbyId);
				io.to(room(lobbyId)).emit("player:death", {
					player,
					message: reason ? `${player} has fallen: ${reason}` : `${player} has fallen (admin override)!`,
				});
				io.to(room(lobbyId)).emit("turn:update", { current: dCurrent, order: dOrder });

				await checkAndEndIfAllDead(lobbyId);

				if (store.index[lobbyId]?.phase !== "wiped") {
					sendState(lobbyId);
				}

				break;
			}
			case "player:kick": {
				const kickedSid = store.kickPlayer(lobbyId, payload.player);
				if (kickedSid) {
					io.to(kickedSid).emit("player:kicked", { reason: "You were removed by an admin." });
					const kickedSocket = io.sockets.sockets.get(kickedSid);
					if (kickedSocket) kickedSocket.leave(room(lobbyId));
				}
				sendState(lobbyId);
				broadcastLobbies();
				break;
			}
			case "roll:required": {
				const { player, sides, stats, mods, dc } = payload;
				io.to(room(lobbyId)).emit("roll:required", {
					player,
					sides: Number(sides),
					stats: Array.isArray(stats) ? stats : [],
					mods: Number(mods) || 0,
					dc: Number(dc) || 0,
				});
				break;
			}
			case "conditions:update": {
				const { player, add = [], remove = [] } = payload;
				const conds = store.applyConditions(lobbyId, player, add, remove);
				io.to(room(lobbyId)).emit("conditions:update", { player, conditions: conds });
				broadcastPartyState(io, store, lobbyId);
				break;
			}
			case "player:forceLevelUp": {
				const { player } = payload;
				const playerData = store.index[lobbyId]?.players[player];
				if (!playerData) return;

				// Do NOT call increaseLevel here — the confirm handler does that.
				// Just compute the upcoming level and send the event so the player
				// sees the stat-allocation modal (which triggers the confirm chain).
				const playerClass = playerData.class;
				const upcomingLevel = (playerData.level || 1) + 1;
				const upcomingAbility = getAbilityForLevel(playerClass, upcomingLevel);

				const sid = store.sidByPlayerName(lobbyId, player);
				if (sid) {
					io.to(sid).emit("player:levelup", { newLevel: upcomingLevel, upcomingAbility: upcomingAbility || null });
				}
				io.to(room(lobbyId)).emit("toast", {
					type: "info",
					message: `${player} has been awarded a level up to ${upcomingLevel}! (forced by admin)`,
				});
				console.log(`⚙️ [ADMIN] Force level-up event sent to ${player} → will reach level ${upcomingLevel}`);
				break;
			}
			default:
				log(`⚠️ Unknown admin event type: ${type}`);
				return;
		}

		log(`🧙‍♂️ Admin triggered ${type} for ${payload.player}`);
	});

	socket.on("admin:phase", ({ code, phase }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		log(`🔄 ADMIN phase change — lobby ${code}, new phase "${phase}"`);
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ Phase change failed — no lobby for ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		try {
			store.setPhase(lobbyId, phase);
			const state = store.publicState(lobbyId);
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `Phase changed → ${phase}` });
			io.to(room(lobbyId)).emit("state:update", state);
			socket.emit("admin:update", state);
			log(`✅ Phase for ${lobbyId} now "${phase}"`);
		} catch (err) {
			log(`💥 ADMIN phase change error:`, err);
			socket.emit("toast", { type: "error", message: err.message });
		}
	});

	socket.on("admin:nextTurn", ({ code }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		log(`⏭️ ADMIN next turn — lobby ${code}`);
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ Next turn failed — no lobby for ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		try {
			cancelTurnTimer(lobbyId);
			store.nextTurn(lobbyId);
			const turn = resolveActiveTurn(lobbyId);
			log(`➡️ Turn advanced to ${turn.current}`);
			io.to(room(lobbyId)).emit("turn:update", turn);
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `Turn advanced manually` });
			startTurnTimer(lobbyId);
			socket.emit("admin:update", store.publicState(lobbyId));
		} catch (err) {
			log(`💥 ADMIN nextTurn error:`, err);
			socket.emit("toast", { type: "error", message: err.message });
		}
	});

	socket.on("admin:music", ({ code, mood }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found" });
		store.setCurrentMusic(lobbyId, mood || null);
		io.to(room(lobbyId)).emit("music:change", { mood: mood || null });
		log(`🎵 ADMIN music → lobby ${lobbyId}: ${mood || "stop"}`);
		socket.emit("toast", { type: "success", message: mood ? `Music changed to: ${mood}` : "Music stopped" });
	});

	socket.on("admin:llm", ({ code, provider, model }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found" });
		store.setLLMSettings(lobbyId, provider, model);
		sendState(lobbyId);
		log(`🤖 ADMIN LLM → lobby ${lobbyId}: ${provider}/${model}`);
		socket.emit("toast", { type: "success", message: `LLM switched to ${provider} / ${model}` });
	});

	socket.on("admin:sfx", async ({ code, description }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		if (!description || typeof description !== "string" || !description.trim()) {
			return socket.emit("toast", { type: "error", message: "Enter a sound effect description" });
		}

		const desc = description.trim();
		log(`🔊 ADMIN SFX test → "${desc}"`);
		try {
			// Check for pre-existing match before resolving (which may generate)
			const preExisting = findSfxMatch(desc);
			const results = await resolveSfx([desc], ELEVEN_API_KEY);
			if (!results.length) {
				return socket.emit("admin:sfx:result", { ok: false, error: "No match found and generation failed or unavailable" });
			}
			const fx = results[0];
			// Play on all game clients in the lobby
			const lobbyId = store.findLobbyByCode(code);
			if (lobbyId) io.to(room(lobbyId)).emit("sfx:play", { effects: [fx] });
			socket.emit("admin:sfx:result", { ok: true, effect: fx, source: preExisting ? "library" : "generated" });
		} catch (err) {
			log(`💥 ADMIN SFX test error: ${err.message}`);
			socket.emit("admin:sfx:result", { ok: false, error: err.message });
		}
	});

	socket.on("admin:dm", ({ code, content }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		log(`📜 ADMIN DM message — lobby ${code}: ${content}`);
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ DM failed — no lobby for ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		try {
			store.appendDM(lobbyId, content);
			io.to(room(lobbyId)).emit("narration", { content: `[ADMIN] ${content}` });
			socket.emit("admin:update", store.publicState(lobbyId));
			log(`✅ DM narration sent to lobby ${lobbyId}`);
		} catch (err) {
			log(`💥 ADMIN DM error:`, err);
			socket.emit("toast", { type: "error", message: err.message });
		}
	});

	socket.on("admin:deleteLobby", ({ code }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: `Lobby ${code} not found` });
		// Notify any connected players before wiping
		io.to(room(lobbyId)).emit("toast", { type: "warning", message: "This lobby has been deleted by an admin." });
		io.socketsLeave(room(lobbyId));
		store.deleteLobby(lobbyId);
		broadcastLobbies();
		log(`🗑️ Admin deleted lobby ${lobbyId} (${code})`);
		socket.emit("admin:lobbyDeleted", { code });
	});
}
