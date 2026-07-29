/**
 * Combat, phase, turn order, initiative, enemies, and death methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 */

import { roll, d20, mod } from "../../helpers/dice.js";
// "Is this an attack?" now has one answer, shared with the resolver that rolls it.
import { isAttackAction } from "../playerAttacks.js";
import { castingAbility } from "../spellbook.js";
import { difficultyModifiers } from "../../../client/difficulty.js";

/**
 * Orders two initiative entries, highest first.
 *
 * @description The single source of truth for turn order, shared by the opening roll
 * and by mid-game insertion so the two can never disagree. Ties fall back to the
 * dexterity modifier and then to the name: the name tiebreak is not flavour, it
 * guarantees a total order, so the same rolls always produce the same seating and
 * a rejoining player lands exactly where they were.
 *
 * @param {{name: string, dexMod: number, total: number}} a - First entry.
 * @param {{name: string, dexMod: number, total: number}} b - Second entry.
 * @returns {number} Negative if `a` acts first, positive if `b` does, 0 if identical.
 */
function compareInitiative(a, b) {
	if (b.total !== a.total) return b.total - a.total;
	if (b.dexMod !== a.dexMod) return b.dexMod - a.dexMod;
	return a.name.localeCompare(b.name);
}


/** Melee weapons that let a character swap strength for dexterity. */
const FINESSE_WEAPONS = /\b(dagger|shortsword|rapier|scimitar|whip|sickle)\b/i;

/** Verbs and implements that mean the attack is made at range. */
const RANGED_ACTION = /\b(shoot|shoots|shooting|fire|fires|firing|loose|bow|arrow|crossbow|sling|dart|javelin)\b/i;

/**
 * Chooses the ability score an attack is made with.
 *
 * @description The stat depends on the character and their weapon, not on the verb
 *   the player typed. Attacks used to be hardcoded to strength, which made a Rogue's
 *   Sneak Attack — matched on the literal word "Attack" — roll her worst stat, and
 *   made every bow shot a strength check.
 *
 *   Sneak Attack is named explicitly because it is a Rogue's signature and is always
 *   dexterity-based, regardless of what they happen to be holding.
 * @param {object} sheet - The character sheet.
 * @param {string} lower - The action text, lowercased.
 * @returns {string} `"str"` or `"dex"`.
 */
function attackStat(sheet, lower) {
	if (/sneak\s*attack/.test(lower)) return "dex";
	if (RANGED_ACTION.test(lower)) return "dex";

	const weapon = sheet?.weapon;
	if (weapon?.range && String(weapon.range).toLowerCase() === "ranged") return "dex";

	// A finesse weapon may use either, so use whichever the character is better at.
	if (weapon?.name && FINESSE_WEAPONS.test(weapon.name)) {
		return mod(Number(sheet?.stats?.dex) || 10) > mod(Number(sheet?.stats?.str) || 10) ? "dex" : "str";
	}

	return "str";
}

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
	 * Roll initiative for the whole party and build the turn order from the result.
	 *
	 * Order is `d20 + DEX modifier`, highest first — the standard 5e opening. The
	 * total is stored on each player as `initiativeTotal`, which is what makes a
	 * later arrival placeable: `insertIntoInitiative` compares against that same
	 * number rather than inventing its own ordering key.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {function(): number} [rollFn=d20] - Die source; injected so tests are
	 *   deterministic (`TDD-8`).
	 * @returns {Array<{name: string, roll: number, dexMod: number, total: number}>}
	 *   The rolls in final turn order, ready to announce to the table.
	 */
	rollInitiative(lobbyId, rollFn = d20) {
		const s = this.index[lobbyId];
		if (!s) return [];

		const rolls = Object.values(s.players)
			.filter((p) => p && !p.dead)
			.map((p) => {
				const dexMod = mod(Number(p.stats?.dex) || 10);
				const roll = rollFn();
				p.initiativeTotal = roll + dexMod;
				return { name: p.name, roll, dexMod, total: p.initiativeTotal };
			});

		rolls.sort(compareInitiative);

		s.initiative = rolls.map((r) => r.name);
		s.turnIndex = 0;
		s.round = 1;
		this.persist(lobbyId);
		return rolls;
	},
	/**
	 * Transition a lobby into the "running" phase and roll the opening turn order.
	 *
	 * Previously the order was simply `Object.keys(s.sockets)` — whoever's socket
	 * happened to be registered first. That made turn order an artifact of join
	 * timing and disagreed with the rejoin path, which sorted by raw DEX.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {function(): number} [rollFn=d20] - Die source, forwarded to
	 *   {@link rollInitiative}.
	 * @returns {Array<{name: string, roll: number, dexMod: number, total: number}>}
	 *   The initiative rolls, so the caller can announce them.
	 */
	startGame(lobbyId, rollFn = d20) {
		const s = this.index[lobbyId];
		if (!s) return [];
		s.phase = "running";
		const rolls = this.rollInitiative(lobbyId, rollFn);
		this.persist(lobbyId);
		return rolls;
	},
	/**
	 * Advance to the next living player, tracking when the order wraps into a new round.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {{ current: string|null, order: string[], round: number, roundAdvanced: boolean }}
	 *   The new turn state. `roundAdvanced` is true on the turn that begins a round,
	 *   which is the signal for anything that should happen once per round.
	 */
	nextTurn(lobbyId) {
		const s = this.index[lobbyId];
		if (!s || !s.initiative.length) {
			return { current: null, order: s?.initiative ?? [], round: s?.round ?? 1, roundAdvanced: false };
		}

		let next = (s.turnIndex + 1) % s.initiative.length;
		// Skip over dead players (guard against an all-dead infinite loop)
		for (let attempts = 0; attempts < s.initiative.length; attempts++) {
			if (!s.players[s.initiative[next]]?.dead) break;
			next = (next + 1) % s.initiative.length;
		}

		// Moving to an index at or before the current one means the order wrapped.
		// A one-player table wraps on every turn, which is correct: each of their
		// turns is a whole round.
		const roundAdvanced = next <= s.turnIndex;
		s.turnIndex = next;
		s.round = (s.round || 1) + (roundAdvanced ? 1 : 0);
		// Rejected-action strikes belong to the turn that earned them. Carrying them
		// forward would skip the next player for someone else's impossible ideas.
		s.turnAttempts = null;
		this.persist(lobbyId);

		return { current: s.initiative[next] || null, order: s.initiative, round: s.round, roundAdvanced };
	},
	/**
	 * Return the current active player, the full order, and the round number.
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {{ current: string|null, order: string[], round: number }} Turn state.
	 */
	turnInfo(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return { current: null, order: [], round: 1 };
		return { current: s.initiative[s.turnIndex] || null, order: s.initiative, round: s.round || 1 };
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

		if (isAttackAction(lower)) {
			kind = "attack";
			// Which stat an attack uses depends on the character and the weapon, not
			// on the verb. Hardcoding "str" here made a Rogue's Sneak Attack roll her
			// worst stat — it matched this branch on the literal word "Attack" before
			// the stealth branch could be reached — and made every bow shot a strength
			// check. Note this stays an attack: reordering the chain so "sneak" won
			// would have turned it into a stealth roll against the wrong DC.
			statKey = attackStat(sheet, lower);
		} else if (/(sneak|stealth|hide)/.test(lower)) {
			kind = "stealth";
			statKey = "dex";
		} else if (/(perceive|search|check|inspect|look)/.test(lower)) {
			kind = "perception";
			// Noticing things is wisdom, not intellect. This was "int", so a perceptive
			// character with a poor mind rolled perception at their weakest stat.
			statKey = "wis";
		} else if (/(cast|spell|arcana)/.test(lower)) {
			kind = "spell";
			// The class's own casting stat, not intelligence. This was `"int"` for every
			// caster, so a Cleric with WIS 18 and INT 8 cast at their worst stat on every
			// turn — the same defect `attackStat` fixed above for weapons.
			//
			// A non-caster falls back to intelligence rather than to nothing: this branch
			// also catches "I try to recall arcana", which is book knowledge and which a
			// Fighter may legitimately attempt. Returning null here would silently skip
			// the roll altogether.
			statKey = castingAbility(sheet.class) ?? "int";
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
			// The sign comes from the modifier itself; a literal plus in front of it
			// rendered "int++0" for zero and "int+-1" for a negative.
			kind: `d20 ${kind.toUpperCase()} (${statKey}${bonus >= 0 ? "+" : ""}${bonus})`,
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
				// They were last in the order, so the order has just wrapped, and a wrap
				// is what a round is. Swallowing it stalls the round counter — and
				// anything tracked per round, such as an enemy's one action, never comes
				// back. `nextTurn` cannot notice this later: by then the index is already
				// at the top and the wrap looks like an ordinary step.
				s.turnIndex = 0;
				s.round = (s.round || 1) + 1;
			}
		}
		// If idx > s.turnIndex, no adjustment needed

		this.persist(lobbyId);
	},
	/**
	 * Roll a player into the initiative order — used for mid-game joins and rejoins.
	 *
	 * Compares against `initiativeTotal`, the same key {@link rollInitiative} sorts by.
	 * The previous implementation compared the arriving player's raw DEX *score*
	 * against other players' raw DEX scores, in a list that had never been DEX-ordered
	 * in the first place, so an ordinary-DEX player reliably landed at index 0 and
	 * jumped the whole party. Rejoining a game visibly reshuffled the table.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player to place.
	 * @param {function(): number} [rollFn=d20] - Die source, injected for tests.
	 * @returns {number|null} The player's rolled initiative total, or `null` if the
	 *   lobby or player is unknown.
	 */
	insertIntoInitiative(lobbyId, playerName, rollFn = d20) {
		const s = this.index[lobbyId];
		if (!s) return null;

		const player = s.players?.[playerName];
		if (!player) return null;

		// Remove if somehow already present, so a rejoin never duplicates a seat.
		s.initiative = s.initiative.filter((p) => p !== playerName);

		const dexMod = mod(Number(player.stats?.dex) || 10);
		// A player who already rolled this game keeps that seat. Re-rolling on every
		// rejoin would both reshuffle the table under everyone and hand players a way
		// to re-roll a bad initiative by dropping their connection. Only someone with
		// no roll on record — a genuinely new arrival — rolls now.
		const total = Number.isFinite(player.initiativeTotal)
			? player.initiativeTotal
			: rollFn() + dexMod;
		player.initiativeTotal = total;

		const entry = { name: playerName, dexMod, total };
		let insertIdx = s.initiative.length;
		for (let i = 0; i < s.initiative.length; i++) {
			const other = s.players[s.initiative[i]];
			const otherEntry = {
				name: s.initiative[i],
				dexMod: mod(Number(other?.stats?.dex) || 10),
				total: Number(other?.initiativeTotal ?? 0),
			};
			if (compareInitiative(entry, otherEntry) < 0) {
				insertIdx = i;
				break;
			}
		}

		s.initiative.splice(insertIdx, 0, playerName);

		// Keep whoever is mid-turn on their turn: inserting ahead of them shifts
		// their index, so compensate.
		if (insertIdx <= s.turnIndex && s.initiative.length > 1) s.turnIndex++;

		this.persist(lobbyId);
		return total;
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
	 * @returns {Array<{name: string, cr: string|number}>} Enemies that died on this
	 *   update, each reported exactly once so XP can be awarded without paying the
	 *   party twice for a corpse the model re-sends. Empty on a malformed call.
	 */
	updateEnemies(lobbyId, enemyUpdates, { serverResolved = [], difficulty } = {}) {
		const s = this.index[lobbyId];
		if (!s || !Array.isArray(enemyUpdates)) return [];
		s.enemies = s.enemies || {};
		// Enemies whose hit points the server settled this turn. The mirror of
		// `stripResolvedDamage`: told plainly not to restate a resolved outcome, the
		// model restates it anyway, and its imagined number would overwrite the rolled
		// one — including reviving something it had just killed, or killing something
		// the dice left standing.
		const protectedNames = new Set(serverResolved.map((n) => String(n).toLowerCase()));
		const newlyDead = [];
		for (const e of enemyUpdates) {
			if (!e?.name) continue;
			const key = e.name;
			const isProtected = protectedNames.has(String(key).toLowerCase()) && s.enemies[key];
			if (!s.enemies[key]) {
				// Skip dead/fled enemies that don't already exist in the roster —
				// the LLM sometimes re-sends purged enemies after combat ends
				if (e.status === "dead" || e.status === "fled" || (Number(e.hp) || 0) <= 0) continue;
				// New enemy — store full stat block, scaled once by the difficulty.
				// Applied only here: rescaling on every update would inflate a
				// creature without bound as the model re-sends its block each turn.
				const toughness = difficultyModifiers(difficulty).enemyHpMultiplier;
				const scale = (value) => Math.max(1, Math.round((Number(value) || 10) * toughness));

				s.enemies[key] = {
					name: key,
					hp: scale(e.hp),
					max_hp: scale(e.max_hp || e.hp),
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
			} else if (!isProtected) {
				// Existing enemy — update HP and status
				if (e.hp != null) s.enemies[key].hp = Math.max(0, Number(e.hp));
				if (e.status) s.enemies[key].status = e.status;
			}
			// If HP hits 0, force dead status
			if (s.enemies[key].hp <= 0) {
				s.enemies[key].status = "dead";
				s.enemies[key].hp = 0;
			}

			// Report the transition to dead exactly once. The model re-sends enemy
			// blocks after combat ends, so without the flag the party would be paid
			// again for the same corpse on every later turn.
			if (s.enemies[key].status === "dead" && !s.enemies[key].xpAwarded) {
				s.enemies[key].xpAwarded = true;
				newlyDead.push({ name: key, cr: s.enemies[key].cr });
			}
		}
		this.persist(lobbyId);
		return newlyDead;
	},

	/**
	 * Applies damage the server rolled to an enemy.
	 *
	 * @description Player damage used to be whatever the model wrote into an `enemies`
	 *   block, so a weapon's dice, a character's strength and the loot engine's `+N`
	 *   were all decoration. This is where a rolled blow actually lands.
	 *
	 *   The death is reported exactly once, guarded by the same `xpAwarded` flag
	 *   `updateEnemies` uses, so a corpse cannot be paid for twice however many times
	 *   it is struck afterwards.
	 * @param {string} lobbyId - The lobby.
	 * @param {string} name - The enemy's name, as it appears on the roster.
	 * @param {number} amount - Damage to apply; anything not a positive number is ignored.
	 * @returns {{enemy: object, died: boolean}|null} The enemy after the blow and
	 *   whether this blow killed it, or null when there is no such enemy.
	 */
	applyEnemyDamage(lobbyId, name, amount) {
		const s = this.index[lobbyId];
		const enemy = s?.enemies?.[name];
		if (!enemy) return null;

		const dealt = Number(amount);
		if (!Number.isFinite(dealt) || dealt <= 0) return { enemy, died: false };

		enemy.hp = Math.max(0, (Number(enemy.hp) || 0) - dealt);

		let died = false;
		if (enemy.hp === 0) {
			enemy.status = "dead";
			if (!enemy.xpAwarded) {
				enemy.xpAwarded = true;
				died = true;
			}
		}

		this.persist(lobbyId);
		return { enemy, died };
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
