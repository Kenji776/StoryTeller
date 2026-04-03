// === gameUpdates.js ===
// Unified + normalized version
import { normalizeName } from "./utils.js";
import { getAbilityForLevel } from "./classProgression.js";


// === XP UPDATES ===
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
