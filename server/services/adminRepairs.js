/**
 * adminRepairs — the manual fixes for everything the server cannot heal itself.
 *
 * Paired with `incidents`: that module makes a problem visible, this one makes it
 * fixable. Between them they answer "expose what cannot be auto-fixed, and let an
 * admin put it right".
 *
 * These are deliberately *absolute* operations rather than deltas. The existing
 * admin panel can only nudge a value by an amount, so correcting a wrong number
 * means working out the difference by hand — and if the number is wrong because an
 * update was applied twice, the arithmetic is exactly what the admin cannot trust.
 * Setting the value directly is both simpler and safer.
 *
 * Several of these have no equivalent anywhere else in the system: nothing else can
 * revive a character, refill spent ability uses outside a long rest, hand the turn
 * to a specific player, or rebuild a corrupted turn order.
 */

/** The repairs an admin can perform. */
export const REPAIRS = {
	REVIVE: "player:revive",
	SET_HP: "hp:set",
	SET_SLOTS: "slots:set",
	SET_CONDITIONS: "conditions:set",
	SET_TURN: "turn:set",
	REBUILD_ORDER: "order:rebuild",
	UNLOCK_UI: "ui:unlock",
	FORCE_RESYNC: "resync:force",
};

/** What each repair is for, shown in the admin interface. */
const CATALOGUE = [
	{ type: REPAIRS.REVIVE, label: "Revive character", fields: ["player", "hp"], note: "Clears death, restores hit points, returns them to the turn order." },
	{ type: REPAIRS.SET_HP, label: "Set hit points", fields: ["player", "hp"], note: "Absolute value, clamped to the character's maximum." },
	{ type: REPAIRS.SET_SLOTS, label: "Set ability uses spent", fields: ["player", "used"], note: "0 refills the pool. Nothing else does this outside a long rest." },
	{ type: REPAIRS.SET_CONDITIONS, label: "Replace conditions", fields: ["player", "conditions"], note: "Replaces the whole list; an empty list clears them." },
	{ type: REPAIRS.SET_TURN, label: "Hand the turn to", fields: ["player"], note: "Moves the active turn to a player already in the order." },
	{ type: REPAIRS.REBUILD_ORDER, label: "Rebuild turn order", fields: [], note: "Recovery when the order is empty, duplicated, or holding someone who left." },
	{ type: REPAIRS.UNLOCK_UI, label: "Release action overlay", fields: [], note: "Frees a table stuck behind a lock that was never lifted." },
	{ type: REPAIRS.FORCE_RESYNC, label: "Force resync", fields: [], note: "Pushes fresh state to every client in the lobby." },
];

/**
 * @description Creates the repair surface.
 * @param {object} deps - Injected collaborators.
 * @param {object} deps.store - The LobbyStore.
 * @param {function(...*): void} deps.log - Logger.
 * @param {function(string, string, object): void} deps.emitToLobby - Broadcasts to a lobby.
 * @param {function(string): void} deps.broadcastPartyState - Refreshes the party table.
 * @returns {{apply: Function, catalogue: Function}} The repair surface.
 */
export function createRepairs({ store, log, emitToLobby, broadcastPartyState }) {
	/**
	 * @description Builds a refusal.
	 * @param {string} reason - Why, in words an admin can act on.
	 * @returns {{ok: false, reason: string}} The refusal.
	 */
	const refuse = (reason) => ({ ok: false, reason });

	/**
	 * @description Applies one repair and broadcasts the corrected state.
	 *
	 *   Every repair ends with a state broadcast, deliberately: a fix players cannot
	 *   see has not fixed their experience of the problem, only the server's record
	 *   of it.
	 * @param {string} lobbyId - The lobby to repair.
	 * @param {string} type - One of {@link REPAIRS}.
	 * @param {object} [payload] - Repair-specific arguments.
	 * @returns {{ok: boolean, reason?: string, detail?: string}} What happened.
	 */
	function apply(lobbyId, type, payload = {}) {
		const lobby = store.index?.[lobbyId];
		if (!lobby) return refuse(`Lobby ${lobbyId} not found.`);

		/**
		 * @description Resolves the named player, or null.
		 * @returns {object|null} The player record.
		 */
		const player = () => (payload.player ? lobby.players?.[payload.player] ?? null : null);

		let detail;

		switch (type) {
			case REPAIRS.REVIVE: {
				const p = player();
				if (!p) return refuse(`No character named "${payload.player}" in this game.`);
				p.dead = false;
				p.disconnected = p.disconnected ?? undefined;
				const max = Number(p.stats?.max_hp);
				const wanted = Number.isFinite(Number(payload.hp)) ? Number(payload.hp) : 1;
				p.stats = p.stats || {};
				p.stats.hp = Number.isFinite(max) ? Math.min(max, Math.max(1, wanted)) : Math.max(1, wanted);
				if (!lobby.initiative?.includes(payload.player)) store.insertIntoInitiative(lobbyId, payload.player);
				detail = `${payload.player} revived at ${p.stats.hp} HP`;
				break;
			}

			case REPAIRS.SET_HP: {
				const p = player();
				if (!p) return refuse(`No character named "${payload.player}" in this game.`);
				const max = Number(p.stats?.max_hp);
				const wanted = Number(payload.hp);
				if (!Number.isFinite(wanted)) return refuse("Hit points must be a number.");
				p.stats = p.stats || {};
				p.stats.hp = Math.max(0, Number.isFinite(max) ? Math.min(max, wanted) : wanted);
				detail = `${payload.player} set to ${p.stats.hp} HP`;
				break;
			}

			case REPAIRS.SET_SLOTS: {
				const p = player();
				if (!p) return refuse(`No character named "${payload.player}" in this game.`);
				const level = Number(p.level) || 1;
				const wanted = Number(payload.used);
				if (!Number.isFinite(wanted)) return refuse("Uses spent must be a number.");
				p.spellSlotsUsed = Math.max(0, Math.min(level, wanted));
				detail = `${payload.player} has spent ${p.spellSlotsUsed} of ${level} uses`;
				break;
			}

			case REPAIRS.SET_CONDITIONS: {
				const p = player();
				if (!p) return refuse(`No character named "${payload.player}" in this game.`);
				if (!Array.isArray(payload.conditions)) return refuse("Conditions must be a list.");
				p.conditions = payload.conditions.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
				detail = `${payload.player}: ${p.conditions.join(", ") || "no conditions"}`;
				break;
			}

			case REPAIRS.SET_TURN: {
				const index = (lobby.initiative || []).indexOf(payload.player);
				if (index === -1) return refuse(`"${payload.player}" is not in the turn order. Rebuild the order first.`);
				lobby.turnIndex = index;
				detail = `turn handed to ${payload.player}`;
				break;
			}

			case REPAIRS.REBUILD_ORDER: {
				// Rebuilt from the players themselves rather than repaired in place,
				// because the states this recovers from — empty, duplicated, holding a
				// departed player — have no single edit that fixes them.
				const living = Object.values(lobby.players || {})
					.filter((p) => p && !p.dead)
					.map((p) => p.name)
					.filter(Boolean);
				lobby.initiative = [...new Set(living)];
				lobby.turnIndex = lobby.initiative.length ? Math.min(lobby.turnIndex || 0, lobby.initiative.length - 1) : 0;
				detail = `order rebuilt: ${lobby.initiative.join(", ") || "empty"}`;
				break;
			}

			case REPAIRS.UNLOCK_UI: {
				lobby.uiLock = null;
				emitToLobby(lobbyId, "ui:unlock", {});
				detail = "action overlay released";
				break;
			}

			case REPAIRS.FORCE_RESYNC: {
				detail = "resync pushed";
				break;
			}

			default:
				return refuse(`Unknown repair "${type}".`);
		}

		store.persist(lobbyId);
		emitToLobby(lobbyId, "state:update", store.publicState(lobbyId));
		emitToLobby(lobbyId, "turn:update", store.turnInfo(lobbyId));
		broadcastPartyState(lobbyId);

		log(`🔧 [repair] ${type} in ${lobbyId}: ${detail}`);
		return { ok: true, detail };
	}

	/**
	 * @description Lists every repair, for building the admin interface.
	 * @returns {Array<object>} The catalogue.
	 */
	function catalogue() {
		return CATALOGUE.map((entry) => ({ ...entry }));
	}

	return { apply, catalogue };
}
