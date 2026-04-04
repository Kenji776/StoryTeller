// === services/mapService.js ===
// Accepts structured character + terrain data directly from the DM JSON response.
// No LLM call — the main action pipeline already produces this data.

const CLASS_EMOJIS = {
	Fighter: "⚔️", Rogue: "🗡️", Wizard: "🧙", Cleric: "✝️",
	Ranger: "🏹", Paladin: "🛡️", Bard: "🎸", Barbarian: "🪓",
	Sorcerer: "🔮", Warlock: "😈", Monk: "👊", Druid: "🌿",
};

/**
 * Update the lobby's map state and broadcast the new state to all connected clients.
 *
 * Merges the incoming character list with the lobby's existing characters so that
 * any entity not mentioned in the new list is preserved at its last known position.
 * If no terrain is provided, the lobby's existing terrain is retained.  The full
 * map state is persisted to the store and emitted via Socket.IO as a "map:update"
 * event.  Up to 20 historical snapshots are kept in `lobby.mapHistory`.
 *
 * @param {import('socket.io').Server} io          - The Socket.IO server instance used to broadcast events.
 * @param {{ index: Record<string, object>, persist: (id: string) => void }} store
 *   - The lobby store; must expose an `index` map and a `persist` method.
 * @param {string} lobbyId                         - Unique identifier of the target lobby.
 * @param {{ name: string, type?: string, emoji?: string, x?: number, y?: number, facing?: string, status?: string }[]} [characters=[]]
 *   - Array of character/entity objects to merge into the current map state.
 * @param {{ type: string, features?: string[] } | null} [terrain=null]
 *   - Terrain descriptor for the current scene.  When falsy or missing a `type`
 *     property, the lobby's existing terrain is used unchanged.
 * @returns {void}
 */
export function updateMap(io, store, lobbyId, characters = [], terrain = null) {
	try {
		const lobby = store.index[lobbyId];
		if (!lobby) return console.warn(`Cannot update map — lobby ${lobbyId} not found`);

		const prevChars  = lobby.characters || [];
		const merged     = mergeChars(prevChars, characters);
		const resolvedTerrain = (terrain && terrain.type)
			? terrain
			: (lobby.terrain || { type: "unknown", features: [] });

		lobby.characters = merged;
		lobby.terrain    = resolvedTerrain;

		lobby.mapHistory = lobby.mapHistory || [];
		lobby.mapHistory.push({
			characters: merged.map(c => ({ ...c })),
			terrain: { ...resolvedTerrain, features: [...(resolvedTerrain.features || [])] },
		});
		if (lobby.mapHistory.length > 20) lobby.mapHistory.shift();

		store.persist(lobbyId);

		io.to(lobbyId).emit("map:update", {
			characters: merged,
			terrain:    resolvedTerrain,
		});

		console.log(`Map updated for ${lobbyId}: ${merged.length} entities, terrain=${resolvedTerrain.type}`);
	} catch (err) {
		console.error("Error updating map:", err);
	}
}

/**
 * Merge a new character list into the existing one.
 *
 * Characters present in both lists are updated with the new properties while
 * retaining any fields that the new entry does not specify.  Characters that
 * appear only in `oldList` are kept as-is so that entities not referenced in
 * the latest DM response are not silently removed from the map.
 *
 * @param {{ name: string, [key: string]: unknown }[]} [oldList=[]] - The current persisted character array.
 * @param {{ name: string, [key: string]: unknown }[]} [newList=[]] - The incoming character updates from the DM response.
 * @returns {{ name: string, [key: string]: unknown }[]} The merged array of character objects.
 */
function mergeChars(oldList = [], newList = []) {
	const map = new Map(oldList.map(c => [c.name, { ...c }]));
	for (const nc of newList) {
		if (!nc?.name) continue;
		map.set(nc.name, { ...(map.get(nc.name) || {}), ...nc });
	}
	return [...map.values()];
}

/**
 * Return the default emoji character associated with a player class name.
 *
 * Looks up `cls` in the `CLASS_EMOJIS` map.  If the class is not found (e.g.
 * a custom or unknown class), the generic wizard emoji "🧙" is returned as a
 * safe fallback so callers never receive an undefined value.
 *
 * @param {string} cls - The player class name (e.g. "Fighter", "Rogue", "Wizard").
 * @returns {string} A single emoji string representing the class, or "🧙" if unrecognised.
 */
export function getDefaultPlayerEmoji(cls) {
	return CLASS_EMOJIS[cls] || "🧙";
}

/**
 * Register REST endpoints for reading map state on an Express application.
 *
 * Mounts two GET routes:
 * - `GET /api/map/:lobbyId`         — Returns the current characters and terrain for a lobby.
 * - `GET /api/map/:lobbyId/history` — Returns the full map history alongside the current state.
 *
 * Both routes respond with HTTP 404 and a JSON error body when the lobby is not found.
 *
 * @param {import('express').Application} app - The Express application instance to attach routes to.
 * @param {{ index: Record<string, object> }} store
 *   - The lobby store; must expose an `index` map keyed by lobby ID.
 * @returns {void}
 */
export function registerMapEndpoints(app, store) {
	app.get("/api/map/:lobbyId", (req, res) => {
		const { lobbyId } = req.params;
		const lobby = store.index[lobbyId];
		if (!lobby) return res.status(404).json({ error: "Lobby not found" });
		res.json({
			characters: lobby.characters || [],
			terrain:    lobby.terrain    || { type: "unknown", features: [] },
		});
	});

	app.get("/api/map/:lobbyId/history", (req, res) => {
		const { lobbyId } = req.params;
		const lobby = store.index[lobbyId];
		if (!lobby) return res.status(404).json({ error: "Lobby not found" });
		res.json({
			history: lobby.mapHistory || [],
			current: {
				characters: lobby.characters || [],
				terrain:    lobby.terrain    || { type: "unknown", features: [] },
			},
		});
	});
}
