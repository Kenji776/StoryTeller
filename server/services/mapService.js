// === services/mapService.js ===
// Accepts structured character + terrain data directly from the DM JSON response.
// No LLM call — the main action pipeline already produces this data.

const CLASS_EMOJIS = {
	Fighter: "⚔️", Rogue: "🗡️", Wizard: "🧙", Cleric: "✝️",
	Ranger: "🏹", Paladin: "🛡️", Bard: "🎸", Barbarian: "🪓",
	Sorcerer: "🔮", Warlock: "😈", Monk: "👊", Druid: "🌿",
};

/**
 * Update the lobby's map state and broadcast to all clients.
 * @param {import('socket.io').Server} io
 * @param {object} store
 * @param {string} lobbyId
 * @param {Array}  characters  - Array of {name, type, emoji, x, y, facing, status}
 * @param {object} terrain     - {type: string, features: string[]}
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
 * Merge new character list into the previous one, updating positions and
 * preserving any characters not mentioned in the new list.
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
 * Returns the default emoji for a given player class name.
 */
export function getDefaultPlayerEmoji(cls) {
	return CLASS_EMOJIS[cls] || "🧙";
}

/**
 * Register REST endpoints for fetching current map and history.
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
