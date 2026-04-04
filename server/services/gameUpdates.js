// === gameUpdates.js ===
// Unified + normalized version
import { normalizeName } from "../helpers/utils.js";
import { getAbilityForLevel } from "../helpers/classProgression.js";


// === XP UPDATES ===
/**
 * Processes a batch of XP update entries for players in a lobby.
 * For each valid entry, increments the player's XP in the store and emits an
 * `xp:update` socket event to all lobby members. If the XP gain triggers a
 * level-up, emits a `player:levelup` event directly to that player's socket.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 * @param {object} store - The game state store with player/lobby mutation methods.
 * @param {string} lobbyId - The ID of the lobby to target.
 * @param {Array<{player: string, amount: number, reason?: string}>} updates - Array of XP update entries.
 * @returns {void}
 */
export function broadcastXPUpdates(io, store, lobbyId, updates) {
	for (const x of Array.isArray(updates) ? updates : []) {
		const amount = Number(x?.amount);
		if (!x?.player || isNaN(amount)) continue;

		const key = store.findPlayerKey(lobbyId, normalizeName(x.player));
		if (!key) { console.warn(`[xp:update] Player not found: ${x.player}`); continue; }

		const newXP = store.addXP(lobbyId, key, amount);

		io.to(lobbyId).emit("xp:update", {
			player: key,
			xp: newXP,
			amount,
			reason: x.reason || "Story progress",
		});

		if (store.checkLevelUp(lobbyId, key)) {
			const sid = store.sidByPlayerName(lobbyId, key);
			if (sid) {
				const playerData = store.index[lobbyId].players[key];
				const newLvl = (playerData.level || 1) + 1;
				const upcomingAbility = getAbilityForLevel(playerData.class, newLvl);
				io.to(sid).emit("player:levelup", { newLevel: newLvl, upcomingAbility: upcomingAbility || null });
			}
		}
	}
}

// === HP UPDATES ===
/**
 * Processes a batch of HP delta entries for players in a lobby.
 * For each valid entry, applies the HP change in the store and emits an
 * `hp:update` socket event to all lobby members. If a player's HP reaches
 * zero or below, marks them as dead in the store, removes them from the turn
 * order, and emits `player:death` and `turn:update` events to the lobby.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 * @param {object} store - The game state store with player/lobby mutation methods.
 * @param {string} lobbyId - The ID of the lobby to target.
 * @param {Array<{player: string, delta: number, reason?: string}>} updates - Array of HP delta entries.
 * @returns {void}
 */
export function broadcastHPUpdates(io, store, lobbyId, updates) {
	for (const h of Array.isArray(updates) ? updates : []) {
		const delta = Number(h?.delta);
		if (!h?.player || isNaN(delta)) continue;

		const key = store.findPlayerKey(lobbyId, normalizeName(h.player));
		if (!key) { console.warn(`[hp:update] Player not found: ${h.player}`); continue; }

		const hpNow = store.applyHPChange(lobbyId, key, delta);

		io.to(lobbyId).emit("hp:update", {
			player: key,
			hp: hpNow,
			delta,
			reason: h.reason || "",
		});

		if (hpNow <= 0) {
			console.log(`💀 ${key} has died!`);
			store.markPlayerDead(lobbyId, key);
			store.removeFromTurnOrder(lobbyId, key);
			const { current, order } = store.turnInfo(lobbyId);
			io.to(lobbyId).emit("player:death", {
				player: key,
				message: `${key} has fallen in battle!`,
			});
			io.to(lobbyId).emit("turn:update", { current, order });
		}
	}
}

// === INVENTORY UPDATES ===
/**
 * Processes a batch of inventory change entries for players in a lobby.
 * For each valid entry, applies the item quantity change in the store and
 * emits an `inventory:update` socket event to all lobby members containing
 * the updated item count, description, and attributes.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 * @param {object} store - The game state store with player/lobby mutation methods.
 * @param {string} lobbyId - The ID of the lobby to target.
 * @param {Array<{player: string, item: string, change: number, description?: string, attributes?: object}>} updates - Array of inventory change entries.
 * @returns {void}
 */
export function broadcastInventoryUpdates(io, store, lobbyId, updates) {
	for (const it of Array.isArray(updates) ? updates : []) {
		const change = Number(it?.change);
		if (!it?.player || !it?.item || isNaN(change)) continue;

		const key = store.findPlayerKey(lobbyId, normalizeName(it.player));
		if (!key) { console.warn(`[inventory:update] Player not found: ${it.player}`); continue; }

		const newCount = store.applyInventoryChange(lobbyId, key, it.item, change, it.description || "", it.attributes || {});

		io.to(lobbyId).emit("inventory:update", {
			player: key,
			item: it.item,
			change,
			newCount,
			description: it.description || "",
			attributes: it.attributes || {},
		});
	}
}

// === GOLD UPDATES ===
/**
 * Processes a batch of gold delta entries for players in a lobby.
 * For each valid entry, applies the gold change in the store and emits a
 * `gold:update` socket event to all lobby members with the player's new
 * gold total and the delta applied.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 * @param {object} store - The game state store with player/lobby mutation methods.
 * @param {string} lobbyId - The ID of the lobby to target.
 * @param {Array<{player: string, delta: number}>} updates - Array of gold delta entries.
 * @returns {void}
 */
export function broadcastGoldUpdates(io, store, lobbyId, updates) {
	for (const g of Array.isArray(updates) ? updates : []) {
		const delta = Number(g?.delta);
		if (!g?.player || isNaN(delta)) continue;

		const key = store.findPlayerKey(lobbyId, normalizeName(g.player));
		if (!key) { console.warn(`[gold:update] Player not found: ${g.player}`); continue; }

		const goldNow = store.applyGoldChange(lobbyId, key, delta);

		io.to(lobbyId).emit("gold:update", {
			player: key,
			gold: goldNow,
			delta,
		});
	}
}

// === CONDITIONS UPDATES ===
/**
 * Processes a batch of status condition changes for players in a lobby.
 * For each valid entry, applies the add/remove condition lists in the store
 * and emits a `conditions:update` socket event to all lobby members with
 * the player's resulting full condition set.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 * @param {object} store - The game state store with player/lobby mutation methods.
 * @param {string} lobbyId - The ID of the lobby to target.
 * @param {Array<{player: string, add?: string[], remove?: string[]}>} updates - Array of condition change entries.
 * @returns {void}
 */
export function broadcastConditionUpdates(io, store, lobbyId, updates) {
	for (const c of Array.isArray(updates) ? updates : []) {
		if (!c?.player) continue;

		const key = store.findPlayerKey(lobbyId, normalizeName(c.player));
		if (!key) { console.warn(`[conditions:update] Player not found: ${c.player}`); continue; }

		const conds = store.applyConditions(lobbyId, key, c.add || [], c.remove || []);

		io.to(lobbyId).emit("conditions:update", {
			player: key,
			conditions: conds,
		});
	}
}

// === PARTY SNAPSHOT ===
/**
 * Builds a snapshot of all connected players in a lobby and broadcasts it.
 * Reads current HP, max HP, level, conditions, death status, and spell slot
 * usage from the store, then emits a `party:update` socket event to all
 * lobby members. Disconnected players are excluded from the snapshot.
 * No-ops silently if the lobby or its players map does not exist.
 *
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 * @param {object} store - The game state store providing lobby and player data.
 * @param {string} lobbyId - The ID of the lobby to snapshot and broadcast.
 * @returns {void}
 */
export function broadcastPartyState(io, store, lobbyId) {
	const lobby = store.index[lobbyId];
	if (!lobby || !lobby.players) return;

	const members = Object.entries(lobby.players)
		.filter(([, p]) => !p.disconnected)
		.map(([name, p]) => ({
			name,
			hp: Number(p.stats?.hp ?? 0),
			max_hp: Number(p.stats?.max_hp ?? 1),
			status: p.dead ? "☠️ Dead" : (p.stats?.hp <= 0 ? "💀 Downed" : "Alive"),
			conditions: p.dead ? "Dead" : (Array.isArray(p.conditions) && p.conditions.length ? p.conditions.join(", ") : "None"),
			level: Number(p.level) || 1,
			spellSlotsUsed: Number(p.spellSlotsUsed) || 0,
		}));

	console.log("Sending party member update to status tracker:");
	console.log(JSON.stringify(members, null, 2));

	io.to(lobbyId).emit("party:update", { members, hostPlayer: store.hostPlayerName(lobbyId) || null });
}
