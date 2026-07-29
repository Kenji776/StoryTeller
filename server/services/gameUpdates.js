// === gameUpdates.js ===
// Unified + normalized version
import { normalizeName } from "../helpers/utils.js";
import { getAbilityForLevel } from "../helpers/classProgression.js";

/**
 * Where dropped updates are reported. Configured once at startup, following the
 * same pattern as `assetDownloads.configure`.
 *
 * A dropped update is the worst kind of failure this system has: the Dungeon
 * Master narrates that a player took nine damage, the name it used matches no
 * character, and the update vanishes. The player watches their HP not change and
 * has no idea why. A console warning on the server helps nobody who is playing.
 */
let incidents = null;

/**
 * @description Supplies the incident log used to report dropped updates.
 * @param {object} deps - Configuration.
 * @param {object} deps.incidents - An incident log from `createIncidentLog`.
 * @returns {void}
 */
export function configureUpdates({ incidents: log } = {}) {
	incidents = log ?? null;
}

/**
 * @description Reports an update that could not be applied because the character it
 *   named does not exist in the lobby.
 * @param {string} lobbyId - The lobby.
 * @param {string} event - Which update was lost, e.g. `"hp:update"`.
 * @param {string} named - The name the Dungeon Master used.
 * @param {string[]} known - The character names that do exist, to make the mismatch obvious.
 * @returns {void}
 */
function reportDropped(lobbyId, event, named, known) {
	console.warn(`[${event}] Player not found: ${named}`);
	incidents?.raise(lobbyId, {
		kind: "update_dropped",
		severity: "error",
		message: `${event} was discarded: the DM referred to "${named}", who is not in this game.`,
		detail: { event, named, known },
		suggestedFix: `Apply the change by hand to the intended character, then check whether the DM is using a stale name.`,
	});
}


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
		if (!key) { reportDropped(lobbyId, "xp:update", x.player, Object.keys(store.index[lobbyId]?.players || {})); continue; }

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
				io.to(sid).emit("player:levelup", {
					newLevel: newLvl,
					upcomingAbility: upcomingAbility || null,
					// A caster picks one spell per level. Offered for the level they are about
					// to reach, so a tier this level-up unlocks is pickable on the level-up that
					// unlocks it. Empty for a non-caster, and the window hides the picker.
					spellChoices: store.spellChoices ? store.spellChoices(lobbyId, key, newLvl) : [],
				});
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
		if (!key) { reportDropped(lobbyId, "hp:update", h.player, Object.keys(store.index[lobbyId]?.players || {})); continue; }

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
			io.to(lobbyId).emit("player:death", {
				player: key,
				message: `${key} has fallen in battle!`,
			});
			io.to(lobbyId).emit("turn:update", store.turnInfo(lobbyId));
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
		if (!key) { reportDropped(lobbyId, "inventory:update", it.player, Object.keys(store.index[lobbyId]?.players || {})); continue; }

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
		if (!key) { reportDropped(lobbyId, "gold:update", g.player, Object.keys(store.index[lobbyId]?.players || {})); continue; }

		const goldNow = store.applyGoldChange(lobbyId, key, delta);

		io.to(lobbyId).emit("gold:update", {
			player: key,
			gold: goldNow,
			delta,
			// Carried like hp:update already does. Without it the admin feed defaulted
			// to "Manual change", labelling every story-driven change as an admin edit.
			reason: g.reason || "",
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
		if (!key) { reportDropped(lobbyId, "conditions:update", c.player, Object.keys(store.index[lobbyId]?.players || {})); continue; }

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

// === ABILITY UPDATES ===
/**
 * Applies ability grants and losses from a DM response.
 *
 * The prompt has always told the Dungeon Master it may return
 * `updates.abilities` with `change_type: "add" | "remove"`
 * (`lobbyPrompts.js`), but no dispatch path read the field — so every ability the
 * DM granted was silently discarded, and a player promised a new power never got
 * it. This is the missing consumer.
 *
 * The advertised schema says `attributes` while every other ability in the game
 * uses `details`; both are accepted rather than making the model guess which one
 * this call wants.
 *
 * @param {import('socket.io').Server} io - Socket.IO server (or the sequencing facade).
 * @param {object} store - The game state store.
 * @param {string} lobbyId - The lobby to update.
 * @param {Array<{player: string, change_type: string, name: string, description?: string,
 *   attributes?: object, details?: object}>} updates - Ability changes from the DM.
 * @returns {void}
 */
export function broadcastAbilityUpdates(io, store, lobbyId, updates) {
	for (const a of Array.isArray(updates) ? updates : []) {
		if (!a?.player || !a?.name || typeof a.name !== "string") continue;

		const change = String(a.change_type || "add").toLowerCase();
		const key = store.findPlayerKey(lobbyId, normalizeName(a.player));
		if (!key) {
			reportDropped(lobbyId, "abilities:update", a.player, Object.keys(store.index[lobbyId]?.players || {}));
			continue;
		}

		if (change === "remove") {
			const removed = store.removeAbility?.(lobbyId, key, a.name);
			if (!removed) continue;
		} else {
			store.addAbility(lobbyId, key, {
				name: a.name,
				description: a.description || "",
				details: a.details ?? a.attributes ?? {},
			});
		}

		const player = store.index[lobbyId]?.players?.[key];
		io.to(lobbyId).emit("abilities:update", {
			player: key,
			change,
			name: a.name,
			description: a.description || "",
			abilities: Array.isArray(player?.abilities) ? player.abilities : [],
		});
	}
}
