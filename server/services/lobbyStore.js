/**
 * LobbyStore — core persistence, lobby lifecycle, and public state.
 *
 * All domain-specific methods are defined in sub-modules under ./lobby/
 * and mixed into LobbyStore.prototype below.  This keeps the core small
 * while preserving a single class with the same public API.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDefaultLLMSettings } from "./llmService.js";

// Sub-module mixins
import { historyMethods, MAX_PINS } from "./lobby/lobbyHistory.js";
import { promptMethods } from "./lobby/lobbyPrompts.js";
import { playerMethods } from "./lobby/lobbyPlayers.js";
import { combatMethods } from "./lobby/lobbyCombat.js";
import { progressionMethods } from "./lobby/lobbyProgression.js";
import { settingsMethods } from "./lobby/lobbySettings.js";

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

export class LobbyStore {
	static MAX_PINS = MAX_PINS;

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

	findLobbyByCode(code) {
		return this.codeMap[code];
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
}

// ── Apply sub-module methods to the prototype ──
Object.assign(
	LobbyStore.prototype,
	historyMethods,
	promptMethods,
	playerMethods,
	combatMethods,
	progressionMethods,
	settingsMethods,
);
