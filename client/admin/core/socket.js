/**
 * socket — the only place that knows socket.io exists.
 *
 * Everything the server says lands in the store; everything a section wants to say
 * goes out through a named method here. Sections never touch the socket, which is
 * what keeps them renderable from state alone and stops event names being spelled
 * out in a dozen click handlers.
 *
 * The socket itself is injected rather than constructed, so the wiring — which
 * event feeds which slice, and what the reconnect does — is testable without a
 * browser or a server.
 */

import { toFeedEntry } from "./feed.js";

/**
 * Activity lines kept in memory. A long session emits thousands of events and the
 * feed is a tail, not an archive; the server's journal is the record.
 */
export const MAX_FEED = 500;

/** Server events that become activity lines. */
export const FORWARDED_EVENTS = Object.freeze([
	"xp:update",
	"hp:update",
	"gold:update",
	"turn:update",
	"narration",
	"player:death",
	"player:levelup",
	"player:kicked",
	"music:change",
	"sfx:play",
	"roll:required",
	"dice:result",
	"conditions:update",
	"inventory:update",
	"spellslots:update",
	"rest:vote:start",
	"rest:vote:result",
	"game:over",
	"toast",
]);

/**
 * @description Wires a socket to a store and returns the actions sections may take.
 * @param {object} deps - Injected collaborators.
 * @param {object} deps.socket - A socket.io client, or anything with `on`/`off`/`emit`.
 * @param {object} deps.store - A store from `createStore`.
 * @param {function(string): string} [deps.toText] - Renders DM markup as plain text.
 * @param {function(): number} [deps.now=Date.now] - Clock, injected so tests are deterministic.
 * @returns {object} The action surface.
 * @throws {TypeError} When `socket` or `store` is missing.
 */
export function createSocketBridge({ socket, store, toText, now = Date.now } = {}) {
	if (!socket || typeof socket.on !== "function" || typeof socket.emit !== "function") {
		throw new TypeError("createSocketBridge needs a socket with on/off/emit");
	}
	if (!store || typeof store.patch !== "function") {
		throw new TypeError("createSocketBridge needs a store");
	}

	/** @type {Array<[string, Function]>} Every handler attached, so disposal is exact. */
	const attached = [];

	/**
	 * @description Attaches a handler and records it for disposal.
	 * @param {string} event - The socket event.
	 * @param {Function} handler - The handler.
	 * @returns {void}
	 */
	function on(event, handler) {
		socket.on(event, handler);
		attached.push([event, handler]);
	}

	/**
	 * @description Appends an activity line, keeping only the most recent.
	 * @param {object|null} line - An entry from `toFeedEntry`, or null to do nothing.
	 * @returns {void}
	 */
	function pushFeed(line) {
		if (!line) return;
		const feed = [...(store.getState().feed ?? []), line];
		store.patch({ feed: feed.length > MAX_FEED ? feed.slice(-MAX_FEED) : feed });
	}

	/**
	 * @description The lobby every action is scoped to.
	 * @returns {string|null} The connected lobby code.
	 */
	const currentLobby = () => store.getState().lobby ?? null;

	/**
	 * @description Sends a lobby-scoped message, or nothing if no lobby is open.
	 *
	 *   Refusing beats sending a codeless frame: the server would reject it as
	 *   unauthorised, which reads in the log like a permissions fault rather than
	 *   the interface getting ahead of itself.
	 * @param {string} event - The socket event.
	 * @param {object} [extra] - Fields to send alongside the lobby code.
	 * @returns {boolean} Whether anything was sent.
	 */
	function sendScoped(event, extra = {}) {
		const code = currentLobby();
		if (!code) return false;
		socket.emit(event, { code, ...extra });
		return true;
	}

	// ── connection lifecycle ────────────────────────────────────────────────────

	on("connect", () => {
		store.patch({ status: "connected", statusDetail: "" });
		// A dropped connection leaves the panel holding state it can no longer
		// receive updates for, so the lobby is rejoined rather than merely marked live.
		const code = currentLobby();
		if (code) socket.emit("admin:connect", { code });
	});

	on("disconnect", (reason) => {
		store.patch({ status: "disconnected", statusDetail: String(reason ?? "") });
	});

	on("connect_error", (err) => {
		store.patch({ status: "error", statusDetail: err?.message || String(err ?? "") });
	});

	// ── lobby state ─────────────────────────────────────────────────────────────

	on("admin:connected", (state) => {
		store.patch({ lobbyState: state ?? null, status: "connected", statusDetail: "" });
	});

	on("admin:update", (state) => {
		store.patch({ lobbyState: state ?? null });
	});

	on("admin:incidents", (incidents) => {
		store.patch({ incidents: Array.isArray(incidents) ? incidents : [] });
	});

	on("admin:repairs", (catalogue) => {
		store.patch({ repairs: Array.isArray(catalogue) ? catalogue : [] });
	});

	on("admin:incident", () => {
		// Counts and ordering are computed server-side; re-requesting keeps them
		// right rather than trying to merge one incident into the list by hand.
		const code = currentLobby();
		if (code) socket.emit("admin:connect", { code });
	});

	on("admin:lobbyDeleted", ({ code } = {}) => {
		if (code && code !== currentLobby()) return;
		store.patch({ lobby: null, lobbyState: null, incidents: [] });
	});

	on("admin:sfx:result", (result) => {
		store.patch({ sfxResult: result ?? null });
	});

	on("admin:repair:result", ({ type, ok, detail, reason } = {}) => {
		pushFeed({
			type: "sys",
			message: ok ? `Repair ${type}: ${detail}` : `Repair ${type} refused: ${reason}`,
			at: now(),
		});
	});

	// ── activity ────────────────────────────────────────────────────────────────

	for (const event of FORWARDED_EVENTS) {
		on(event, (payload) => pushFeed(toFeedEntry(event, payload, { now, toText })));
	}

	return {
		/**
		 * @description Connects to a lobby and remembers it as the active one.
		 * @param {string} code - The lobby code, in any casing.
		 * @returns {boolean} Whether a request was sent.
		 */
		connectLobby(code) {
			const normalised = typeof code === "string" ? code.trim().toUpperCase() : "";
			if (!normalised) return false;
			store.patch({ lobby: normalised });
			socket.emit("admin:connect", { code: normalised });
			return true;
		},

		/**
		 * @description Deletes a lobby, which need not be the one currently open.
		 * @param {string} code - The lobby to delete.
		 * @returns {boolean} Whether a request was sent.
		 */
		deleteLobby(code) {
			const normalised = typeof code === "string" ? code.trim().toUpperCase() : "";
			if (!normalised) return false;
			socket.emit("admin:deleteLobby", { code: normalised });
			return true;
		},

		/**
		 * @description Applies a game-state change to the open lobby.
		 * @param {string} type - An `admin:event` sub-type, e.g. `"xp:update"`.
		 * @param {object} payload - The change.
		 * @returns {boolean} Whether a request was sent.
		 */
		sendEvent(type, payload) {
			return sendScoped("admin:event", { type, payload });
		},

		/**
		 * @description Applies a manual repair to the open lobby.
		 * @param {string} type - A repair type from the server's catalogue.
		 * @param {object} payload - The repair's arguments.
		 * @returns {boolean} Whether a request was sent.
		 */
		sendRepair(type, payload) {
			return sendScoped("admin:repair", { type, payload });
		},

		/**
		 * @description Marks an incident handled.
		 * @param {string} id - The incident id.
		 * @returns {boolean} Whether a request was sent.
		 */
		resolveIncident(id) {
			return sendScoped("admin:incident:resolve", { id });
		},

		/**
		 * @description Speaks as the Dungeon Master.
		 * @param {string} content - The narration.
		 * @returns {boolean} Whether a request was sent.
		 */
		sendDM(content) {
			return sendScoped("admin:dm", { content });
		},

		/**
		 * @description Moves the lobby to another phase.
		 * @param {string} phase - The target phase.
		 * @returns {boolean} Whether a request was sent.
		 */
		setPhase(phase) {
			return sendScoped("admin:phase", { phase });
		},

		/**
		 * @description Hands the turn to the next player in the order.
		 * @returns {boolean} Whether a request was sent.
		 */
		nextTurn() {
			return sendScoped("admin:nextTurn");
		},

		/**
		 * @description Changes or stops the background music.
		 * @param {string|null} mood - A mood id, or null to stop. Sent explicitly as
		 *   null rather than omitted, because the server distinguishes the two.
		 * @returns {boolean} Whether a request was sent.
		 */
		setMusic(mood) {
			return sendScoped("admin:music", { mood: mood ?? null });
		},

		/**
		 * @description Switches the model the lobby runs on.
		 * @param {string} provider - The provider id.
		 * @param {string} model - The model id.
		 * @returns {boolean} Whether a request was sent.
		 */
		setLLM(provider, model) {
			return sendScoped("admin:llm", { provider, model });
		},

		/**
		 * @description Resolves a sound effect and plays it to the lobby.
		 * @param {string} description - What the sound should be.
		 * @returns {boolean} Whether a request was sent.
		 */
		testSfx(description) {
			return sendScoped("admin:sfx", { description });
		},

		/**
		 * @description Authenticates the host view, which arrives with a character id
		 *   rather than a password session.
		 * @param {string} lobbyCode - The lobby the host runs.
		 * @param {string} characterId - The id from their signed character file.
		 * @returns {void}
		 */
		hostAuth(lobbyCode, characterId) {
			socket.emit("host:auth", { lobbyCode, characterId });
		},

		/**
		 * @description Detaches every handler this bridge attached.
		 * @returns {void}
		 */
		dispose() {
			for (const [event, handler] of attached.splice(0)) socket.off(event, handler);
		},
	};
}
