/**
 * Player management, connections, and socket methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 */

import { randomUUID } from "crypto";

const XP_THRESHOLDS = [
	0, 300, 900, 2700, 6500,           // 1-5
	14000, 23000, 34000, 48000, 64000,  // 6-10
	85000, 100000, 120000, 140000, 165000, // 11-15
	195000, 225000, 265000, 305000, 355000, // 16-20
	400000, 450000, 500000, 560000, 620000, // 21-25
];

const defaults = {
	name: "none",
	class: "Adventurer",
	level: 1,
	xp: 0,
	stats: { hp: 10, mana: 0, str: 10, dex: 10, int: 10 },
	gold: 0,
	conditions: [],
	abilities: [],
	inventory: [],
	description: "",
	spellSlotsUsed: 0,
	trinket: null,   // { name, description, attributes }
};

export const playerMethods = {
	// ==== Connections ====

	/**
	 * Register a new socket connection to a lobby and persist the change.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID to associate.
	 * @returns {void}
	 */
	addConnection(lobbyId, sid) {
		this.socketsAdd(lobbyId, sid);
		this.persist(lobbyId);
	},
	/**
	 * Remove a socket from every lobby it belongs to and persist each affected lobby.
	 * @param {string} sid - The socket ID to remove.
	 * @returns {string[]} Array of lobbyIds from which the socket was removed.
	 */
	removeConnection(sid) {
		const affected = [];
		for (const [lobbyId, s] of Object.entries(this.index)) {
			if (s.sockets[sid]) {
				delete s.sockets[sid];
				affected.push(lobbyId);
				this.persist(lobbyId);
			}
		}
		return affected;
	},
	/**
	 * Ensure a socket entry exists in the lobby's sockets map, creating a default record if absent.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID to add.
	 * @returns {void}
	 */
	socketsAdd(lobbyId, sid) {
		const s = this.index[lobbyId];
		s.sockets[sid] = s.sockets[sid] || { playerName: null, ready: false };
	},
	/**
	 * Check whether a given socket is the host of a lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID to check.
	 * @returns {boolean} `true` if the socket is the lobby host.
	 */
	isHost(lobbyId, sid) {
		const s = this.index[lobbyId];
		return s && s.hostSid === sid;
	},
	/**
	 * Resolve the player name of the lobby host via their stored `hostCharacterId`.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {string|null} The host's player name, or `null` if not found.
	 */
	hostPlayerName(lobbyId) {
		const s = this.index[lobbyId];
		if (!s || !s.hostCharacterId) return null;
		const entry = Object.entries(s.players || {}).find(([, p]) => p.characterId === s.hostCharacterId);
		return entry ? entry[0] : null;
	},
	/**
	 * Check whether a socket belongs to a specific lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID to check.
	 * @returns {boolean} `true` if the socket has an entry in the lobby.
	 */
	belongs(lobbyId, sid) {
		const s = this.index[lobbyId];
		return !!(s && s.sockets[sid]);
	},

	// ==== Player Management ====

	/**
	 * Create or update a player's character sheet in a lobby.
	 * Merges the incoming sheet with defaults and existing server-authoritative data
	 * (XP, level, gold, HP, conditions, abilities, weapon, armor, trinket, characterId)
	 * so that a mid-game re-save cannot roll back runtime state.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID of the player saving the sheet.
	 * @param {string} name - The player's character name.
	 * @param {Object} sheet - Partial or full character sheet data to merge.
	 * @returns {void}
	 */
	upsertPlayer(lobbyId, sid, name, sheet) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.sockets[sid] = s.sockets[sid] || { playerName: null, ready: false };

		// Clean up old player entry when name changes
		const oldName = s.sockets[sid].playerName;
		if (oldName && oldName !== name && s.players[oldName]) {
			delete s.players[oldName];
		}

		s.sockets[sid].playerName = name;
		const existing = s.players[name] || {};
		const merged = { ...defaults, ...(sheet || {}), name };
		// Ensure numeric fields are always numbers, never strings
		merged.level = Number(merged.level) || 1;
		merged.xp    = Number(merged.xp)    || 0;
		merged.gold  = Number(merged.gold)  || 0;

		// If the class changed during character creation, clear the start-level
		// init flag so initializeAtLevel() will re-run with the new class.
		const classChanged = existing.class && existing.class !== merged.class;
		if (classChanged && s.phase !== "running") {
			delete existing._startLevelInit;
		}

		// Preserve max_hp across re-saves; initialize from hp on first save
		if (merged.stats) {
			merged.stats.max_hp = existing.stats?.max_hp ?? merged.stats.hp ?? 10;
		}
		// Preserve generated image URL across sheet re-saves
		if (existing.imageUrl && !merged.imageUrl) merged.imageUrl = existing.imageUrl;
		// Preserve weapon, armor, and trinket if the new sheet didn't supply one
		if (existing.weapon  && !merged.weapon)  merged.weapon  = existing.weapon;
		if (existing.armor   && !merged.armor)   merged.armor   = existing.armor;
		if (existing.trinket && !merged.trinket)  merged.trinket = existing.trinket;
		// Preserve characterId across re-saves; assign one on first save
		merged.characterId = existing.characterId || randomUUID();
		// If this is the host's first character save, record their characterId
		if (s.hostSid === sid && !s.hostCharacterId) {
			s.hostCharacterId = merged.characterId;
		}
		// Preserve spell slots used — never overwrite with stale client data
		merged.spellSlotsUsed = existing.spellSlotsUsed ?? 0;

		// Preserve all server-authoritative runtime fields so a mid-game sheet
		// re-save (e.g. name change) cannot roll back XP, level, gold, HP, or
		// conditions/abilities that were set during the session.
		if (existing.level  > merged.level)  merged.level  = existing.level;
		if (existing.xp     > merged.xp)     merged.xp     = existing.xp;
		if (existing.gold   > merged.gold)    merged.gold   = existing.gold;
		if (existing.stats?.hp  != null && !classChanged)
			merged.stats.hp  = existing.stats.hp;
		if (Array.isArray(existing.conditions) && existing.conditions.length)
			merged.conditions = existing.conditions;
		if (Array.isArray(existing.abilities)  && existing.abilities.length > (merged.abilities?.length ?? 0) && !classChanged)
			merged.abilities  = existing.abilities;

		// Carry forward the init flag (unless cleared above for class change)
		if (existing._startLevelInit && !classChanged) {
			merged._startLevelInit = existing._startLevelInit;
		}

		s.players[name] = merged;
		this.persist(lobbyId);
	},
	/**
	 * Set the ready state for a socket's player slot in a lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID whose ready flag to update.
	 * @param {boolean} ready - The desired ready state.
	 * @returns {void}
	 */
	setReady(lobbyId, sid, ready) {
		const s = this.index[lobbyId];
		if (!s || !s.sockets[sid]) return;
		s.sockets[sid].ready = !!ready;
		this.persist(lobbyId);
	},
	/**
	 * Check whether all connected sockets in a lobby are ready and have a player name.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {boolean} `true` if at least one connection exists and every connection is ready.
	 */
	allReady(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const conns = Object.values(s.sockets);
		return conns.length > 0 && conns.every((c) => c.ready && c.playerName);
	},
	/**
	 * Look up a player's name and sheet using their socket ID.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} sid - The socket ID to look up.
	 * @returns {{ name: string, sheet: Object }|null} Player record, or `null` if not found.
	 */
	playerBySid(lobbyId, sid) {
		const s = this.index[lobbyId];
		const rec = s?.sockets[sid];
		if (!s || !rec || !rec.playerName) return null;
		return { name: rec.playerName, sheet: s.players[rec.playerName] };
	},
	/**
	 * Resolve the socket ID for a player by their character name.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} playerName - The character name to search for.
	 * @returns {string|null} The socket ID, or `null` if the player is not connected.
	 */
	sidByPlayerName(lobbyId, playerName) {
		const s = this.index[lobbyId];
		if (!s) return null;
		const entry = Object.entries(s.sockets).find(([sid, rec]) => rec.playerName === playerName);
		return entry ? entry[0] : null;
	},
	/**
	 * Find the canonical player key in `lobby.players` using a case-insensitive name match.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} name - The player name to search for (trimmed, case-insensitive).
	 * @returns {string|null} The matching key as stored, or `null` if not found.
	 */
	findPlayerKey(lobbyId, name) {
		const s = this.index[lobbyId];
		if (!s || !name) return null;
		const search = String(name).trim();
		if (s.players[search]) return search;
		const lower = search.toLowerCase();
		return Object.keys(s.players).find(k => k.toLowerCase() === lower) ?? null;
	},
	/**
	 * Remove a player and their socket entry from a lobby, then persist the change.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} playerName - The character name of the player to kick.
	 * @returns {string|undefined} The kicked socket ID, or `undefined` if no socket was found.
	 */
	kickPlayer(lobbyId, playerName) {
		const l = this.index[lobbyId];
		if (!l) return null;
		const sid = Object.entries(l.sockets || {}).find(([, v]) => v.playerName === playerName)?.[0];
		delete l.players[playerName];
		if (sid) delete l.sockets[sid];
		this.persist(lobbyId);
		return sid;
	},

	// ==== Missed turns ====

	/**
	 * Increment a player's missed-turn counter and persist the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} playerName - The character name of the player.
	 * @returns {number} The updated missed-turn count, or `0` if the player was not found.
	 */
	incrementMissedTurns(lobbyId, playerName) {
		const s = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName) || playerName;
		if (!s?.players[key]) return 0;
		s.players[key].missedTurns = (s.players[key].missedTurns || 0) + 1;
		this.persist(lobbyId);
		return s.players[key].missedTurns;
	},
	/**
	 * Reset a player's missed-turn counter to zero and persist the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} playerName - The character name of the player.
	 * @returns {void}
	 */
	resetMissedTurns(lobbyId, playerName) {
		const s = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName) || playerName;
		if (!s?.players[key]) return;
		s.players[key].missedTurns = 0;
		this.persist(lobbyId);
	},

	/**
	 * Initialize a player to the lobby's configured starting level.
	 * Grants HP (1d6 + CON mod per level), class abilities, spell slots, and XP for all
	 * levels above 1. Idempotent — guarded by a `_startLevelInit` flag so re-saves
	 * during character creation cannot re-apply the bonus.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} playerName - The character name of the player to initialize.
	 * @param {Function|null} getAbilityForLevel - Optional callback `(className, level) => ability|null`
	 *   used to grant class abilities for each level gained.
	 * @returns {void}
	 */
	initializeAtLevel(lobbyId, playerName, getAbilityForLevel) {
		const s = this.index[lobbyId];
		if (!s) return;
		const startLvl = Number(s.startingLevel) || 1;
		if (startLvl <= 1) return; // nothing to do

		const p = s.players[playerName];
		if (!p) return;

		// Already initialized for this starting level — skip
		if (p._startLevelInit >= startLvl) return;

		p.stats = p.stats || { hp: 10, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
		const con = Number(p.stats.con) || 10;
		const conMod = Math.floor((con - 10) / 2);

		// Always start from level 2 (level 1 is the base) so we grant
		// everything regardless of what level the client sent.
		// NOTE: Attribute points are NOT granted here — the client's point-buy
		// budget already scales with level (+2 per level above 1).
		let totalHpGained = 0;

		for (let lvl = 2; lvl <= startLvl; lvl++) {
			// HP: 1d6 + CON mod (min 1)
			const hpRoll = Math.floor(Math.random() * 6) + 1;
			const hpGained = Math.max(1, hpRoll + conMod);
			totalHpGained += hpGained;

			// Class ability
			if (getAbilityForLevel) {
				const ability = getAbilityForLevel(p.class, lvl);
				if (ability) {
					p.abilities = Array.isArray(p.abilities) ? p.abilities : [];
					if (!p.abilities.some(a => a.name === ability.name)) {
						p.abilities.push({ ...ability, level: lvl });
					}
				}
			}
		}

		// Apply accumulated changes — HP starts from base 10
		p.level = startLvl;
		p.stats.hp = 10 + totalHpGained;
		p.stats.max_hp = 10 + totalHpGained;
		p.spellSlotsUsed = 0;
		p.xp = XP_THRESHOLDS[startLvl - 1] || 0;
		p._startLevelInit = startLvl;

		this.persist(lobbyId);
	},
};
