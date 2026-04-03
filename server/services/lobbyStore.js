import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from "crypto";
import { roll, d20, mod } from "./dice.js";
import { getLLMResponse, hasLLM, sanitizeForLLMName, getDefaultLLMSettings } from "./llmService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOB_DIR = path.join(__dirname, "..", "data", "lobbies");

function randCode(len = 6) {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let s = "";
	for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
	return s;
}
function now() {
	return Date.now();
}

// XP thresholds — index = level-1, value = XP required to reach that level.
// Levels 1-20 follow D&D 5e; 21-25 extrapolate beyond the standard range.
const XP_THRESHOLDS = [
	0, 300, 900, 2700, 6500,           // 1-5
	14000, 23000, 34000, 48000, 64000,  // 6-10
	85000, 100000, 120000, 140000, 165000, // 11-15
	195000, 225000, 265000, 305000, 355000, // 16-20
	400000, 450000, 500000, 560000, 620000, // 21-25
];

// Human-readable power-tier label for each level, used in LLM prompts so the
// AI understands the characters' relative strength in plain-English terms.
const LEVEL_FLAVOR = {
	1:  "ordinary commoner",
	2:  "apprentice adventurer",
	3:  "fledgling hero",
	4:  "seasoned wanderer",
	5:  "veteran adventurer",
	6:  "rising champion",
	7:  "renowned warrior",
	8:  "regional legend",
	9:  "elite hero",
	10: "master of the craft",
	11: "realm-shaker",
	12: "archmage-tier",
	13: "legendary figure",
	14: "mythic champion",
	15: "planar traveller",
	16: "world-breaker",
	17: "demi-legend",
	18: "near-divine",
	19: "titan-slayer",
	20: "apex mortal",
	21: "ascendant",
	22: "demigod",
	23: "avatar of power",
	24: "elder god's equal",
	25: "living deity",
};
function levelFlavorTag(lvl) {
	return LEVEL_FLAVOR[lvl] || LEVEL_FLAVOR[Math.min(25, Math.max(1, lvl))] || "adventurer";
}

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

export class LobbyStore {
	constructor() {
		if (!fs.existsSync(LOB_DIR)) fs.mkdirSync(LOB_DIR, { recursive: true });
		this.index = {};
		this.codeMap = {};
		this.rehydrate();
	}

	// ==== Persistence ====
	rehydrate() {
		const files = fs.readdirSync(LOB_DIR).filter((f) => f.endsWith(".json"));
		for (const f of files) {
			const s = JSON.parse(fs.readFileSync(path.join(LOB_DIR, f), "utf-8"));
			this.index[s.lobbyId] = s;
			this.codeMap[s.code] = s.lobbyId;
		}
	}

	// Sync phase + adventureName from disk without overwriting live socket/connection state.
	// Called before serving the lobby list so manual edits are visible on refresh.
	syncMetaFromDisk() {
		const files = fs.readdirSync(LOB_DIR).filter((f) => f.endsWith(".json"));
		for (const f of files) {
			try {
				const s = JSON.parse(fs.readFileSync(path.join(LOB_DIR, f), "utf-8"));
				if (this.index[s.lobbyId]) {
					this.index[s.lobbyId].phase = s.phase;
					this.index[s.lobbyId].adventureName = s.adventureName;
					this.index[s.lobbyId].lastActivity = s.lastActivity;
				} else {
					this.index[s.lobbyId] = s;
					this.codeMap[s.code] = s.lobbyId;
				}
			} catch (e) { /* skip corrupt files */ }
		}
	}
	persist(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return;
		fs.writeFileSync(path.join(LOB_DIR, `${lobbyId}.json`), JSON.stringify(s, null, 2));
	}

	deleteLobby(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const filePath = path.join(LOB_DIR, `${lobbyId}.json`);
		delete this.codeMap[s.code];
		delete this.index[lobbyId];
		try { fs.unlinkSync(filePath); } catch (_) {}
		return true;
	}

	// ==== Lobby lifecycle ====
	createLobby(hostSid, defaultNarratorVoiceId = null) {
		const lobbyId = Math.random()
			.toString(36)
			.slice(2, 8);
		const code = randCode();
		const state = {
			lobbyId,
			code,
			createdAt: now(),
			lastActivity: now(),
			phase: "waiting",
			hostSid,
			chat: [],
			players: {},
			sockets: {},
			history: [],
			summarizedUpTo: 0,
			storyContext: "—",
			ancientHistory: "",
			pinnedMoments: [],
			initiative: [],
			turnIndex: 0,
			enemies: {},
			timerEnabled: true,
			timerMinutes: 3,
			maxMissedTurns: 5,
			isPrivate: false,
			passwordHash: null,
			passwordSalt: null,
			activeRestVote: null,
			currentMusic: null,
			narratorVoiceId: defaultNarratorVoiceId,
			narratorVoiceName: null,
			campaignTone: {
				id: "heroic",
				label: "Heroic",
				emoji: "⚔️",
				prompt: "The tone is heroic high fantasy. Stories should feel epic and triumphant. Heroes are courageous, villains are menacing, and acts of bravery are rewarded. Lean into dramatic moments, rousing speeches, and clear moral stakes.",
			},
			campaignTheme: {
				id: "ancient_evil",
				label: "Ancient Evil Returns",
				emoji: "🌑",
				prompt: "An ancient evil is awakening or has recently returned. Ruins, old texts, and elderly NPCs hold fragments of what came before. The party must piece together history to understand what they're truly facing.",
			},
			brutalityLevel: 5,
			difficulty: "standard",
			lootGenerosity: "fair",
			campaignSetting: "standard",
			startingLevel: 1,
			llmProvider: getDefaultLLMSettings().provider,
			llmModel:    getDefaultLLMSettings().model,
		};
		this.index[lobbyId] = state;
		this.codeMap[code] = lobbyId;
		this.socketsAdd(lobbyId, hostSid);
		this.persist(lobbyId);
		return { lobbyId, code };
	}

	setPassword(lobbyId, clientHash) {
		const l = this.index[lobbyId];
		if (!l) return;
		const salt = randomBytes(16).toString("hex");
		const hash = scryptSync(clientHash, salt, 64).toString("hex");
		l.isPrivate = true;
		l.passwordHash = hash;
		l.passwordSalt = salt;
		this.persist(lobbyId);
	}

	verifyPassword(lobbyId, clientHash) {
		const l = this.index[lobbyId];
		if (!l || !l.passwordHash) return true;
		try {
			const derived = scryptSync(clientHash, l.passwordSalt, 64);
			return timingSafeEqual(derived, Buffer.from(l.passwordHash, "hex"));
		} catch {
			return false;
		}
	}

	// ==== Rest Voting ====
	startRestVote(lobbyId, proposer, type) {
		const l = this.index[lobbyId];
		if (!l || l.activeRestVote) return false;
		const activePlayers = Object.keys(l.players).filter(n => !l.players[n]?.disconnected);
		l.activeRestVote = { type, proposer, votes: { [proposer]: "yes" }, total: activePlayers.length };
		this.persist(lobbyId);
		return true;
	}

	castVote(lobbyId, playerName, vote) {
		const l = this.index[lobbyId];
		if (!l?.activeRestVote || l.activeRestVote.votes[playerName]) return null;
		l.activeRestVote.votes[playerName] = vote;
		this.persist(lobbyId);
		return this.getVoteState(lobbyId);
	}

	getVoteState(lobbyId) {
		const l = this.index[lobbyId];
		if (!l?.activeRestVote) return null;
		const { type, proposer, votes, total } = l.activeRestVote;
		const yesVotes = Object.entries(votes).filter(([, v]) => v === "yes").map(([k]) => k);
		const noVotes  = Object.entries(votes).filter(([, v]) => v === "no").map(([k]) => k);
		const pending  = Object.keys(l.players).filter(n => !votes[n] && !l.players[n]?.disconnected);
		return { type, proposer, yesVotes, noVotes, pending, total };
	}

	checkVoteResolved(lobbyId) {
		const s = this.getVoteState(lobbyId);
		if (!s) return null;
		const { yesVotes, noVotes, total, pending } = s;
		if (pending.length === 0) return noVotes.length < yesVotes.length ? "passed" : "failed";
		if (yesVotes.length > total / 2) return "passed";
		if (noVotes.length >= Math.ceil(total / 2)) return "failed";
		return null;
	}

	clearRestVote(lobbyId) {
		const l = this.index[lobbyId];
		if (l) { l.activeRestVote = null; this.persist(lobbyId); }
	}

	applyRest(lobbyId, type) {
		const l = this.index[lobbyId];
		if (!l) return;
		for (const p of Object.values(l.players)) {
			if (!p.stats) continue;
			const max = p.stats.max_hp || p.stats.hp || 10;
			if (type === "long") {
				p.stats.hp = max;
				p.conditions = [];
				p.spellSlotsUsed = 0;
			} else {
				p.stats.hp = Math.min(max, p.stats.hp + Math.max(1, Math.floor(max / 3)));
			}
		}
		this.persist(lobbyId);
	}

	kickPlayer(lobbyId, playerName) {
		const l = this.index[lobbyId];
		if (!l) return null;
		const sid = Object.entries(l.sockets || {}).find(([, v]) => v.playerName === playerName)?.[0];
		delete l.players[playerName];
		if (sid) delete l.sockets[sid];
		this.persist(lobbyId);
		return sid;
	}

	findLobbyByCode(code) {
		return this.codeMap[code];
	}

	// ==== Connections ====
	addConnection(lobbyId, sid) {
		this.socketsAdd(lobbyId, sid);
		this.persist(lobbyId);
	}
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
	}
	socketsAdd(lobbyId, sid) {
		const s = this.index[lobbyId];
		s.sockets[sid] = s.sockets[sid] || { playerName: null, ready: false };
	}
	isHost(lobbyId, sid) {
		const s = this.index[lobbyId];
		return s && s.hostSid === sid;
	}
	hostPlayerName(lobbyId) {
		const s = this.index[lobbyId];
		if (!s || !s.hostCharacterId) return null;
		const entry = Object.entries(s.players || {}).find(([, p]) => p.characterId === s.hostCharacterId);
		return entry ? entry[0] : null;
	}
	belongs(lobbyId, sid) {
		const s = this.index[lobbyId];
		return !!(s && s.sockets[sid]);
	}

	// ==== Phase / Turn ====
	setPhase(lobbyId, phase) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.phase = phase;
		this.persist(lobbyId);
	}
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
	}
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
	}
	turnInfo(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return { current: null, order: [] };
		return { current: s.initiative[s.turnIndex] || null, order: s.initiative };
	}

	// ==== Player Management ====
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
	}
	setReady(lobbyId, sid, ready) {
		const s = this.index[lobbyId];
		if (!s || !s.sockets[sid]) return;
		s.sockets[sid].ready = !!ready;
		this.persist(lobbyId);
	}
	allReady(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const conns = Object.values(s.sockets);
		return conns.length > 0 && conns.every((c) => c.ready && c.playerName);
	}
	playerBySid(lobbyId, sid) {
		const s = this.index[lobbyId];
		const rec = s?.sockets[sid];
		if (!s || !rec || !rec.playerName) return null;
		return { name: rec.playerName, sheet: s.players[rec.playerName] };
	}
	sidByPlayerName(lobbyId, playerName) {
		const s = this.index[lobbyId];
		if (!s) return null;
		const entry = Object.entries(s.sockets).find(([sid, rec]) => rec.playerName === playerName);
		return entry ? entry[0] : null;
	}
	findPlayerKey(lobbyId, name) {
		const s = this.index[lobbyId];
		if (!s || !name) return null;
		const search = String(name).trim();
		if (s.players[search]) return search;
		const lower = search.toLowerCase();
		return Object.keys(s.players).find(k => k.toLowerCase() === lower) ?? null;
	}

	// ==== Actions / Dice ====
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
	}
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
	}

	// ==== History / Story ====
	tail(lobbyId, n) {
		const s = this.index[lobbyId];
		return s ? s.history.slice(-n) : [];
	}
	appendUser(lobbyId, name, content) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.history.push({ role: "user", name, content });
		s.lastActivity = now();
		this.persist(lobbyId);
	}
	appendDM(lobbyId, content) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.history.push({ role: "assistant", content });
		// Only set storyContext if no summary exists yet — once autoSummarize
		// has built a proper summary we must not overwrite it with a single response.
		if (!s._hasSummary) s.storyContext = content;
		this.persist(lobbyId);
	}
	summarize(lobbyId, content) {
		// Admin tooling: update the running summary without deleting history.
		const s = this.index[lobbyId];
		if (!s) return;
		s.storyContext = content;
		s._hasSummary = true;
		s.summarizedUpTo = s.history.length;
		this.persist(lobbyId);
	}

	/**
	 * Returns true when enough NEW (unsummarized) messages have accumulated.
	 * We never count already-summarized history — only messages after summarizedUpTo.
	 */
	needsSummarization(lobbyId, threshold) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const unsummarized = s.history.length - (s.summarizedUpTo || 0);
		return unsummarized >= threshold;
	}

	// ── Pinned Moments ──
	static MAX_PINS = 12;

	pinMoment(lobbyId, historyIndex, who) {
		const s = this.index[lobbyId];
		if (!s) return { ok: false, reason: "not_found" };
		if (historyIndex < 0 || historyIndex >= s.history.length) return { ok: false, reason: "invalid_index" };
		if (!s.pinnedMoments) s.pinnedMoments = [];
		if (s.pinnedMoments.some(p => p.index === historyIndex)) return { ok: false, reason: "already_pinned" };
		if (s.pinnedMoments.length >= LobbyStore.MAX_PINS) return { ok: false, reason: "limit_reached" };
		const entry = s.history[historyIndex];
		s.pinnedMoments.push({
			index: historyIndex,
			pinnedBy: who,
			pinnedAt: new Date().toISOString(),
			speaker: entry.role === "assistant" ? "DM" : (entry.name || "Player"),
			snippet: (entry.content || "").slice(0, 300),
		});
		this.persist(lobbyId);
		return { ok: true, remaining: LobbyStore.MAX_PINS - s.pinnedMoments.length };
	}
	unpinMoment(lobbyId, historyIndex) {
		const s = this.index[lobbyId];
		if (!s || !s.pinnedMoments) return false;
		const before = s.pinnedMoments.length;
		s.pinnedMoments = s.pinnedMoments.filter(p => p.index !== historyIndex);
		if (s.pinnedMoments.length < before) { this.persist(lobbyId); return true; }
		return false;
	}

	/**
	 * Build a running summary of unsummarized history and advance the bookmark.
	 * NEVER deletes history — the full log is always preserved for story reading.
	 *
	 * Uses a two-tier system:
	 *   - storyContext ("recent arc"): detailed summary of recent events (~800 words)
	 *   - ancientHistory: heavily compressed backstory of everything before the recent arc
	 *
	 * When storyContext exceeds maxSummaryLen, its content is compressed into
	 * ancientHistory and storyContext resets to just the new batch.
	 *
	 * @param {Function} getLLMResponse  - the LLM call function
	 * @param {object}   llmOpts        - { provider, model }
	 * @param {number}   keep           - recent messages to leave unsummarized (sent verbatim to LLM)
	 * @param {number}   maxSummaryLen  - when storyContext exceeds this, promote to ancientHistory
	 */
	async autoSummarize(lobbyId, getLLMResponse, llmOpts, keep = 6, maxSummaryLen = 60000) {
		const s = this.index[lobbyId];
		if (!s) return;

		// Prevent concurrent summarizations
		if (s._summarizing) {
			console.log(`⏭️ [summarize] Lobby ${lobbyId} — already in progress, skipping`);
			return;
		}
		s._summarizing = true;

		// Migration for existing lobbies
		if (s.summarizedUpTo == null) s.summarizedUpTo = 0;
		if (s.ancientHistory == null) s.ancientHistory = "";
		if (s.pinnedMoments == null) s.pinnedMoments = [];

		// Snapshot: summarize from summarizedUpTo to (current length - keep)
		const snapshotLen = s.history.length;
		const summarizeEnd = Math.max(snapshotLen - keep, s.summarizedUpTo);
		const toSummarize = s.history.slice(s.summarizedUpTo, summarizeEnd);

		if (toSummarize.length === 0) {
			s._summarizing = false;
			return;
		}

		// Build a condensed transcript from the new unsummarized messages
		const transcript = toSummarize.map((m, i) => {
			const speaker = m.role === "assistant" ? "DM" : (m.name || "Player");
			let text = m.content || "";
			if (text.length > 500) text = text.slice(0, 500) + "…";
			return `[${i + 1}] ${speaker}: ${text}`;
		}).join("\n");

		// Collect pinned moment text to protect from summarization loss
		const pinnedText = (s.pinnedMoments || []).map(p =>
			`[PINNED by ${p.pinnedBy}] ${p.speaker}: ${p.snippet}`
		).join("\n");

		const existingSummary = s.storyContext || "";
		const needsPromotion = existingSummary.length > maxSummaryLen;

		console.log(`📝 [summarize] Lobby ${lobbyId}: incorporating ${toSummarize.length} new messages (history: ${snapshotLen}, bookmark: ${s.summarizedUpTo})${needsPromotion ? " [PROMOTING storyContext → ancientHistory]" : ""}`);

		try {
			// ── STEP 1: If storyContext is too long, compress it into ancientHistory ──
			if (needsPromotion) {
				const archiveReply = await getLLMResponse([
					{
						role: "system",
						content: `You are a campaign chronicler. Compress the following detailed summary into a SHORT backstory overview (~300 words). Keep ONLY: major plot beats, key NPCs and their fates, important decisions, and unresolved mysteries. Drop all combat details, routine events, and atmospheric description.

CRITICAL: Any lines below marked [PINNED] were flagged by players as important. These MUST appear in your output as near-verbatim bullet points — do not paraphrase, merge, or omit them. They are the most important facts in the entire summary.

Return ONLY the compressed text — no JSON, no fences.`,
					},
					{
						role: "user",
						content: `${s.ancientHistory ? "Existing backstory:\n" + s.ancientHistory + "\n\n" : ""}Summary to compress:\n${existingSummary}${pinnedText ? "\n\nPINNED MOMENTS (must preserve):\n" + pinnedText : ""}`,
					},
				], llmOpts);

				const archived = typeof archiveReply === "string" ? archiveReply.trim() : "";
				if (archived && !archived.startsWith("[Error")) {
					s.ancientHistory = archived;
					s.storyContext = ""; // reset — will be rebuilt below
					console.log(`   📜 ancientHistory updated (${archived.length} chars)`);
				}
			}

			// ── STEP 2: Merge new events into storyContext (the "recent arc") ──
			const currentSummary = s.storyContext || "";
			const reply = await getLLMResponse([
				{
					role: "system",
					content: `You are a campaign chronicler for a D&D game. Your job is to maintain a structured, running summary of RECENT events that a DM can use to stay consistent. Merge the previous summary with the new events into the format below (max 800 words / ~1000 tokens). Return ONLY the summary — no JSON, no markdown fences.${pinnedText ? "\n\nIMPORTANT — these moments were flagged by players as significant. Ensure they appear in the summary:\n" + pinnedText : ""}

FORMAT:
CURRENT GOAL: [One or two sentences: what the party is currently trying to accomplish and why]

SETTING: [Current location, environment, time of day, and any notable atmospheric details]

KEY CHARACTERS:
- [Name] — [Role/relationship to party, disposition, last known status, notable traits or abilities]
(Include ALL named NPCs, allies, enemies, and creatures encountered. For each, note whether they are: allied, neutral, hostile, dead, or unknown. Remove only those confirmed dead AND no longer plot-relevant.)

PARTY STATUS:
- [Brief note per player character: current situation, any ongoing personal arcs or promises they've made]

STORY SO FAR:
- [Bullet point per major plot beat, decision, or revelation — chronological order]
- [Keep bullets concise but complete: who did what, where, why, and the consequence]
- [Preserve unresolved hooks, promises, threats, and mysteries]
- [Include important dialogue, bargains, alliances, and betrayals]
- [Drop routine combat rounds, dice results, and mechanical details]
- [Always include the most recent events — never truncate the end]
- [As the story grows, compress older events into fewer bullets but never delete them entirely]

OPEN THREADS:
- [Unresolved plot hooks, unanswered questions, pending threats]
- [Promises or deals the party has made]
- [Known enemies still at large]
- [Items, locations, or mysteries yet to be explored]`,
				},
				{
					role: "user",
					content: `Previous summary:\n${currentSummary || "(Starting fresh — older events are in the backstory.)"}\n\nNew events to incorporate:\n${transcript}`,
				},
			], llmOpts);

			const summary = typeof reply === "string" ? reply.trim() : "";
			if (!summary || summary.startsWith("[Error")) {
				console.warn(`⚠️ [summarize] LLM returned empty/error — history untouched`);
				return;
			}

			// Advance the bookmark — history is NEVER deleted
			s.summarizedUpTo = summarizeEnd;
			s.storyContext = summary;
			s._hasSummary = true;
			this.persist(lobbyId);

			console.log(`✅ [summarize] Lobby ${lobbyId} complete:`);
			console.log(`   - Summarized up to message ${summarizeEnd} of ${s.history.length}`);
			console.log(`   - storyContext: ${summary.length} chars | ancientHistory: ${(s.ancientHistory || "").length} chars`);
		} catch (err) {
			console.warn(`⚠️ [summarize] Failed for lobby ${lobbyId}: ${err.message} — history untouched`);
		} finally {
			s._summarizing = false;
		}
	}
	playersSummary(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return "";
		return Object.values(s.players)
			.map((p) => {
				const stats = Object.entries(p.stats || {})
					.map(([k, v]) => `${k}:${v}`)
					.join(", ");
				const inv = (p.inventory || []).map((i) => (typeof i === "string" ? i : `${i.name}×${i.count ?? 1}`)).join(", ") || "none";
				const abil = (p.abilities || []).join(", ") || "none";
				const xp = p.xp ?? 0;
				const wpn = p.weapon ? `${p.weapon.name} (${p.weapon.damage} ${p.weapon.damageType}, ${p.weapon.range || "melee"})` : "unarmed";
			const arm = p.armor  ? `${p.armor.name} (AC ${p.armor.ac}, ${p.armor.type})` : "unarmored (AC 10)";
			const trn = p.trinket ? `${p.trinket.name}` : "none";
			const tier = levelFlavorTag(Number(p.level) || 1);
			return `${p.name} [${p.class} L${p.level} (${tier}); XP ${xp}; weapon ${wpn}; armor ${arm}; trinket ${trn}; stats ${stats}; inv ${inv}; abilities ${abil}]`;
			})
			.join("\n");
	}

	// ==== LLM Prompts ====
	composeSetupPrompt(lobbyId) {
		// Updated: no legacy tag formats. Keep this simple for the opening scene.
		const players = this.playersSummary(lobbyId);
		const s = this.index[lobbyId];
		const flavorLines = [];
		if (s?.campaignTone?.prompt)  flavorLines.push(`Tone: ${s.campaignTone.prompt}`);
		if (s?.campaignTheme?.prompt) flavorLines.push(`Theme: ${s.campaignTheme.prompt}`);
		const flavorBlock = flavorLines.length ? `\n\t\t\tCampaign flavor:\n\t\t\t${flavorLines.join("\n\t\t\t")}\n` : "";
		const brutalityInstruction = this._brutalityInstruction(s?.brutalityLevel ?? 5);
		const difficultyInstruction = this._difficultyInstruction(s?.difficulty ?? "standard");
		const lootInstruction       = this._lootInstruction(s?.lootGenerosity ?? "fair");
		const settingInstruction    = this._settingInstruction(s?.campaignSetting ?? "standard");
		return `
			You are a creative, cinematic Dungeon Master introducing a new Dungeons & Dragons one-shot for beginners.
			Create a compelling opening that explains why the party is together, where they are, and the immediate situation.
			Use concise, vivid narration and end with a short prompt like: "What would you like to do?"
			Avoid heavy combat immediately; let the players orient first. Your narration text may include basic formatted HTML. Do not use markdown or code fences.
			World setting: ${settingInstruction}
			Content & tone: ${brutalityInstruction}
			Difficulty: ${difficultyInstruction}
			Loot: ${lootInstruction}
			${flavorBlock}
			Here are the players:
			${players}

			Reply ONLY with a SINGLE JSON object (no markdown, no code fences). The text property may only contain minimally formated HTML. Do not include any JSON or other content other than the text to be narrated in the 'text' property.
			{
			  "text": string,
			  "music": "lively_town" | "tense_battle" | "boss_fight" | "peaceful_nature" | "dungeon_ambient" | "tavern" | "mystery" | "exploration" | "sad_moment" | "victory" | "horror",
			  "sfx": string[],
			  "suggestions": string[]
			}
			Choose a music mood that fits the opening scene. Populate suggestions with 3-5 short action phrases (max 8 words each) the active player could plausibly do first. Suggestions should always be in the first person prose, always "I" not "you" or "your". Suggestioos should align with the characters alignment.
			For "sfx", include 0-3 short sound effect descriptions (2-4 words each) for dramatic moments in the scene, e.g. "sword clash", "door creak", "wolf howl", "thunder clap". Only include when something impactful or atmospheric happens. Set to an empty array if no sound effects fit.
			`.trim();
	}

	composeMessages(lobbyId, actorName, action, diceOutcome) {
		const safeName = sanitizeForLLMName(actorName);
		const s = this.index[lobbyId];
		if (!s) return [{ role: "system", content: "Error: Lobby not found." }];

		// If storyContext contains the setup prompt, treat as no prior context
		const storyContext = s.storyContext?.includes("You are a creative, cinematic Dungeon Master") ? "(The story has just begun. No prior context.)" : s.storyContext || "(No prior story yet.)";
		const ancientHistory = s.ancientHistory || "";

		// Collect pinned moments for the LLM
		const pinnedText = (s.pinnedMoments || []).filter(p => p.snippet).map(p =>
			`[PINNED by ${p.pinnedBy}] ${p.speaker}: ${p.snippet}`
		).join("\n");

		const players = Object.keys(s.players || {});

  // MAP DISABLED — characters and terrain fields commented out to save tokens
  // "characters": [
  //   {
  //     "name": string,
  //     "type": "player" | "npc" | "creature",
  //     "emoji": string | null,
  //     "x": number,
  //     "y": number,
  //     "facing": "north" | "south" | "east" | "west" | null,
  //     "status": string | null
  //   }
  // ],
  // "terrain": {
  //   "type": "forest" | "dungeon" | "plains" | "village" | "mountain" | "beach" | "cave" | "castle" | "road" | "unknown",
  //   "features": [string] // e.g. ["river","campfire","bridge"]
  // },
		const schema = `
Reply ONLY with a SINGLE JSON object (no markdown, no code fences). The text property may only contain minimally formated HTML. Do not include any JSON or other content other than the text to be narrated in the 'text' property.

Schema: {
  "text": string,
  "updates": {
    "xp": [{ "player": string, "amount": number, "reason": string }],
    "hp": [{ "player": string, "delta": number, "reason": string, "new_total": number }],
    "inventory": [{ "player": string, "item": string, "change": number, "description": string, "change_type": "add" | "remove", "attributes": { "item_type"?: "weapon" | "armor" | "trinket" | "consumable", "damage"?: string, "damage_type"?: string, "range"?: string, "ac"?: number, "armor_type"?: string, ...any } }],
    "gold": [{ "player": string, "delta": number }],
    "conditions": [{ "player": string, "add": string[], "remove": string[] }],
    "abilities": [{ "player": string, "change_type": "add" | "remove", "name": string, "description": string, "attributes": object }],
    "enemies": [{ "name": string, "hp": number, "max_hp": number, "ac": number, "str": number, "dex": number, "con": number, "int": number, "wis": number, "cha": number, "cr": string, "status": "active" | "dead" | "fled", "damage_taken": number | null, "reason": string | null }]
  },
  "prompt": string,
  "roll": { "sides": number, "stats": string[], "mods": number, "dc": number } | null,
  "suggestions": string[],
  "spellUsed": boolean,
  "music": "lively_town" | "tense_battle" | "boss_fight" | "peaceful_nature" | "dungeon_ambient" | "tavern" | "mystery" | "exploration" | "sad_moment" | "victory" | "horror" | null,
  "sfx": string[]
};
`;

		const flavorParts = [];
		if (s?.campaignTone?.prompt)  flavorParts.push(s.campaignTone.prompt);
		if (s?.campaignTheme?.prompt) flavorParts.push(s.campaignTheme.prompt);
		const flavorInstruction = flavorParts.length
			? `\nCampaign flavor (apply consistently throughout):\n${flavorParts.join("\n")}`
			: "";
		const brutalityInstruction = `\nContent & tone directive: ${this._brutalityInstruction(s?.brutalityLevel ?? 5)}`;
		const difficultyInstruction = `\nDifficulty: ${this._difficultyInstruction(s?.difficulty ?? "standard")}`;
		const lootInstruction = `\nLoot: ${this._lootInstruction(s?.lootGenerosity ?? "fair")}`;
		const settingInstruction = `\nWorld setting: ${this._settingInstruction(s?.campaignSetting ?? "standard")}`;

		// Compute party level range for encounter scaling
		const activePlayers = Object.values(s.players || {}).filter(p => !p.disconnected && !p.dead);
		const levels = activePlayers.map(p => Number(p.level) || 1);
		const partySize = levels.length || 1;
		const avgLevel = Math.round(levels.reduce((a, b) => a + b, 0) / partySize);
		const minLevel = Math.min(...(levels.length ? levels : [1]));
		const maxLevel = Math.max(...(levels.length ? levels : [1]));
		const levelRange = minLevel === maxLevel ? `${avgLevel}` : `${minLevel}–${maxLevel} (avg ${avgLevel})`;
		const encounterInstruction = `\nEncounter scaling: The party is ${partySize} player(s) at level ${levelRange}. ALL enemies, traps, hazards, and DCs MUST be appropriate for this level using D&D 5e CR guidelines. Level 1–2 parties should face CR 1/8–1 creatures (goblins, wolves, bandits, skeletons) — never dragons, liches, or high-CR threats. Level 3–5 parties can handle CR 1–5 creatures. Level 6–10 parties can face CR 3–8+ creatures. Scale enemy HP, damage output, AC, and spell levels to the party's capabilities. A single encounter should be winnable but challenging — not an instant TPK. Adjust the NUMBER of enemies rather than using single overpowered foes when possible.`;

		const base = [
			{
				role: "system",
				content: `You are the Dungeon Master (DM) for a Dungeons & Dragons 5e one-shot adventure.
Be cinematic, descriptive, and responsive to player actions. Maintain continuity with prior events. You should generally speaking be very allowing of stupid shit because that's what players want to do a lot of the time, so no moral policing. Be very "yes and" unless it simply doesn't work or breaks the game rules.
Respect dice outcomes given by the server. Always reply as the DM narrating events — never as a player. The adventuring party should consist of the actual active players at least at first. Don't make up companions from the start, they must be gained organically through the story.
Use the "music" field to set background music mood. Only change it when the scene shifts significantly — entering or leaving combat, arriving at a new location type, a death, a major revelation, a victory. Set to null when the current music still fits (which is most of the time). Available moods: lively_town, tense_battle, boss_fight, peaceful_nature, dungeon_ambient, tavern, mystery, exploration, sad_moment, victory, horror.
Use the "sfx" field to add 0-3 short sound effect descriptions (2-4 words each) for impactful moments — combat hits, spells cast, doors opening, creature sounds, explosions, etc. Examples: "sword clash", "fireball whoosh", "heavy door creak", "dragon roar", "thunder clap". Set to an empty array when nothing noteworthy happens sonically. Don't overdo it — only include SFX for moments that would genuinely benefit from audio punctuation.${settingInstruction}${brutalityInstruction}${difficultyInstruction}${encounterInstruction}${lootInstruction}${flavorInstruction}`,
			},
			...(ancientHistory ? [{ role: "system", content: `Campaign backstory (older events, for reference):\n${ancientHistory}` }] : []),
			{ role: "system", content: `Recent story arc:\n${storyContext}` },
			...(pinnedText ? [{ role: "system", content: `Player-pinned important moments (do NOT forget or contradict these):\n${pinnedText}` }] : []),
			{ role: "system", content: `Active players: ${players.map(name => {
				const p = s.players[name];
				if (p?.dead) return `${name} (☠️ DEAD)`;
				const hp = Number(p?.stats?.hp ?? 0);
				const maxHp = Number(p?.stats?.max_hp ?? p?.stats?.hp ?? 10);
				return `${name} (HP: ${hp}/${maxHp})`;
			}).join(", ")}` },
			...(s.currentMusic
				? [{ role: "system", content: `Currently playing music mood: "${s.currentMusic}". Only change this if the scene genuinely calls for a different mood — set "music" to null to keep the current music.` }]
				: [{ role: "system", content: `No music is playing yet. Set the "music" field to the mood that best fits the current scene.` }]),
			{ role: "system", content: schema },
			{
				role: "system",
				content: `When you narrate what happens, you must also include all mechanical results under the "updates" field.
If a player takes or avoids damage, consumes or gains an item, or uses a spell or ability, you must reflect it in "updates".
Examples:
- If a player burns their hand or steps into fire → add an "hp" update with a negative delta and reason.
- DEATH: If an hp update would reduce a player to 0 HP or below, set "new_total" to 0. This means the character DIES. You MUST narrate their death dramatically — describe how they fall, their final moments, and the impact on the party. From that point forward in this response and all future responses, that character is GONE. Do not give them actions, dialogue, or any narrative presence as a living character.
- If a player drinks or throws a potion → add an "inventory" update reducing that item count.
- If a player receives gold or treasure → add a "gold" update.
- If they get poisoned, stunned, or similar → add a "conditions" update. Use lowercase canonical condition names: blinded, burning, charmed, deafened, exhausted, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious. Always remove a condition when it logically ends (e.g. remove "burning" after it's extinguished).
- If the player says "I roll" anywhere in their dialog DO NOT immediatly resolve the action. Instead prompt them to roll an appropriate dice. Then when they do, judge the action accordingly. If the next player response is not a roll, the player immediatly fails whatever they were trying to do. Rolling is a crucial part of D&D and players want to roll for actions. Let them. You should prompt them what kind of dice to roll in this case.
- If requesting the player rolls a dice include a "roll" property in your JSON response. The value should be an object with four properties: "sides" (the number of sided die they should roll), "stats" (the stats to include in addition to the raw roll), "mods" (discretionary adjustments due to player conditions or other circumstances), and "dc" (the Difficulty Class — the minimum total the player must meet or exceed to succeed). Always set "dc" to an appropriate D&D 5e value (e.g. 10 for easy, 15 for medium, 20 for hard). The client will determine pass/fail and report it back to you so you can narrate the outcome.

A player may affected with any of the following conditions. Ensure to apply them appropriatly including rejecting actions that are impossible due to their condition such as taking an action while unconcious, or moving while restrained, hearing while deafened etc. In any of those types of cases the attempted action should immediatly fail unless you feel like providing a saving throw.

Condition	Effect
🙈	blinded	- Can't see. Auto-fails sight checks. Attack rolls against it have advantage; its attack rolls have disadvantage.
🔥	burning	- On fire. Takes fire damage at the start of each turn until extinguished (action to stop, drop, and roll).
💞	charmed	- Can't attack the charmer. The charmer has advantage on social checks against it.
🔇	deafened - Can't hear. Auto-fails hearing checks.
😩	exhausted - Suffers cumulative penalties at each level: disadvantage on checks, speed halved, attack/save disadvantage, speed 0, death.
😱	frightened - Disadvantage on ability checks and attack rolls while source of fear is in sight. Can't willingly move closer to the source.
🤼	grappled - Speed becomes 0. Ends if the grappler is incapacitated or moved out of range.
💫	incapacitated - Can't take actions or reactions.
👻	invisible - Impossible to see without magic. Attacks against it have disadvantage; its attacks have advantage.
⚡  paralyzed - Incapacitated and can't move or speak. Auto-fails Str/Dex saves. Attacks have advantage; hits within 5 ft. are critical hits.
🗿	petrified -	Transformed to stone. Incapacitated, weight ×10, resistant to all damage, immune to poison/disease.
🤢	poisoned -	Disadvantage on attack rolls and ability checks.
🛌	prone - Melee attacks against it have advantage. Ranged attacks have disadvantage. Must use half movement to stand up.
🕸️	 restrained - Speed 0. Attack rolls against it have advantage; its attacks have disadvantage. Disadvantage on Dex saves.
💥	stunned - Incapacitated, can't move, barely speaks. Auto-fails Str/Dex saves. Attack rolls against it have advantage.
💤	unconscious - Incapacitated, can't move or speak, unaware. Drops held items. Attacks have advantage; hits within 5 ft. are critical hits.

Do not skip updates just because the action fails — always include the logical consequence.
Always populate the "suggestions" array with 3–5 short action phrases (max 8 words each) that the active player could plausibly do next given the current scene. These are shown as quick-action hints in the UI. Make them specific to what is happening, not generic. Suggestions should always be in the first person prose, always "I" not "you" or "your". Suggestioos should align with the characters alignment and mixed with the players previous actions.

ENEMY TRACKING: When you introduce ANY hostile creature, NPC combatant, or monster, you MUST include an "enemies" array entry in "updates" with their full stat block. Use D&D 5e-appropriate stats for the creature's CR. Required fields:
- "name": unique identifier (e.g. "Goblin 1", "Dire Wolf", "Bandit Captain")
- "hp" and "max_hp": current and maximum hit points
- "ac": armor class
- "str", "dex", "con", "int", "wis", "cha": ability scores
- "cr": challenge rating as a string (e.g. "1/4", "1", "5")
- "status": "active" (alive and fighting), "dead" (killed), or "fled" (escaped)
- "damage_taken": amount of damage dealt THIS turn (null if none)
- "reason": brief description of what happened to them this turn (null if nothing)
Every turn that involves combat, include ALL currently active enemies in the "enemies" array — even those not affected this turn — so the server can maintain an accurate roster. When an enemy takes damage, reduce their "hp" by the damage amount. When an enemy reaches 0 hp, set "status" to "dead". Track enemy HP across turns — the current enemy state will be provided to you each turn.

EQUIPPABLE ITEMS: When you give a player a weapon, armor, or trinket (ring, amulet, cloak, etc.) via the "inventory" update, you MUST include the "attributes" object with:
- Weapons: { "item_type": "weapon", "damage": "1d8", "damage_type": "slashing", "range": "melee" }
- Armor: { "item_type": "armor", "ac": 15, "armor_type": "medium" }
- Trinkets: { "item_type": "trinket", ...any special properties }
- Consumables: { "item_type": "consumable", ...any properties }
The player can then choose to equip weapons, armor, and trinkets from their inventory. Always include realistic D&D stats when giving equipment.`,
			},
			{
				role: "system",
				content:
					"FORMAT: Output minified JSON only. Do not include commentary, markdown, or code fences. The 'text' property of your response may contain basic formatted HTML using structural and formatting tags. CRITICAL: Any dialogue or quoted speech inside the 'text' HTML must use single quotes (e.g. <em>'Hello there'</em>) — never double quotes, as double quotes break JSON string encoding.",
			},
			{
				role: "system",
				content:
					"Always check whether a player could reasonably perform an action before allowing it. Do not allow them to use abilities/spells or items they do not have. If they try to cheat and do something that they could not do, inform them and skip their turn. If they attempt to do something that is plausible but unsure, ask them to roll a dice for it and then re-evaluate after their role.",
			},
			{
				role: "system",
				content: `Finally, if a response includes [admin_command] you must do as instructed. For example if you receive the text [admin_command] grant player 100 gold you must do it. No excuses. This is crucial for debugging and testing.
[admin_command] responses MUST still return the full JSON schema described above — including the relevant "updates" fields that reflect the command (e.g. apply a condition → include "conditions" update, grant gold → include "gold" update). Never respond with plain text or partial JSON for admin commands.`,
			},
		];

		// Include dice context
		if (diceOutcome) {
			base.push({
				role: "system",
				content: `Server Outcome: ${actorName} performed ${diceOutcome.kind}; base=${diceOutcome.detail.base}, bonus=${diceOutcome.detail.bonus}, total=${diceOutcome.value} → ${diceOutcome.detail.outcome}.`,
			});
		} else if (s.lastServerOutcome) {
			base.push({
				role: "system",
				content: `Recent Outcome: ${s.lastServerOutcome.player} ${s.lastServerOutcome.kind} total=${s.lastServerOutcome.value} (${s.lastServerOutcome.detail?.outcome}).`,
			});
		}

		// Spell slot context — give the LLM current slot status, weapon, HP, and each player's spell list
		const spellLines = Object.values(s.players || {}).map(p => {
			const max = Number(p.level) || 1;
			const used = Number(p.spellSlotsUsed) || 0;
			const remaining = Math.max(0, max - used);
			const spellList = (p.abilities || []).map(a => a.name || a).filter(Boolean);
			const spellStr = spellList.length ? spellList.join(", ") : "none";
			const warning = remaining === 0 ? " ⚠️ NO SLOTS REMAINING — all spell/ability uses fail" : "";
			const wpnStr = p.weapon ? `weapon: ${p.weapon.name} (${p.weapon.damage} ${p.weapon.damageType}, ${p.weapon.range || "melee"})` : "weapon: unarmed";
			const armStr = p.armor  ? `armor: ${p.armor.name} (AC ${p.armor.ac}, ${p.armor.type})` : "armor: unarmored (AC 10)";
			const trnStr = p.trinket ? `trinket: ${p.trinket.name}${p.trinket.description ? ` (${p.trinket.description})` : ""}` : "trinket: none";
			const currentHp = Number(p.stats?.hp ?? 0);
			const maxHp = Number(p.stats?.max_hp ?? p.stats?.hp ?? 10);
			const hpStr = p.dead ? "HP: 0 — ☠️ DEAD" : `HP: ${currentHp}/${maxHp}`;
			const hpWarning = !p.dead && currentHp > 0 && currentHp <= Math.floor(maxHp * 0.25) ? " ⚠️ CRITICALLY LOW HP" : "";
			const tier = levelFlavorTag(max);
			return `  - ${p.name} (${p.class || "?"} Lv ${max}, ${tier}): ${hpStr}${hpWarning} | ${wpnStr} | ${armStr} | ${trnStr} | abilities/spells known: [${spellStr}] | slots: ${remaining}/${max}${warning}`;
		}).join("\n");

		// Collect dead player names for explicit death instructions
		const deadPlayers = Object.values(s.players || {}).filter(p => p.dead).map(p => p.name);

		base.push({
			role: "system",
			content: `PLAYER STATUS & SPELL SLOTS (authoritative — do not guess or override):\n${spellLines}\n\nRules:\n- A player can only cast a spell or activate an ability if it is in their known list AND they have slots remaining.\n- Slots are shared between spells and abilities. Each use costs one slot.\n- If the ability/spell is not in their list, or remaining slots = 0, the action FAILS. You MUST reject it — narrate the consequence (embarrassing misfire, wild surge, nothing happens, ability fizzles, etc.) and set "spellUsed": false.\n- If a spell or ability is successfully used, set "spellUsed": true. The server will deduct the slot.\n- Always set "spellUsed": false when no spell or ability was used this turn.\n- IMPORTANT: You must NEVER allow a player to use a spell or ability when remaining slots = 0. This is a hard rule.\n- HP values shown above are AUTHORITATIVE. When you deal damage via an "hp" update, calculate the new_total based on these values. If an hp update would bring a player to 0 or below, their HP becomes 0 and they DIE.${deadPlayers.length ? `\n\n☠️ DEAD PLAYERS: ${deadPlayers.join(", ")}\nThese players are DEAD. Do NOT include them in narration as active participants. Do not give them dialogue, actions, or agency. They are gone. Other players may reference or mourn them, but the dead characters do not act, speak, or respond. Do not generate any updates (hp, inventory, conditions, etc.) for dead players.` : ""}`,
		});

		// Enemy roster — feed current enemy state so the LLM can track HP across turns
		const enemyRoster = this.enemyRoster(lobbyId);
		if (enemyRoster) {
			base.push({
				role: "system",
				content: `ACTIVE ENEMIES (authoritative — track HP across turns):\n${enemyRoster}\n\nRules:\n- These are the enemies currently in play. Their HP values are AUTHORITATIVE.\n- When an enemy takes damage, reduce their HP accordingly in the "enemies" update. When HP reaches 0, set "status" to "dead".\n- When introducing NEW enemies, include full stat blocks in the "enemies" update.\n- Every combat turn, include ALL active enemies in the "enemies" array — even those unaffected this turn — so the server keeps an accurate roster.\n- Dead enemies should still be listed with "status": "dead" until combat ends.\n- Do not resurrect dead enemies unless the narrative explicitly calls for it (e.g. necromancy).`,
			});
		}

		// Recent unsummarized history for continuity — everything after summarizedUpTo
		// (older events are captured in storyContext via auto-summarization)
		const fromIdx = s.summarizedUpTo || 0;
		base.push(...(s.history || []).slice(fromIdx));

		// Player action (use sanitized name)
		base.push({ role: "user", name: safeName, content: String(action) });

		return base;
	}

	// ==== TPK (Total Party Kill) Epilogue Prompt ====
	composeWipeEpilogue(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return [{ role: "system", content: "Error: Lobby not found." }];

		const ancientHistory = s.ancientHistory || "";

		// Build a summary of each fallen character with class/race/level
		const fallenSummary = Object.values(s.players || {}).map(p => {
			const cls = p.class || "Adventurer";
			const lvl = Number(p.level) || 1;
			const race = p.race || "Unknown";
			const tier = levelFlavorTag(lvl);
			return `  - ${p.name} (${race} ${cls}, Level ${lvl} — ${tier})`;
		}).join("\n");

		// Compile recent history as a readable narrative recap (NOT raw chat messages).
		// Raw role:"assistant"/role:"user" messages confuse the LLM into continuing
		// the game conversation instead of writing an epilogue.
		const fromIdx = s.summarizedUpTo || 0;
		const rawHistory = (s.history || []).slice(fromIdx);
		const recapLines = rawHistory.map(msg => {
			if (msg.role === "user") {
				const who = msg.name || "A player";
				return `${who}: "${msg.content}"`;
			}
			// Strip HTML tags for the recap — just keep the text
			const plain = (msg.content || "").replace(/<[^>]+>/g, "").trim();
			return plain ? `DM: ${plain}` : null;
		}).filter(Boolean);

		// Use the summarized story context as the primary narrative, falling back
		// to the first DM message (the opening scene) if no summary exists yet.
		const storySummary = s._hasSummary && s.storyContext
			? s.storyContext
			: (rawHistory.find(m => m.role === "assistant")?.content || "").replace(/<[^>]+>/g, "").trim();

		return [
			{
				role: "system",
				content: `You are the Dungeon Master. The entire adventuring party has just been killed — a Total Party Kill. You must now narrate the EPILOGUE. This is NOT a continuation of the adventure. Do NOT narrate new combat, new actions, new spells, or new events. The story is OVER.

Your task is to deliver a dramatic, bittersweet epilogue that:
1. Describes the immediate aftermath of the final death — the silence that follows, the scene around the fallen.
2. Reflects on each fallen hero individually: who they were, what they were trying to accomplish, and how they met their end. Base this ONLY on the history provided below — do not invent events that did not happen.
3. Describes what happens to the world now that the party has failed. What darkness spreads? What evil goes unchecked? What people suffer because these heroes fell?
4. Ends with a final, evocative closing line — something that would feel at home as the last line of a dark fantasy novel.

Be cinematic, melancholic, and respectful of each character's journey. This is the final narration the players will ever hear — make it memorable.

CRITICAL: Do NOT continue the game. Do NOT narrate new combat or actions. Only reflect on what has already happened and describe the world's fate.`,
			},
			...(ancientHistory ? [{ role: "system", content: `Campaign backstory:\n${ancientHistory}` }] : []),
			...(storySummary ? [{ role: "system", content: `The story so far:\n${storySummary}` }] : []),
			...(recapLines.length ? [{ role: "system", content: `Recent events (what just happened):\n${recapLines.join("\n")}` }] : []),
			{ role: "system", content: `The fallen party:\n${fallenSummary}` },
			{
				role: "system",
				content: `FORMAT: Output minified JSON only with this schema: { "text": string, "music": string | null, "sfx": string[] }
The "text" field may contain basic HTML formatting. Set "music" to "sad_moment". Include 1-2 atmospheric SFX like "wind howling", "distant thunder", etc.`,
			},
			{ role: "user", content: "The last hero has fallen. The adventure is over. Narrate the epilogue — do not continue the game." },
		];
	}

	// ==== Public state for clients ====
	publicState(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return null;
		const connected = Object.entries(s.sockets).map(([, rec]) => ({ name: rec.playerName, ready: rec.ready }));

		const party = Object.entries(s.players)
			.filter(([, p]) => !p.disconnected)
			.map(([name, p]) => ({
				name,
				hp: p.stats?.hp ?? 0,
				max_hp: p.stats?.max_hp ?? p.stats?.hp ?? 1,
				status: p.status || ((p.stats?.hp ?? 1) <= 0 ? "💀 Downed" : "Healthy"),
				conditions: Array.isArray(p.conditions) && p.conditions.length ? p.conditions.join(", ") : "None",
				level: Number(p.level) || 1,
				spellSlotsUsed: Number(p.spellSlotsUsed) || 0,
			}));

		return {
			lobbyId: s.lobbyId,
			code: s.code,
			adventureName: s.adventureName || null,
			phase: s.phase,
			players: s.players,
			connected,
			hostPlayer: this.hostPlayerName(lobbyId) || null,
			storyContext: s.storyContext,
			ancientHistory: s.ancientHistory || "",
			pinnedMoments: s.pinnedMoments || [],
			history: s.history,
			initiative: s.initiative,
			turnIndex: s.turnIndex,
			timerEnabled: s.timerEnabled || false,
			timerMinutes: s.timerMinutes || 5,
			maxMissedTurns: s.maxMissedTurns || 3,
			narratorVoiceId:   s.narratorVoiceId   || null,
			narratorVoiceName: s.narratorVoiceName || null,
			campaignTone: s.campaignTone || null,
			campaignTheme: s.campaignTheme || null,
			brutalityLevel:  s.brutalityLevel  ?? 5,
			difficulty:      s.difficulty      || "standard",
			lootGenerosity:  s.lootGenerosity  || "fair",
			campaignSetting: s.campaignSetting || "standard",
			startingLevel:   s.startingLevel   ?? 1,
			llmProvider: s.llmProvider || null,
			llmModel:    s.llmModel    || null,
			chat: s.chat?.slice(-50) || [],
			party,
			currentMusic: s.currentMusic || null,
			enemies: Object.values(s.enemies || {}).map(e => {
				const pct = e.max_hp > 0 ? e.hp / e.max_hp : 0;
				let condition;
				if (e.status === "dead") condition = "Dead";
				else if (e.status === "fled") condition = "Fled";
				else if (pct > 0.75) condition = "Healthy";
				else if (pct > 0.40) condition = "Injured";
				else if (pct > 0.15) condition = "Wounded";
				else condition = "Near Death";
				return { name: e.name, cr: e.cr, status: e.status, condition };
			}),
		};
	}

	setTimerSettings(lobbyId, enabled, minutes, maxMissed) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.timerEnabled = !!enabled;
		s.timerMinutes = Math.min(20, Math.max(1, Number(minutes) || 5));
		s.maxMissedTurns = Math.min(10, Math.max(1, Number(maxMissed) || 3));
		this.persist(lobbyId);
	}

	setNarratorVoice(lobbyId, voiceId, voiceName = null) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.narratorVoiceId   = voiceId   || null;
		s.narratorVoiceName = voiceName || null;
		this.persist(lobbyId);
	}

	getNarratorVoice(lobbyId) {
		return this.index[lobbyId]?.narratorVoiceId || null;
	}

	setCurrentMusic(lobbyId, mood) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.currentMusic = mood || null;
		this.persist(lobbyId);
	}

	getCurrentMusic(lobbyId) {
		return this.index[lobbyId]?.currentMusic || null;
	}

	setBrutalityLevel(lobbyId, level) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.brutalityLevel = Math.min(10, Math.max(0, Number(level) ?? 5));
		this.persist(lobbyId);
	}

	_brutalityInstruction(level) {
		const n = Number(level) ?? 5;
		if (n <= 1) return "This is a family-friendly adventure. Keep all descriptions completely clean and appropriate for young children. No violence, blood, death, or frightening content — enemies are defeated comically or run away. Narrate with whimsy and warmth.";
		if (n <= 3) return "Keep the tone light and heroic. Battles are dramatic but not graphic — injuries are glancing blows, enemies are subdued or flee. Avoid gore, disturbing imagery, or dark themes.";
		if (n <= 6) return "Use a standard fantasy adventure tone. Combat and danger feel real and consequential, with vivid but non-gratuitous descriptions. Injuries, death, and moral complexity are handled matter-of-factly.";
		if (n <= 8) return "Lean into gritty, visceral storytelling. Wounds bleed, deaths are described in detail, enemies may be cruel, and the world has a harsh edge. Dark themes are fair game.";
		return "Absolute brutality mode. Hold nothing back — violence is graphic and visceral, consequences are severe and unforgiving, the world is merciless. Intense horror, gruesome deaths, and moral depravity are on the table.";
	}

	setDifficulty(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		const valid = ["casual", "standard", "hardcore", "merciless"];
		s.difficulty = valid.includes(value) ? value : "standard";
		this.persist(lobbyId);
	}

	setLootGenerosity(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		const valid = ["sparse", "fair", "generous"];
		s.lootGenerosity = valid.includes(value) ? value : "fair";
		this.persist(lobbyId);
	}

	setCampaignSetting(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		const valid = ["standard", "dark_ages", "steampunk", "pirate", "scifi", "ancient_egypt", "ancient_rome", "warring_states_japan", "prehistory", "renaissance"];
		s.campaignSetting = valid.includes(value) ? value : "standard";
		this.persist(lobbyId);
	}

	setStartingLevel(lobbyId, level) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.startingLevel = Math.min(25, Math.max(1, Number(level) || 1));
		this.persist(lobbyId);
	}

	/**
	 * Initialize a player to the lobby's starting level.
	 * Grants HP, attribute points, abilities, spell slots, and XP for all
	 * levels above 1. Uses a `_startLevelInit` flag for idempotency so it
	 * works regardless of what level the client sends in the sheet.
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
	}

	_difficultyInstruction(d) {
		switch (d) {
			case "casual":    return "Difficulty is Casual. Enemies are weak and untactical. Most DCs are low (8–12). Players should rarely face real danger — keep deaths and devastating failures scarce. Prioritise fun and experimentation over challenge.";
			case "hardcore":  return "Difficulty is Hardcore. Enemies are smart, hit hard, and exploit weaknesses. DCs skew high (14–18 for moderate tasks). Mistakes carry real consequences. Players should feel genuine danger throughout.";
			case "merciless": return "Difficulty is Merciless. Enemies are relentless and unforgiving. DCs are punishing. Every blunder may be lethal. Show absolutely no mercy — the world does not care whether the players survive.";
			default:          return "Difficulty is Standard. Follow normal D&D 5e encounter balance. DCs are fair (10–15 for moderate tasks). Combat is challenging but winnable with smart play.";
		}
	}

	_lootInstruction(g) {
		switch (g) {
			case "sparse":   return "Loot is sparse. Treasure is rare and meaningful; finding anything magical is a genuine event. Gold drops are small. Players must make the most of limited resources.";
			case "generous": return "Loot is generous. Players should find interesting items and decent gold frequently. Magic items can appear after boss fights and in hidden caches. Reward exploration and clever play with tangible loot.";
			default:         return "Loot follows standard D&D 5e rates. Award treasure at reasonable intervals — after significant fights, in hidden caches, and as quest rewards.";
		}
	}

	_settingInstruction(setting) {
		switch (setting) {
			case "dark_ages":  return "Setting: Dark Ages / Low Fantasy. A harsh, historical-feeling world where magic is scarce and feared. Technology is primitive, superstition runs rampant, and the land is brutal. Avoid high-fantasy tropes like gleaming cities or benevolent kings.";
			case "steampunk":  return "Setting: Steampunk / Magitech. Clockwork machinery and arcane technology coexist. Cities hum with steam-powered devices and arcane factories. Magic is partly industrialised; gadgets and constructs are common.";
			case "pirate":     return "Setting: Pirate Age. Ocean voyages, island ports, and naval battles dominate. Treasure maps, privateers, sea monsters, and rival factions abound. Flavour locations and NPCs with nautical and colonial themes.";
			case "scifi":                return "Setting: Sci-fi Fantasy. Ancient technology left by a vanished civilisation blurs magic and science. Ruins hold laser-edged traps and arcane computers. Spaceships and swords coexist in a world that defies simple categorisation.";
			case "ancient_egypt":        return "Setting: Ancient Egypt. A mythic Nile-valley civilisation ruled by pharaoh-sorcerers and jealous animal-headed gods. Adventures centre on sand-buried tomb complexes, cursed relics, temple politics, and divine rivalries. Use Egyptian names, titles (vizier, high priestess, nomarch), and flavour (papyrus scrolls, canopic jars, scarab wards). Magic draws on hieroglyphic runes and divine patronage rather than arcane study.";
			case "ancient_rome":         return "Setting: Ancient Rome. A vast militaristic empire of legions, senators, and living gods. Adventures feature gladiatorial arenas, political conspiracy, frontier campaigns against barbarian hordes, and the meddling of Olympian deities. Use Latin-flavoured names and titles (centurion, tribune, consul). Infrastructure like roads, aqueducts, and colosseums should feature prominently. Magic manifests as augury, divine favour, and forbidden mystery cults.";
			case "warring_states_japan":  return "Setting: Sengoku-era Japan. Feudal provinces torn apart by rival daimyo clans. Samurai live and die by bushido, shinobi operate in shadow, wandering ronin sell their blades, and yokai haunt the wild places between castles. Use Japanese names, titles (shogun, daimyo, ashigaru), and cultural elements (tea ceremony, shrine offerings, honour duels). Magic is rooted in onmyodo spirit arts, kami blessings, and cursed blades.";
			case "prehistory":           return "Setting: Prehistory. A primeval world before metal, writing, or cities. Small tribal bands navigate vast wilderness filled with megafauna, rival clans, and primal spirits. Technology is limited to stone, bone, and hide. Magic is shamanic — spirit journeys, cave paintings that come alive, totemic bonds with great beasts. There are no kingdoms, shops, or coins; survival, territory, and oral tradition drive every conflict.";
			case "renaissance":          return "Setting: Renaissance Europe. Flourishing city-states ruled by ambitious merchant princes and the church. Art, science, and intrigue intertwine — Leonardo-style inventor-mages, Medici-style patron families, duelling academies, secret alchemical societies, and an ever-watchful Inquisition. Use Italian-flavoured names and titles (doge, condottiero, cardinal). Magic is practised as heretical natural philosophy, hidden behind artistic or scientific fronts to avoid persecution.";
			default:                     return "Setting: Standard high fantasy. A world of kingdoms, dungeons, ancient magic, and classic races. Elves, dwarves, and humans coexist. Classic fantasy tropes and locations are fair game.";
		}
	}

	setCampaignFlavor(lobbyId, tone, theme) {
		const s = this.index[lobbyId];
		if (!s) return;
		if (tone  !== undefined) s.campaignTone  = tone  || null;
		if (theme !== undefined) s.campaignTheme = theme || null;
		this.persist(lobbyId);
	}

	setLLMSettings(lobbyId, provider, model) {
		const s = this.index[lobbyId];
		if (!s) return;
		if (provider) s.llmProvider = provider;
		if (model)    s.llmModel    = model;
		this.persist(lobbyId);
	}

	getLLMSettings(lobbyId) {
		const s = this.index[lobbyId];
		return {
			provider: s?.llmProvider || getDefaultLLMSettings().provider,
			model:    s?.llmModel    || getDefaultLLMSettings().model,
		};
	}

	incrementMissedTurns(lobbyId, playerName) {
		const s = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName) || playerName;
		if (!s?.players[key]) return 0;
		s.players[key].missedTurns = (s.players[key].missedTurns || 0) + 1;
		this.persist(lobbyId);
		return s.players[key].missedTurns;
	}

	resetMissedTurns(lobbyId, playerName) {
		const s = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName) || playerName;
		if (!s?.players[key]) return;
		s.players[key].missedTurns = 0;
		this.persist(lobbyId);
	}

	setAdventureName(lobbyId, name) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.adventureName = name;
		this.persist(lobbyId);
	}

	checkAllDead(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const active = Object.values(s.players).filter(p => !p.disconnected);
		if (!active.length) return false;
		return active.every(p => p.dead);
	}

	markPlayerDead(lobbyId, playerName) {
		const s = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!s || !key) return;
		s.players[key].dead = true;
		s.players[key].stats = s.players[key].stats || {};
		s.players[key].stats.hp = 0;
		this.persist(lobbyId);
	}

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
	}
	// Insert a new player into the initiative order based on their DEX score.
	// Higher DEX = earlier position. Adjusts turnIndex so the current turn is unaffected.
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
	}

	// ==== XP / Leveling / Stats / Inventory ====
	increaseLevel(lobbyId, playerName) {
		const l = this.index[lobbyId];
		if (!l || !l.players[playerName]) return { level: 1, hpGained: 0 };
		const p = l.players[playerName];
		p.level = (Number(p.level) || 1) + 1;

		// Roll HP: 1d6 + CON modifier (minimum 1)
		const con = Number(p.stats?.con) || 10;
		const conMod = Math.floor((con - 10) / 2);
		const hpRoll = Math.floor(Math.random() * 6) + 1;
		const hpGained = Math.max(1, hpRoll + conMod);
		p.stats = p.stats || {};
		p.stats.hp = (Number(p.stats.hp) || 0) + hpGained;
		p.stats.max_hp = (Number(p.stats.max_hp) || 0) + hpGained;

		this.persist(lobbyId);
		return { level: p.level, hpGained };
	}
	applyLevelGains(lobbyId, sid, gains) {
		const l = this.index[lobbyId];
		if (!l) return null;

		const socketRec = l.sockets[sid];
		if (!socketRec || !socketRec.playerName) return null;

		const player = l.players[socketRec.playerName];
		if (!player) return null;

		// Apply gains (client controls distribution)
		for (const [attr, val] of Object.entries(gains)) {
			if (!player.stats[attr]) continue;
			player.stats[attr] += val;
		}

		this.persist(lobbyId);
		return player.stats;
	}
	addXP(lobbyId, playerName, amount) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		p.xp = (p.xp || 0) + Number(amount || 0);
		this.persist(lobbyId);
		return p.xp;
	}

	checkLevelUp(lobbyId, playerName) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return false;
		const p = l.players[key];
		const nextLevel = (Number(p.level) || 1) + 1;
		const nextXP = XP_THRESHOLDS[nextLevel - 1];
		if (nextXP && p.xp >= nextXP) return true;
		return false;
	}
	applyHPChange(lobbyId, playerName, delta) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		p.stats = p.stats || { hp: 10 };
		const before = Number(p.stats.hp || 0);
		const after = Math.max(0, before + Number(delta || 0));
		p.stats.hp = after;
		this.persist(lobbyId);
		return after;
	}
	applyGoldChange(lobbyId, playerName, delta) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		p.gold = Number(p.gold || 0) + Number(delta || 0);
		if (p.gold < 0) p.gold = 0;
		this.persist(lobbyId);
		return p.gold;
	}
	addAbility(lobbyId, playerName, ability) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key || !ability) return;
		const p = l.players[key];
		p.abilities = Array.isArray(p.abilities) ? p.abilities : [];
		// Avoid granting the same ability twice (reconnects, double-fires, etc.)
		if (!p.abilities.some(a => a.name === ability.name)) {
			p.abilities.push(ability);
		}
		this.persist(lobbyId);
	}
	// ==== Enemy Tracking ====
	/**
	 * Update the enemy roster from LLM response data.
	 * Each entry can introduce a new enemy, update HP/status, or mark one dead/fled.
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
	}

	/** Get formatted enemy roster for the LLM prompt. */
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
	}

	applySpellSlotChange(lobbyId, playerName, delta) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		const maxSlots = Number(p.level) || 1;
		const current = Number(p.spellSlotsUsed) || 0;
		p.spellSlotsUsed = Math.max(0, Math.min(maxSlots, current + Number(delta || 0)));
		this.persist(lobbyId);
		return p.spellSlotsUsed;
	}
	applyConditions(lobbyId, playerName, add = [], remove = []) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return [];
		const p = l.players[key];
		p.conditions = Array.isArray(p.conditions) ? p.conditions : [];
		for (const c of add || []) {
			if (c && !p.conditions.includes(c)) p.conditions.push(c);
		}
		for (const c of remove || []) {
			const idx = p.conditions.indexOf(c);
			if (idx !== -1) p.conditions.splice(idx, 1);
		}
		this.persist(lobbyId);
		return p.conditions;
	}

	applyInventoryChange(lobbyId, playerName, item, change, description, attributes) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];

		// Ensure inventory is an array
		if (!Array.isArray(p.inventory)) p.inventory = [];

		// Normalize strings into objects (but don't overwrite the array)
		for (let i = 0; i < p.inventory.length; i++) {
			const entry = p.inventory[i];
			if (typeof entry === "string") {
				p.inventory[i] = { name: entry, count: 1, description: "", attributes: {} };
			} else {
				p.inventory[i] = {
					name: entry.name || "Unknown",
					count: entry.count ?? 1,
					description: entry.description || "",
					attributes: entry.attributes || {},
				};
			}
		}

		// Find existing item
		let existing = p.inventory.find((i) => i.name.toLowerCase() === item.toLowerCase());

		// Add new item if not found and we're increasing
		if (!existing && change > 0) {
			existing = {
				name: item,
				count: 0,
				description: description || "",
				attributes: attributes || {},
			};
			p.inventory.push(existing);
		}

		// Apply changes if we found or created one
		if (existing) {
			existing.count = (existing.count || 0) + change;

			if (existing.count <= 0) {
				// Remove from array safely
				p.inventory = p.inventory.filter((i) => i.name.toLowerCase() !== item.toLowerCase());
			} else {
				// Update metadata only if given
				if (description) existing.description = description;
				if (attributes && Object.keys(attributes).length > 0) {
					existing.attributes = { ...existing.attributes, ...attributes };
				}
			}
		}

		this.persist(lobbyId);
		return existing?.count || 0;
	}

	/**
	 * Equip an item from the player's inventory as weapon, armor, or trinket.
	 * The previously equipped item (if any) goes back into inventory.
	 * Returns { equipped, unequipped } with the item objects, or null on failure.
	 */
	equipItem(lobbyId, playerName, itemName, slot) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return null;
		const p = l.players[key];
		if (!p) return null;

		if (!Array.isArray(p.inventory)) p.inventory = [];

		// Find the item in inventory (case-insensitive)
		const idx = p.inventory.findIndex(i =>
			(typeof i === "string" ? i : i.name || "").toLowerCase() === itemName.toLowerCase()
		);
		if (idx === -1) return null;

		const invItem = typeof p.inventory[idx] === "string"
			? { name: p.inventory[idx], count: 1, description: "", attributes: {} }
			: p.inventory[idx];

		// Build the new equipped object based on slot
		let newEquip = null;
		let oldEquip = null;

		if (slot === "weapon") {
			const a = invItem.attributes || {};
			newEquip = {
				name: invItem.name,
				damage: a.damage || "1d4",
				damageType: a.damage_type || a.damageType || "bludgeoning",
				range: a.range || "melee",
			};
			oldEquip = p.weapon;
			p.weapon = newEquip;
		} else if (slot === "armor") {
			const a = invItem.attributes || {};
			newEquip = {
				name: invItem.name,
				ac: Number(a.ac) || 10,
				type: a.type || a.armor_type || "light",
				material: a.material || "",
				note: a.note || "",
			};
			oldEquip = p.armor;
			p.armor = newEquip;
		} else if (slot === "trinket") {
			newEquip = {
				name: invItem.name,
				description: invItem.description || "",
				attributes: invItem.attributes || {},
			};
			oldEquip = p.trinket || null;
			p.trinket = newEquip;
		} else {
			return null;
		}

		// Remove equipped item from inventory (decrement count or remove)
		if (invItem.count > 1) {
			invItem.count -= 1;
		} else {
			p.inventory.splice(idx, 1);
		}

		// Return old equipped item to inventory (if there was one)
		if (oldEquip && oldEquip.name) {
			const existing = p.inventory.find(i =>
				(typeof i === "string" ? i : i.name || "").toLowerCase() === oldEquip.name.toLowerCase()
			);
			if (existing && typeof existing === "object") {
				existing.count = (existing.count || 1) + 1;
			} else {
				// Build inventory entry from the old equipped item
				const attrs = {};
				if (slot === "weapon") {
					if (oldEquip.damage)     attrs.damage = oldEquip.damage;
					if (oldEquip.damageType) attrs.damage_type = oldEquip.damageType;
					if (oldEquip.range)      attrs.range = oldEquip.range;
					attrs.item_type = "weapon";
				} else if (slot === "armor") {
					if (oldEquip.ac)       attrs.ac = oldEquip.ac;
					if (oldEquip.type)     attrs.armor_type = oldEquip.type;
					if (oldEquip.material) attrs.material = oldEquip.material;
					attrs.item_type = "armor";
				} else if (slot === "trinket") {
					Object.assign(attrs, oldEquip.attributes || {});
					attrs.item_type = "trinket";
				}
				p.inventory.push({
					name: oldEquip.name,
					count: 1,
					description: oldEquip.description || oldEquip.note || "",
					attributes: attrs,
				});
			}
		}

		this.persist(lobbyId);
		return { equipped: newEquip, unequipped: oldEquip };
	}

	unequipItem(lobbyId, playerName, slot) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return null;
		const p = l.players[key];
		if (!p) return null;

		if (!["weapon", "armor", "trinket"].includes(slot)) return null;

		const oldEquip = p[slot];
		if (!oldEquip || !oldEquip.name) return null;

		// Return equipped item to inventory
		if (!Array.isArray(p.inventory)) p.inventory = [];
		const existing = p.inventory.find(i =>
			(typeof i === "string" ? i : i.name || "").toLowerCase() === oldEquip.name.toLowerCase()
		);
		if (existing && typeof existing === "object") {
			existing.count = (existing.count || 1) + 1;
		} else {
			const attrs = {};
			if (slot === "weapon") {
				if (oldEquip.damage)     attrs.damage = oldEquip.damage;
				if (oldEquip.damageType) attrs.damage_type = oldEquip.damageType;
				if (oldEquip.range)      attrs.range = oldEquip.range;
				attrs.item_type = "weapon";
			} else if (slot === "armor") {
				if (oldEquip.ac)       attrs.ac = oldEquip.ac;
				if (oldEquip.type)     attrs.armor_type = oldEquip.type;
				if (oldEquip.material) attrs.material = oldEquip.material;
				attrs.item_type = "armor";
			} else if (slot === "trinket") {
				Object.assign(attrs, oldEquip.attributes || {});
				attrs.item_type = "trinket";
			}
			p.inventory.push({
				name: oldEquip.name,
				count: 1,
				description: oldEquip.description || oldEquip.note || "",
				attributes: attrs,
			});
		}

		// Clear the equipment slot
		p[slot] = null;

		this.persist(lobbyId);
		return { unequipped: oldEquip };
	}

	// ==== Chat (single, non-duplicated implementation) ====
	getChat(lobbyId, limit = 50) {
		const l = this.index[lobbyId];
		if (!l) return [];
		l.chat = l.chat || [];
		return l.chat.slice(-limit);
	}
	appendChat(lobbyId, name, text) {
		const l = this.index[lobbyId];
		if (!l) return;
		l.chat = l.chat || [];
		l.chat.push({ name, text, timestamp: Date.now() });
		if (l.chat.length > 500) l.chat = l.chat.slice(-500);
		this.persist(lobbyId);
	}
	getChatUsers(lobbyId) {
		const l = this.index[lobbyId];
		if (!l) return [];
		const users = Object.values(l.sockets)
			.map((s) => s.playerName)
			.filter((n) => !!n && typeof n === "string");
		return [...new Set(users)];
	}
}
