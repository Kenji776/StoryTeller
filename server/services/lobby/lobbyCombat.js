/**
 * Combat, phase, turn order, initiative, enemies, and death methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 */

import { roll, d20, mod } from "../../helpers/dice.js";

export const combatMethods = {
	// ==== Phase / Turn ====
	/**
	 * Set the phase of a lobby (e.g. "running", "paused", "completed").
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} phase - The new phase string to assign.
	 * @returns {void}
	 */
	setPhase(lobbyId, phase) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.phase = phase;
		this.persist(lobbyId);
	},
	/**
	 * Transition a lobby into the "running" phase and build the initial turn order
	 * from all connected sockets that have an assigned playerName.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {void}
	 */
	startGame(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.phase = "running";
		const order = [];
		for (const sid of Object.keys(s.sockets)) {
			const pn = s.sockets[sid].playerName;
			if (pn) order.push(pn);
		}
		s.initiative = [...new Set(order)];
		s.turnIndex = 0;
		this.persist(lobbyId);
	},
	/**
	 * Advance the turn index to the next living player in the initiative order,
	 * skipping over any dead players. Guards against an all-dead infinite loop.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {void}
	 */
	nextTurn(lobbyId) {
		const s = this.index[lobbyId];
		if (!s || !s.initiative.length) return;
		let next = (s.turnIndex + 1) % s.initiative.length;
		// Skip over dead players (guard against all-dead infinite loop)
		for (let attempts = 0; attempts < s.initiative.length; attempts++) {
			if (!s.players[s.initiative[next]]?.dead) break;
			next = (next + 1) % s.initiative.length;
		}
		s.turnIndex = next;
		this.persist(lobbyId);
	},
	/**
	 * Return the current active player name and the full initiative order.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {{ current: string|null, order: string[] }} Current turn name and ordered array of player names.
	 */
	turnInfo(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return { current: null, order: [] };
		return { current: s.initiative[s.turnIndex] || null, order: s.initiative };
	},

	// ==== Actions / Dice ====
	/**
	 * Validate whether a player action is allowed given the current lobby state and turn order.
	 * Also wakes a non-terminal paused lobby back to "running" when an action is submitted.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} sid - The socket ID of the acting player.
	 * @param {string} text - The raw action text submitted by the player.
	 * @returns {{ ok: boolean, reason?: string, tableTalk?: boolean }} Validation result.
	 */
	validateAction(lobbyId, sid, text) {
		const s = this.index[lobbyId];
		if (!s) return { ok: false, reason: "Lobby missing" };
		// A player submitting an action is the definitive signal the game
		// should be running.  Wake it from hibernating/paused/etc.
		if (s.phase !== "running") {
			const terminal = ["completed", "wiped"];
			if (terminal.includes(s.phase)) return { ok: false, reason: "Game is over" };
			console.log(`▶️ Lobby ${lobbyId} phase "${s.phase}" → "running" (action submitted)`);
			s.phase = "running";
			this.persist(lobbyId);
		}
		const actor = this.playerBySid(lobbyId, sid);
		if (!actor) return { ok: false, reason: "Unknown player" };
		if (actor.sheet?.dead) {
			return { ok: false, reason: `${actor.name} is dead and cannot act.` };
		}
		const current = s.initiative[s.turnIndex];
		const isTurn = actor.name === current;
		const tableTalk = /^\s*(ooc|table|talk)\b|^\s*\(.*\)\s*$/.test(text.toLowerCase());
		if (!isTurn && !tableTalk) return { ok: false, reason: "Not your turn", tableTalk: false };
		return { ok: true, tableTalk };
	},
	/**
	 * Detect action keywords in the player's text and automatically perform a d20 skill roll
	 * using the relevant ability modifier from their character sheet.
	 * Returns null if no roll-triggering keyword is found.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} sid - The socket ID of the acting player.
	 * @param {string} text - The raw action text to scan for keywords.
	 * @returns {{ lobbyId: string, player: string, kind: string, value: number, detail: object, source: string }|null} Roll result payload, or null.
	 */
	autoRollIfNeeded(lobbyId, sid, text) {
		const s = this.index[lobbyId];
		if (!s) return null;
		const actor = this.playerBySid(lobbyId, sid);
		if (!actor) return null;
		const sheet = actor.sheet || {};
		const lower = text.toLowerCase();
		let kind = null,
			statKey = null;

		if (/(attack|strike|shoot|swing)/.test(lower)) {
			kind = "attack";
			statKey = "str";
		} else if (/(sneak|stealth|hide)/.test(lower)) {
			kind = "stealth";
			statKey = "dex";
		} else if (/(perceive|search|check|inspect|look)/.test(lower)) {
			kind = "perception";
			statKey = "int";
		} else if (/(cast|spell|arcana)/.test(lower)) {
			kind = "spell";
			statKey = "int";
		}

		if (!kind) return null;

		const base = d20();
		const bonus = mod(sheet.stats?.[statKey] ?? 10);
		const total = base + bonus;
		let outcome = "fail";
		if (total >= 15) outcome = "success";
		else if (total >= 8) outcome = "mixed";

		const payload = {
			lobbyId,
			player: actor.name,
			kind: `d20 ${kind.toUpperCase()} (${statKey}+${bonus >= 0 ? "+" : ""}${bonus})`,
			value: total,
			detail: { base, bonus, stat: statKey, outcome },
			source: "server",
		};
		s.lastServerOutcome = payload;
		this.persist(lobbyId);
		return payload;
	},

	// ==== Initiative management ====
	/**
	 * Remove a player from the initiative order and adjust the current turn index
	 * so that the same player retains their turn after the removal.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The display name of the player to remove.
	 * @returns {void}
	 */
	removeFromTurnOrder(lobbyId, playerName) {
		const s = this.index[lobbyId];
		if (!s) return;
		const key = this.findPlayerKey(lobbyId, playerName) || playerName;
		const idx = s.initiative?.indexOf(key) ?? -1;
		if (idx === -1) return;

		s.initiative = s.initiative.filter((p) => p !== key);

		if (s.initiative.length === 0) {
			s.turnIndex = 0;
		} else if (idx < s.turnIndex) {
			// Removed player was before current — shift index back so same player stays current
			s.turnIndex = Math.max(0, s.turnIndex - 1);
		} else if (idx === s.turnIndex) {
			// Removed player was the current turn — next player slides into this slot
			if (s.turnIndex >= s.initiative.length) {
				s.turnIndex = 0;
			}
		}
		// If idx > s.turnIndex, no adjustment needed

		this.persist(lobbyId);
	},
	/**
	 * Insert a new player into the initiative order based on their DEX score.
	 * Higher DEX = earlier position. Adjusts turnIndex so the current turn is unaffected.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The display name of the player to insert.
	 * @param {number} [dex=8] - The player's DEX score used to determine insertion position.
	 * @returns {number} The index at which the player was inserted.
	 */
	insertIntoInitiative(lobbyId, playerName, dex = 8) {
		const s = this.index[lobbyId];
		if (!s) return;

		// Remove if somehow already present
		s.initiative = s.initiative.filter((p) => p !== playerName);

		// Find the first existing player whose DEX is <= the new player's DEX
		let insertIdx = s.initiative.length;
		for (let i = 0; i < s.initiative.length; i++) {
			const pDex = s.players[s.initiative[i]]?.stats?.dex ?? 8;
			if (dex >= pDex) {
				insertIdx = i;
				break;
			}
		}

		s.initiative.splice(insertIdx, 0, playerName);

		// If inserted at or before current position, shift turnIndex forward
		// so the same player retains their turn
		if (insertIdx <= s.turnIndex && s.initiative.length > 1) {
			s.turnIndex++;
		}

		this.persist(lobbyId);
		return insertIdx;
	},

	// ==== Death / TPK ====
	/**
	 * Check whether every connected (non-disconnected) player in the lobby is dead.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {boolean} True if all active players are dead, false otherwise.
	 */
	checkAllDead(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const active = Object.values(s.players).filter(p => !p.disconnected);
		if (!active.length) return false;
		return active.every(p => p.dead);
	},
	/**
	 * Mark a player as dead and set their HP to zero.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The display name of the player to mark dead.
	 * @returns {void}
	 */
	markPlayerDead(lobbyId, playerName) {
		const s = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!s || !key) return;
		s.players[key].dead = true;
		s.players[key].stats = s.players[key].stats || {};
		s.players[key].stats.hp = 0;
		this.persist(lobbyId);
	},

	// ==== Enemy Tracking ====
	/**
	 * Update the enemy roster from LLM response data.
	 * Each entry can introduce a new enemy, update HP/status, or mark one dead/fled.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {Array<{ name: string, hp?: number, max_hp?: number, ac?: number, str?: number, dex?: number, con?: number, int?: number, wis?: number, cha?: number, cr?: string|number, status?: string }>} enemyUpdates - Array of enemy stat blocks or partial updates from the LLM.
	 * @returns {void}
	 */
	updateEnemies(lobbyId, enemyUpdates) {
		const s = this.index[lobbyId];
		if (!s || !Array.isArray(enemyUpdates)) return;
		s.enemies = s.enemies || {};
		for (const e of enemyUpdates) {
			if (!e?.name) continue;
			const key = e.name;
			if (!s.enemies[key]) {
				// New enemy — store full stat block
				s.enemies[key] = {
					name: key,
					hp: Number(e.hp) || 10,
					max_hp: Number(e.max_hp || e.hp) || 10,
					ac: Number(e.ac) || 10,
					str: Number(e.str) || 10,
					dex: Number(e.dex) || 10,
					con: Number(e.con) || 10,
					int: Number(e.int) || 10,
					wis: Number(e.wis) || 10,
					cha: Number(e.cha) || 10,
					cr: String(e.cr ?? "0"),
					status: "active",
				};
			} else {
				// Existing enemy — update HP and status
				if (e.hp != null) s.enemies[key].hp = Math.max(0, Number(e.hp));
				if (e.status) s.enemies[key].status = e.status;
			}
			// If HP hits 0, force dead status
			if (s.enemies[key].hp <= 0) {
				s.enemies[key].status = "dead";
				s.enemies[key].hp = 0;
			}
		}
		this.persist(lobbyId);
	},

	/**
	 * Remove all dead and fled enemies from the roster.
	 * Called when combat ends to clean up the enemy list.
	 * @param {string} lobbyId - The lobby identifier.
	 */
	purgeDeadEnemies(lobbyId) {
		const s = this.index[lobbyId];
		if (!s?.enemies) return;
		for (const key of Object.keys(s.enemies)) {
			if (s.enemies[key].status === "dead" || s.enemies[key].status === "fled") {
				delete s.enemies[key];
			}
		}
		this.persist(lobbyId);
	},

	/**
	 * Get a formatted multi-line string of the enemy roster for inclusion in LLM prompts.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {string} Formatted roster string, or empty string if no enemies exist.
	 */
	enemyRoster(lobbyId) {
		const s = this.index[lobbyId];
		if (!s?.enemies) return "";
		const entries = Object.values(s.enemies);
		if (!entries.length) return "";
		const lines = entries.map(e => {
			if (e.status === "dead") return `  - ${e.name} [CR ${e.cr}] — ☠️ DEAD`;
			if (e.status === "fled") return `  - ${e.name} [CR ${e.cr}] — FLED`;
			return `  - ${e.name} [CR ${e.cr}]: HP ${e.hp}/${e.max_hp}, AC ${e.ac} | STR ${e.str} DEX ${e.dex} CON ${e.con} INT ${e.int} WIS ${e.wis} CHA ${e.cha}`;
		}).join("\n");
		return lines;
	},
};
