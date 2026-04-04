/**
 * StoryTeller — Main server entry point.
 *
 * Express + Socket.IO server that orchestrates the D&D game loop.
 * Domain-specific logic is split into sub-modules under routes/ and helpers/.
 * This file wires them together and handles core game-flow socket events.
 */

import express from "express";
import fs from "fs";
import http from "http";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Server } from "socket.io";
import { LobbyStore } from "./services/lobbyStore.js";
import { getLLMResponse, hasLLM, hasOpenAI, hasClaude, sanitizeForLLMName, generateCharacterImage, validateLLMKeys } from "./services/llmService.js";
import { roll } from "./helpers/dice.js";
import fetch from "node-fetch";
import { randomUUID, generateKeyPairSync, createSign, createVerify, createPublicKey } from "crypto";
import { broadcastXPUpdates, broadcastHPUpdates, broadcastInventoryUpdates, broadcastGoldUpdates, broadcastConditionUpdates, broadcastPartyState } from "./services/gameUpdates.js";
import { updateMap, registerMapEndpoints, getDefaultPlayerEmoji } from "./services/mapService.js";
import { getAbilityForLevel } from "./helpers/classProgression.js";
import { resolveSfx, findMatch as findSfxMatch } from "./services/sfxService.js";

// Sub-modules
import { configure as configureAssets, ensureMusic, ensureMenuMusic, ensureSfx, ensureUiSfx } from "./helpers/assetDownloads.js";
import { parseDMJson } from "./helpers/parseDMJson.js";
import { registerAdminAuth } from "./routes/adminAuth.js";
import { registerAdminEvents } from "./routes/adminEvents.js";
import { fetchVoices, streamNarrationToClients, registerTTSRoutes } from "./routes/ttsService.js";
import { createTimerSystem } from "./routes/turnTimer.js";
import { registerChatEvents } from "./routes/chatEvents.js";

// ── Environment & Express setup ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const MUSIC_DIR = path.join(__dirname, "..", "client", "music");
const SFX_DIR   = path.join(__dirname, "..", "client", "sfx");

function log(...args) {
	const stamp = new Date().toISOString().split("T")[1].split(".")[0];
	console.log(`[${stamp}]`, ...args);
}
const room = (lobbyId) => lobbyId;

// ── Character signing keys ───────────────────────────────────────────────────

const CHAR_KEY_FILE = path.join(__dirname, "data", "charkey.pem");
let charPrivateKey, charPublicKey;
if (fs.existsSync(CHAR_KEY_FILE)) {
	charPrivateKey = fs.readFileSync(CHAR_KEY_FILE, "utf8");
	charPublicKey = createPublicKey(charPrivateKey).export({ type: "spki", format: "pem" });
} else {
	const kp = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding:  { type: "spki",  format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	charPrivateKey = kp.privateKey;
	charPublicKey  = kp.publicKey;
	fs.writeFileSync(CHAR_KEY_FILE, charPrivateKey, "utf8");
	console.log("🔑 Generated new character signing key");
}

// ── Core server + store ──────────────────────────────────────────────────────

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const store = new LobbyStore();

const args = process.argv.slice(2);
const devMode = args.includes("--devmode") || process.env.DEV_MODE?.toUpperCase() === "TRUE";
if (devMode) log("🧩 Developer mode enabled — skipping ElevenLabs TTS.");

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "dAcds2QMcvmv86jQMC3Y";
const REJECTED_REQUEST_STATUS = 204;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60000;
const HISTORY_SUMMARIZE_THRESHOLD = Number(process.env.HISTORY_SUMMARIZE_THRESHOLD) || 2;
const MAX_SUMMARY_LENGTH = Number(process.env.MAX_SUMMARY_LENGTH) || 60000;
const VOICE_CACHE_FILE = path.join(__dirname, "..", "client", "config", "voices_cache.json");

const serviceStatus = { openai: false, claude: false, elevenlabs: false };
const llmOpts = (lobbyId) => store.getLLMSettings(lobbyId);

// ── Configure sub-modules ────────────────────────────────────────────────────

configureAssets({ musicDir: MUSIC_DIR, sfxDir: SFX_DIR, log });

const ttsDeps = { ELEVEN_API_KEY, ELEVEN_VOICE_ID, VOICE_CACHE_FILE, devMode, REJECTED_REQUEST_STATUS, serviceStatus, log, room };

// Admin auth (registers routes on app, returns shared state)
const adminAuth = registerAdminAuth(app, { store, charPublicKey, log });

// Serve admin + client static files (AFTER admin auth middleware is registered)
app.use("/admin", express.static(path.join(__dirname, "..", "client", "admin")));
app.use(express.static(path.join(__dirname, "..", "client")));

// Menu music listing
const MENU_MUSIC_DIR = path.join(__dirname, "..", "client", "music", "menu");
app.get("/api/menu-music", (req, res) => {
	try {
		if (!fs.existsSync(MENU_MUSIC_DIR)) return res.json([]);
		const files = fs.readdirSync(MENU_MUSIC_DIR).filter(f => f.endsWith(".mp3"));
		res.json(files);
	} catch { res.json([]); }
});

// Game music listing — returns mp3 filenames for a given world + mood folder
const GAME_MUSIC_DIR = path.join(__dirname, "..", "client", "music", "game");
app.get("/api/game-music/:world/:mood", (req, res) => {
	try {
		const { world, mood } = req.params;
		// Sanitise path segments to prevent directory traversal
		if (/[./\\]/.test(world) || /[./\\]/.test(mood)) return res.json([]);
		const dir = path.join(GAME_MUSIC_DIR, world, mood);
		if (!fs.existsSync(dir)) return res.json([]);
		res.json(fs.readdirSync(dir).filter(f => f.endsWith(".mp3")));
	} catch { res.json([]); }
});

// Character images
const IMAGES_DIR = path.join(__dirname, "data", "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
app.use("/character-images", express.static(IMAGES_DIR));

// TTS routes (/api/voices, /api/voice-preview/:id)
registerTTSRoutes(app, ttsDeps);

// Timer system (creates closures over all game-loop helpers)
const timerSystem = createTimerSystem({
	io, store, room, log, devMode, ELEVEN_API_KEY, serviceStatus,
	LLM_TIMEOUT_MS, HISTORY_SUMMARIZE_THRESHOLD, MAX_SUMMARY_LENGTH,
	getLLMResponse, llmOpts, parseDMJson,
	streamNarrationToClients: (ioRef, rm, text, voiceId, pn) => streamNarrationToClients(ioRef, rm, text, voiceId, pn, ttsDeps),
	broadcastXPUpdates, broadcastHPUpdates, broadcastInventoryUpdates,
	broadcastGoldUpdates, broadcastConditionUpdates, broadcastPartyState,
	updateMap, resolveSfx, broadcastLobbies,
});

const {
	activeTimers, pendingTimerStarts, restVoteTimers,
	scheduleTimerAfterNarration, startTurnTimer, cancelTurnTimer,
	handleTimerExpiry, kickPlayerForInactivity,
	isPlayerConnected, resolveActiveTurn, checkAndEndIfAllDead,
	handleRestResolved, sendState,
} = timerSystem;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getActivePlayerNames(lobby) {
	if (!lobby || !lobby.sockets) return new Set();
	const names = new Set();
	for (const [sid, s] of Object.entries(lobby.sockets)) {
		if (s && s.playerName && io.sockets.sockets.has(sid)) names.add(s.playerName);
	}
	return names;
}

function getAvailableCharacters(lobby) {
	if (!lobby || !lobby.players) return [];
	const active = getActivePlayerNames(lobby);
	return Object.values(lobby.players)
		.filter(p => !active.has(p.name) && !p.dead)
		.map(p => ({
			name:        p.name,
			characterId: p.characterId || null,
			class:       p.class  || "Adventurer",
			race:        p.race   || "",
			level:       p.level  || 1,
		}));
}

// ── Lobby listing & hibernation ──────────────────────────────────────────────

function autoHibernateStaleGames() {
	const STALE_MS = 30 * 60 * 1000;
	const now = Date.now();
	for (const lobby of Object.values(store.index)) {
		if (lobby.phase !== "running") continue;
		const hasConnected = Object.entries(lobby.sockets || {}).some(
			([sid, rec]) => rec.playerName && io.sockets.sockets.has(sid)
		);
		const lastAct = lobby.lastActivity || lobby.createdAt || 0;
		const isStale = (now - lastAct) >= STALE_MS;
		if (!hasConnected || isStale) {
			lobby.phase = "hibernating";
			store.persist(lobby.lobbyId);
			log(`💤 Auto-hibernated lobby ${lobby.lobbyId} — ${!hasConnected ? "no connected players" : "inactive 30+ min"}`);
		}
	}
}

function getPublicLobbies() {
	autoHibernateStaleGames();
	return Object.values(store.index)
		.filter((l) => ["waiting", "running", "hibernating", "wiped", "completed"].includes(l.phase))
		.map((l) => ({
			code: l.code,
			adventureName: l.adventureName || null,
			phase: l.phase,
			playerCount: Object.keys(l.players || {}).length,
			players: Object.values(l.players || {}).map((p) => ({
				name: p.name || "Unknown",
				class: p.class || "Adventurer",
				race: p.race || null,
				level: p.level || 1,
				connected: isPlayerConnected(l.lobbyId, p.name || "Unknown"),
				isHost: !!(l.hostCharacterId && p.characterId === l.hostCharacterId),
			})),
			lastActivity: l.lastActivity || l.createdAt || null,
			hasPassword: !!l.isPrivate,
			campaignTone:    l.campaignTone  ? { label: l.campaignTone.label,  emoji: l.campaignTone.emoji  } : null,
			campaignTheme:   l.campaignTheme ? { label: l.campaignTheme.label, emoji: l.campaignTheme.emoji } : null,
			brutalityLevel:  l.brutalityLevel  ?? 5,
			difficulty:      l.difficulty      || "standard",
			lootGenerosity:  l.lootGenerosity  || "fair",
			campaignSetting: l.campaignSetting || "standard",
		}))
		.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
}

function broadcastLobbies() {
	io.to("lobbies:list").emit("lobbies:update", { lobbies: getPublicLobbies() });
}

// ══════════════════════════════════════════════════════════════════════════════
// ██ SOCKET CONNECTION HANDLER
// ══════════════════════════════════════════════════════════════════════════════

io.on("connection", (socket) => {
	log(`🔌 Client connected: ${socket.id}`);

	// ── Delegate to sub-modules ──
	registerChatEvents(socket, { io, store, room, log, sendState });
	registerAdminEvents(socket, {
		io, store, room, log,
		adminSessions: adminAuth.adminSessions,
		hostAdminTokens: adminAuth.hostAdminTokens,
		hostAdminSockets: adminAuth.hostAdminSockets,
		parseCookie: adminAuth.parseCookie,
		cleanExpired: adminAuth.cleanExpired,
		sendState, broadcastLobbies, broadcastPartyState,
		cancelTurnTimer, resolveActiveTurn, startTurnTimer, checkAndEndIfAllDead,
		resolveSfx, findSfxMatch, ELEVEN_API_KEY, getAbilityForLevel,
	});

	// ===== BASIC LOBBY =====
	socket.on("lobby:create", ({ password } = {}) => {
		try {
			const { lobbyId, code } = store.createLobby(socket.id, ELEVEN_VOICE_ID);
			if (password) store.setPassword(lobbyId, password);
			socket.join(room(lobbyId));
			socket.emit("lobby:created", { lobbyId, code });
			log(`🏰 Lobby created: ${lobbyId} (code ${code}) by ${socket.id}${password ? " [password protected]" : ""}`);
			sendState(lobbyId);
			broadcastLobbies();
		} catch (err) {
			log("💥 Error creating lobby:", err);
			socket.emit("toast", { type: "error", message: `Server error: ${err.message}` });
		}
	});

	socket.on("state:request", ({ lobbyId }) => {
		const state = store.publicState(lobbyId);
		if (!state) return;
		log(`🎵 state:request for lobby ${lobbyId} — currentMusic=${state.currentMusic || "null"}, phase=${state.phase}`);
		socket.join(room(lobbyId));
		socket.emit("state:update", state);
	});

	socket.on("lobbies:watch", () => {
		socket.join("lobbies:list");
		store.syncMetaFromDisk();
		socket.emit("lobbies:update", { lobbies: getPublicLobbies() });
	});

	socket.on("lobby:join", ({ code, password }) => {
		try {
			log(`🚪 Join request by ${socket.id} for code ${code}`);
			const lobbyId = store.findLobbyByCode(code);
			if (!lobbyId) {
				log(`⚠️ Invalid join attempt (code ${code})`);
				return socket.emit("toast", { type: "error", message: "Lobby not found" });
			}

			const lobby = store.index[lobbyId];
			if (!lobby) {
				log(`⚠️ Lobby ${lobbyId} not found in store.index`);
				return socket.emit("toast", { type: "error", message: "Lobby data not found" });
			}

			if (lobby.isPrivate) {
				if (!password) return socket.emit("lobby:needsPassword", { code });
				if (!store.verifyPassword(lobbyId, password)) {
					return socket.emit("toast", { type: "error", message: "Incorrect password." });
				}
			}

			if (lobby.phase === "running" || lobby.phase === "hibernating") {
				for (const sid of Object.keys(lobby.sockets)) {
					if (!io.sockets.sockets.has(sid)) delete lobby.sockets[sid];
				}
				const availableChars = getAvailableCharacters(lobby);
				return socket.emit("join:inProgress", {
					lobbyCode: lobby.code,
					availableChars,
					hibernating: lobby.phase === "hibernating",
				});
			}

			socket.join(room(lobbyId));
			store.addConnection(lobbyId, socket.id);
			socket.emit("lobby:joined", { lobbyId, code });
			const chatHistory = store.getChat(lobbyId, 50);
			socket.emit("chat:history", chatHistory);
			log(`✅ ${socket.id} joined lobby ${lobbyId} (${code})`);
			sendState(lobbyId);
		} catch (err) {
			log("💥 Error joining lobby:", err);
			socket.emit("toast", { type: "error", message: `Join failed: ${err.message}` });
		}
	});

	socket.on("lobby:settings", ({ lobbyId, timerEnabled, timerMinutes, maxMissedTurns, narratorVoiceId, narratorVoiceName, campaignTone, campaignTheme, brutalityLevel, difficulty, lootGenerosity, campaignSetting, startingLevel, llmProvider, llmModel }) => {
		if (!store.isHost(lobbyId, socket.id)) return;
		store.setTimerSettings(lobbyId, timerEnabled, timerMinutes, maxMissedTurns);
		if (narratorVoiceId !== undefined) store.setNarratorVoice(lobbyId, narratorVoiceId, narratorVoiceName);
		if (campaignTone !== undefined || campaignTheme !== undefined) store.setCampaignFlavor(lobbyId, campaignTone, campaignTheme);
		if (brutalityLevel !== undefined) store.setBrutalityLevel(lobbyId, brutalityLevel);
		if (difficulty     !== undefined) store.setDifficulty(lobbyId, difficulty);
		if (lootGenerosity !== undefined) store.setLootGenerosity(lobbyId, lootGenerosity);
		if (campaignSetting !== undefined) store.setCampaignSetting(lobbyId, campaignSetting);
		if (startingLevel  !== undefined) store.setStartingLevel(lobbyId, startingLevel);
		if (llmProvider || llmModel) store.setLLMSettings(lobbyId, llmProvider, llmModel);
		sendState(lobbyId);
		broadcastLobbies();
		log(`⚙️ Settings updated for lobby ${lobbyId}: timer=${timerEnabled}, tone=${campaignTone?.id ?? "-"}, difficulty=${difficulty ?? "-"}, loot=${lootGenerosity ?? "-"}, setting=${campaignSetting ?? "-"}`);
	});

	// === REST VOTING ===
	socket.on("rest:propose", async ({ lobbyId, type }) => {
		const actor = store.playerBySid(lobbyId, socket.id);
		if (!actor) return;
		const { current } = store.turnInfo(lobbyId);
		if (current !== actor.name) return socket.emit("toast", { type: "error", message: "It's not your turn." });
		if (!store.startRestVote(lobbyId, actor.name, type)) return socket.emit("toast", { type: "error", message: "A vote is already in progress." });

		const state = store.getVoteState(lobbyId);
		io.to(room(lobbyId)).emit("rest:vote:start", state);

		const result = store.checkVoteResolved(lobbyId);
		if (result) {
			await handleRestResolved(lobbyId, result, type, actor.name);
			return;
		}

		const timerId = setTimeout(async () => {
			restVoteTimers.delete(lobbyId);
			const voteState = store.getVoteState(lobbyId);
			if (!voteState) return;
			for (const name of voteState.pending) {
				store.castVote(lobbyId, name, "no");
			}
			const finalState = store.getVoteState(lobbyId);
			if (finalState) io.to(room(lobbyId)).emit("rest:vote:update", finalState);
			const finalResult = store.checkVoteResolved(lobbyId);
			if (finalResult) await handleRestResolved(lobbyId, finalResult, type, actor.name);
		}, 120_000);
		restVoteTimers.set(lobbyId, timerId);
	});

	socket.on("rest:vote", async ({ lobbyId, vote }) => {
		const actor = store.playerBySid(lobbyId, socket.id);
		if (!actor) return;
		const state = store.castVote(lobbyId, actor.name, vote);
		if (!state) return;
		io.to(room(lobbyId)).emit("rest:vote:update", state);
		const result = store.checkVoteResolved(lobbyId);
		if (result) await handleRestResolved(lobbyId, result, state.type, state.proposer);
	});

	// === PLAYER MANAGEMENT ===
	socket.on("player:kick", ({ lobbyId, playerName }) => {
		if (!store.isHost(lobbyId, socket.id)) return;
		const kickedSid = store.kickPlayer(lobbyId, playerName);
		if (kickedSid) {
			io.to(kickedSid).emit("player:kicked", { reason: "You were removed by the host." });
			const kickedSocket = io.sockets.sockets.get(kickedSid);
			if (kickedSocket) kickedSocket.leave(room(lobbyId));
		}
		log(`👢 ${playerName} kicked from lobby ${lobbyId}`);
		sendState(lobbyId);
		broadcastLobbies();
	});

	socket.on("join:rejoin", ({ lobbyCode, charName, clientId, characterId }) => {
		const lobbyId = store.findLobbyByCode(lobbyCode);
		if (!lobbyId) return socket.emit("toast", { type: "error", text: "Lobby not found." });

		const lobby = store.index[lobbyId];
		if (!lobby) return socket.emit("toast", { type: "error", text: "Lobby data missing." });
		if (lobby.phase !== "running" && lobby.phase !== "hibernating") return socket.emit("toast", { type: "error", text: "That game hasn't started yet." });
		if (!lobby.players[charName]) return socket.emit("toast", { type: "error", text: "Character not found." });

		const storedChar = lobby.players[charName];
		if (storedChar.characterId && characterId && storedChar.characterId !== characterId) {
			return socket.emit("toast", { type: "error", message: "Character file does not match. Upload the correct .stchar file to reclaim this character." });
		}

		for (const sid of Object.keys(lobby.sockets)) {
			if (!io.sockets.sockets.has(sid)) delete lobby.sockets[sid];
		}

		const active = new Set(Object.values(lobby.sockets).map((s) => s.playerName));
		if (active.has(charName)) return socket.emit("toast", { type: "error", text: "That character is already in use." });

		lobby.sockets[socket.id] = { clientId, playerName: charName };
		socket.join(lobbyId);

		if (lobby.players[charName]) delete lobby.players[charName].disconnected;

		if (lobby.phase !== "running") {
			log(`▶️ Lobby ${lobbyId} phase "${lobby.phase}" → "running" (player rejoined)`);
			lobby.phase = "running";
			store.persist(lobbyId);
		}

		const dex = Number(lobby.players[charName]?.stats?.dex) || 8;
		store.insertIntoInitiative(lobbyId, charName, dex);
		const { current, order } = resolveActiveTurn(lobbyId);
		io.to(room(lobbyId)).emit("turn:update", { current, order });

		if (current) startTurnTimer(lobbyId, 2 * 60 * 1000);

		const isRejoiningHost = !!(lobby.hostCharacterId && characterId && lobby.hostCharacterId === characterId);
		if (isRejoiningHost) {
			lobby.hostSid = socket.id;
			store.persist(lobbyId);
			log(`👑 Host reconnected: ${charName} (${socket.id})`);
		}

		io.to(room(lobbyId)).emit("toast", { type: "info", message: `${charName} has returned to the adventure!` });
		socket.emit("join:confirmed", { lobbyId, lobbyCode: lobby.code, state: store.publicState(lobbyId), isHost: isRejoiningHost });
		io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
		broadcastLobbies();
	});

	socket.on("player:join:game", async ({ lobbyCode, name, sheet }) => {
		try {
			const lobbyId = store.findLobbyByCode(lobbyCode);
			if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found." });

			const lobby = store.index[lobbyId];
			if (!lobby) return socket.emit("toast", { type: "error", message: "Lobby data missing." });
			if (lobby.phase !== "running" && lobby.phase !== "hibernating") return socket.emit("toast", { type: "error", message: "Game is not currently running." });

			if (lobby.phase !== "running") {
				log(`▶️ Lobby ${lobbyId} phase "${lobby.phase}" → "running" (new player joined)`);
				lobby.phase = "running";
				store.persist(lobbyId);
			}

			const cleanName = (name || "").trim();
			if (!cleanName) return socket.emit("toast", { type: "error", message: "Character name is required." });

			const activeNames = getActivePlayerNames(lobby);
			if (activeNames.has(cleanName)) return socket.emit("toast", { type: "error", message: `${cleanName} is already in the game.` });

			socket.join(lobbyId);
			lobby.sockets[socket.id] = { playerName: cleanName, ready: true };
			store.upsertPlayer(lobbyId, socket.id, cleanName, sheet);
			store.initializeAtLevel(lobbyId, cleanName, getAbilityForLevel);

			const dexVal = Number(sheet?.stats?.dex) || 8;
			store.insertIntoInitiative(lobbyId, cleanName, dexVal);

			socket.emit("join:confirmed", { lobbyId, lobbyCode, state: store.publicState(lobbyId) });

			const { current, order } = store.turnInfo(lobbyId);
			io.to(room(lobbyId)).emit("turn:update", { current, order });
			io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `${cleanName} has joined the adventure!` });
			broadcastLobbies();

			const raceStr = sheet?.race || "unknown race";
			const classStr = sheet?.class || "adventurer";
			const arrivalPrompt = `A new adventurer has just joined the party mid-adventure. Their name is ${cleanName}, a ${raceStr} ${classStr}. Write a brief, dramatic 2-3 sentence narration in the style of a Dungeon Master announcing their arrival to the group.`;

			let narration;
			try {
				narration = await getLLMResponse([
					{ role: "system", content: "You are a Dungeon Master narrating a D&D adventure. Be brief and dramatic. Output only the narration, no extra commentary." },
					{ role: "user", content: arrivalPrompt },
				], llmOpts(lobbyId));
			} catch (err) {
				log(`⚠️ Arrival narration failed: ${err.message}`);
				narration = `A new adventurer emerges from the shadows. Welcome ${cleanName} the ${raceStr} ${classStr} — may your blade stay sharp and your courage unwavering!`;
			}

			store.appendDM(lobbyId, narration);
			io.to(room(lobbyId)).emit("narration", { content: narration });
			await streamNarrationToClients(io, room(lobbyId), narration, store.getNarratorVoice(lobbyId), undefined, ttsDeps);
			io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));

		} catch (err) {
			console.error("💥 player:join:game error:", err);
			socket.emit("toast", { type: "error", message: "Failed to join game: " + err.message });
		}
	});

	socket.on("lobby:phase", ({ lobbyId, phase }) => {
		try {
			if (!store.isHost(lobbyId, socket.id)) {
				log(`⚠️ Unauthorized phase change attempt by ${socket.id}`);
				return socket.emit("toast", { type: "error", message: "Only host can change phase" });
			}
			store.setPhase(lobbyId, phase);
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `Phase → ${phase}` });
			log(`🔄 Phase for ${lobbyId} set to "${phase}"`);
			sendState(lobbyId);
		} catch (err) {
			log("💥 Error changing phase:", err);
		}
	});

	// === PLAYER SHEET & EQUIPMENT ===
	socket.on("player:sheet", ({ lobbyId, name, sheet }) => {
		try {
			if (!store.belongs(lobbyId, socket.id)) return;
			store.upsertPlayer(lobbyId, socket.id, name, sheet);
			store.initializeAtLevel(lobbyId, name, getAbilityForLevel);
			log(`🧙‍♂️ Player sheet saved: ${name} (lobby ${lobbyId})`);
			log(sheet);
			sendState(lobbyId);
			broadcastLobbies();
		} catch (err) {
			log("💥 Error saving sheet:", err);
		}
	});

	socket.on("item:equip", ({ lobbyId, itemName, slot }) => {
		try {
			if (!store.belongs(lobbyId, socket.id)) return;
			if (!["weapon", "armor", "trinket"].includes(slot)) {
				return socket.emit("toast", { type: "error", message: "Invalid equipment slot." });
			}
			const playerName = store.playerBySid(lobbyId, socket.id)?.name;
			if (!playerName) return;

			const result = store.equipItem(lobbyId, playerName, itemName, slot);
			if (!result) return socket.emit("toast", { type: "error", message: `Could not equip "${itemName}".` });

			log(`⚔️ ${playerName} equipped "${itemName}" as ${slot} (lobby ${lobbyId})`);
			socket.emit("toast", { type: "success", message: `Equipped ${result.equipped.name} as ${slot}.` });
			if (result.unequipped?.name) {
				socket.emit("toast", { type: "info", message: `${result.unequipped.name} returned to inventory.` });
			}
			sendState(lobbyId);
			broadcastPartyState(io, store, lobbyId);
		} catch (err) {
			log("💥 Error equipping item:", err);
			socket.emit("toast", { type: "error", message: "Failed to equip item." });
		}
	});

	socket.on("item:unequip", ({ lobbyId, slot }) => {
		try {
			if (!store.belongs(lobbyId, socket.id)) return;
			if (!["weapon", "armor", "trinket"].includes(slot)) {
				return socket.emit("toast", { type: "error", message: "Invalid equipment slot." });
			}
			const playerName = store.playerBySid(lobbyId, socket.id)?.name;
			if (!playerName) return;

			const result = store.unequipItem(lobbyId, playerName, slot);
			if (!result) return socket.emit("toast", { type: "error", message: `Nothing equipped in ${slot} slot.` });

			log(`🔄 ${playerName} unequipped "${result.unequipped.name}" from ${slot} (lobby ${lobbyId})`);
			socket.emit("toast", { type: "success", message: `Unequipped ${result.unequipped.name}.` });
			sendState(lobbyId);
			broadcastPartyState(io, store, lobbyId);
		} catch (err) {
			log("💥 Error unequipping item:", err);
			socket.emit("toast", { type: "error", message: "Failed to unequip item." });
		}
	});

	socket.on("player:ready", ({ lobbyId, ready }) => {
		try {
			if (!store.belongs(lobbyId, socket.id)) return;
			store.setReady(lobbyId, socket.id, !!ready);
			log(`🟢 Player ${socket.id} (${ready ? "ready" : "not ready"}) in lobby ${lobbyId}`);
			sendState(lobbyId);
		} catch (err) {
			log("💥 Error setting ready:", err);
		}
	});

	socket.on("player:levelup:confirm", ({ lobbyId, gains }) => {
		if (!store.belongs(lobbyId, socket.id)) return;
		const lobby = store.index[lobbyId];
		if (!lobby) return;
		const playerName = lobby.sockets[socket.id]?.playerName;
		if (!playerName) return;

		store.applyLevelGains(lobbyId, socket.id, gains);
		const { level: newLevel, hpGained } = store.increaseLevel(lobbyId, playerName);

		const playerClass = lobby.players[playerName]?.class;
		const newAbility = getAbilityForLevel(playerClass, newLevel);
		if (newAbility) store.addAbility(lobbyId, playerName, { ...newAbility, level: newLevel });

		const newStats = lobby.players[playerName]?.stats ?? null;
		socket.emit("player:levelup:confirm", { newStats, newLevel, hpGained, newAbility: newAbility || null });
		log(`⬆️ ${playerName} leveled up to ${newLevel} (+${hpGained} HP)${newAbility ? ` — gained: ${newAbility.name}` : ""}`);

		broadcastPartyState(io, store, lobbyId);

		if (store.checkLevelUp(lobbyId, playerName)) {
			const nextLevel = newLevel + 1;
			const upcomingAbility = getAbilityForLevel(playerClass, nextLevel);
			socket.emit("player:levelup", { newLevel: nextLevel, upcomingAbility: upcomingAbility || null });
		}
	});

	// ===== QUICK START (dev mode only) =====
	socket.on("game:quickstart", async ({ lobbyId }) => {
		if (!devMode) return socket.emit("toast", { type: "error", message: "Quick start is only available in dev mode" });
		if (!store.isHost(lobbyId, socket.id)) return socket.emit("toast", { type: "error", message: "Only host can quick start" });
		log(`⚡ Quick start for lobby ${lobbyId}`);
		store.setLLMSettings(lobbyId, "test", "test-stub");
		const lobby = store.index[lobbyId];
		if (lobby) {
			for (const sid of Object.keys(lobby.sockets)) store.setReady(lobbyId, sid, true);
		}
		socket.emit("game:quickstart:ready", { lobbyId });
	});

	// ===== GAME FLOW =====
	socket.on("game:start", async ({ lobbyId }) => {
		try {
			if (!store.isHost(lobbyId, socket.id)) return socket.emit("toast", { type: "error", message: "Only host can start" });
			if (!store.allReady(lobbyId)) return socket.emit("toast", { type: "error", message: "Not all players ready" });

			log(`🚀 Game starting for lobby ${lobbyId}`);
			console.log('Game starting event dispatched to lobby: ' + lobbyId);
			io.to(room(lobbyId)).emit("game:starting", { message: "✨ The Dungeon Master is preparing your tale..." });
			store.startGame(lobbyId);
			sendState(lobbyId);
			broadcastLobbies();
			broadcastPartyState(io, store, lobbyId);

			await new Promise((r) => setTimeout(r, 200));

			const setupPrompt = store.composeSetupPrompt(lobbyId);
			const namePrompt = `You are naming a Dungeons & Dragons adventure. Based on the party composition below, generate a short, dramatic adventure title of 3–5 words. Reply with ONLY the title — no quotes, no punctuation except hyphens, no extra text.\n\nParty:\n${store.playersSummary(lobbyId)}`;

			const [openingRaw, adventureNameRaw] = await Promise.all([
				getLLMResponse([{ role: "system", content: setupPrompt }], llmOpts(lobbyId)),
				getLLMResponse([{ role: "system", content: namePrompt }], llmOpts(lobbyId)),
			]);

			log(`🔍 [DEBUG] Raw setup LLM response:\n${openingRaw}`);
			let cleanText = "[Error: no content returned]";
			let setupMusic = null;
			let setupSuggestions = [];
			let setupSfx = [];
			if (typeof openingRaw === "string") {
				const setupObj = await parseDMJson(openingRaw, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
				if (setupObj) {
					log(`🔍 [DEBUG] Parsed setup JSON: music=${setupObj.music}, suggestions=${JSON.stringify(setupObj.suggestions)}`);
					cleanText = setupObj.text?.trim() || "[Error: no content returned]";
					setupMusic = setupObj.music || null;
					setupSuggestions = Array.isArray(setupObj.suggestions) ? setupObj.suggestions : [];
					setupSfx = Array.isArray(setupObj.sfx) ? setupObj.sfx : [];
				} else {
					log(`⚠️ [DEBUG] Setup JSON parse failed — falling back to plain text`);
					cleanText = openingRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
				}
			}
			io.to(room(lobbyId)).emit("debug:setup", { raw: openingRaw, parsedMusic: setupMusic, parsedSuggestions: setupSuggestions });

			const adventureName = typeof adventureNameRaw === "string" ? adventureNameRaw.trim().replace(/^["']|["']$/g, "") : "Untitled Adventure";
			store.setAdventureName(lobbyId, adventureName);
			io.to(room(lobbyId)).emit("adventure:name", { name: adventureName });

			store.appendDM(lobbyId, cleanText);
			io.to(room(lobbyId)).emit("narration", { content: cleanText });

			const openingMood = setupMusic || "exploration";
			store.setCurrentMusic(lobbyId, openingMood);
			io.to(room(lobbyId)).emit("music:change", { mood: openingMood });
			if (setupSuggestions.length) io.to(room(lobbyId)).emit("suggestions:update", { suggestions: setupSuggestions });

			if (setupSfx.length) {
				resolveSfx(setupSfx, ELEVEN_API_KEY).then(sfxFiles => {
					if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
				}).catch(err => log("⚠️ SFX resolve error:", err.message));
			}

			await streamNarrationToClients(io, room(lobbyId), cleanText, store.getNarratorVoice(lobbyId), undefined, ttsDeps);

			io.to(room(lobbyId)).emit("game:ready");
			scheduleTimerAfterNarration(lobbyId);
			log(`📜 Opening narration sent for lobby ${lobbyId}`);

			try {
				const playerList = Object.values(store.index[lobbyId]?.players || {});
				const cols = Math.max(1, Math.ceil(Math.sqrt(playerList.length)));
				const initialChars = playerList.map((p, i) => ({
					name:   p.name,
					type:   "player",
					emoji:  getDefaultPlayerEmoji(p.class),
					x:      8 + (i % cols) * 2,
					y:      9 + Math.floor(i / cols) * 2,
					facing: null,
					status: null,
				}));
				updateMap(io, store, lobbyId, initialChars, { type: "plains", features: [] });
			} catch (err) {
				console.error("💥 Failed to generate initial map:", err);
			}
		} catch (err) {
			log("💥 Error starting game:", err);
			console.error(err);
			try { store.setPhase(lobbyId, "waiting"); } catch (_) {}
			io.to(room(lobbyId)).emit("game:failed", { message: "The Dungeon Master ran into a problem. Please try again." });
			io.to(room(lobbyId)).emit("toast", { type: "error", message: `Failed to start game: ${err.message || "unknown error"}` });
			sendState(lobbyId);
		}
	});

	// ===== ACTION SUBMISSION (core gameplay loop) =====
	socket.on("action:submit", async ({ lobbyId, text }) => {
		try {
			const s = store.index[lobbyId];
			if (!s) {
				console.log("❌ Lobby not found:", lobbyId);
				socket.emit("toast", { type: "error", message: "Lobby not found." });
				return;
			}

			const actor = store.playerBySid(lobbyId, socket.id);
			if (!actor) {
				console.log("❌ Unknown player for socket:", socket.id);
				socket.emit("toast", { type: "error", message: "Unknown player." });
				return;
			} else {
				console.log('Got character information by socket for id: ' + socket.id);
				console.log(actor);
			}

			cancelTurnTimer(lobbyId);
			store.resetMissedTurns(lobbyId, actor.name);
			io.to(room(lobbyId)).emit("ui:lock", { actor: actor.name });

			const v = store.validateAction(lobbyId, socket.id, text);
			if (!v.ok) {
				console.log("⚠️ Action rejected:", v.reason);
				socket.emit("action:rejected", { reason: v.reason });
				io.to(room(lobbyId)).emit("ui:unlock");
				return;
			}

			store.appendUser(lobbyId, actor.name, text);
			const rollPayload = store.autoRollIfNeeded(lobbyId, socket.id, text);
			if (rollPayload) io.to(room(lobbyId)).emit("dice:result", rollPayload);

			const msgs = store.composeMessages(lobbyId, actor.name, text, rollPayload);
			console.log(`🎭 Action from ${actor.name}: "${text}"`);

			// Player voice narration
			const playerVoice = actor?.sheet?.voice_id || "nVR3DsQbqULlGfUZGjwn";
			if (playerVoice) {
				await streamNarrationToClients(io, room(lobbyId), text, playerVoice, actor.name, ttsDeps);
			} else {
				console.warn("⚠️ No valid player voice found — skipping player narration");
			}

			// LLM DM response
			const _timerLabel = `LLM_response_time_${lobbyId}_${Date.now()}`;
			console.time(_timerLabel);
			const rawReply = await Promise.race([getLLMResponse(msgs, llmOpts(lobbyId)), new Promise((_, rej) => setTimeout(() => rej(new Error(`LLM timeout after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS))]);
			console.timeEnd(_timerLabel);

			const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
			console.log(`📝 [LLM raw response] lobby=${lobbyId}:\n${replyText.slice(0, 2000)}${replyText.length > 2000 ? "…(truncated)" : ""}`);
			if (!replyText) {
				console.warn("⚠️ Empty LLM reply");
				io.to(room(lobbyId)).emit("toast", { type: "error", message: "DM returned an empty reply." });
				io.to(room(lobbyId)).emit("ui:unlock");
				return;
			}

			let dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
			console.log(`🔍 [DM parse] parsed=${!!dmObj}, text=${JSON.stringify((dmObj?.text || "").slice(0, 200))}, prompt=${JSON.stringify((dmObj?.prompt || "").slice(0, 200))}`);
			let narrationText;
			if (dmObj && typeof dmObj === "object") {
				// Use text from the parsed object; fall back to prompt if text is empty
				narrationText = dmObj.text || dmObj.prompt || replyText;
			} else {
				// parseDMJson failed — try a raw JSON.parse as last resort
				try {
					const fallback = JSON.parse(replyText);
					narrationText = fallback?.text || fallback?.content || replyText;
					if (typeof narrationText !== "string") narrationText = replyText;
				} catch {
					narrationText = replyText;
				}
			}

			if (dmObj && typeof dmObj === "object") {
				const u = dmObj.updates || {};
				broadcastXPUpdates(io, store, lobbyId, u.xp);
				broadcastHPUpdates(io, store, lobbyId, u.hp);
				await checkAndEndIfAllDead(lobbyId);

				if (store.index[lobbyId]?.phase === "wiped") {
					io.to(room(lobbyId)).emit("ui:unlock");
					return;
				}

				broadcastInventoryUpdates(io, store, lobbyId, u.inventory);
				broadcastGoldUpdates(io, store, lobbyId, u.gold);
				broadcastConditionUpdates(io, store, lobbyId, u.conditions);
				if (Array.isArray(u.enemies)) store.updateEnemies(lobbyId, u.enemies);
				if (dmObj.combat_over) store.purgeDeadEnemies(lobbyId);

				if (dmObj.spellUsed === true) {
					const player = store.index[lobbyId]?.players?.[actor.name];
					if (player) {
						const maxSlots = Number(player.level) || 1;
						if ((player.spellSlotsUsed || 0) < maxSlots) {
							player.spellSlotsUsed = (player.spellSlotsUsed || 0) + 1;
							store.persist(lobbyId);
							log(`🔮 Spell slot used by ${actor.name} (${player.spellSlotsUsed}/${maxSlots})`);
						}
					}
				}

				broadcastPartyState(io, store, lobbyId);
				updateMap(io, store, lobbyId, dmObj.characters || [], dmObj.terrain || null);
				if (Array.isArray(dmObj.suggestions) && dmObj.suggestions.length) {
					io.to(room(lobbyId)).emit("suggestions:update", { suggestions: dmObj.suggestions });
				}
				if (dmObj.music) {
					store.setCurrentMusic(lobbyId, dmObj.music);
					io.to(room(lobbyId)).emit("music:change", { mood: dmObj.music });
				}
				if (Array.isArray(dmObj.sfx) && dmObj.sfx.length) {
					resolveSfx(dmObj.sfx, ELEVEN_API_KEY).then(sfxFiles => {
						if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
					}).catch(err => log("⚠️ SFX resolve error:", err.message));
				}
			} else {
				console.warn("⚠️ LLM reply not structured or parse failed");
				console.log("Raw reply text:", replyText);
			}

			store.appendDM(lobbyId, narrationText);
			io.to(room(lobbyId)).emit("debug:llm", { raw: replyText, parsed: dmObj ?? null, narrationText });
			io.to(room(lobbyId)).emit("narration", { content: narrationText });
			await streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId), undefined, ttsDeps);

			if (dmObj?.roll?.sides) {
				io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
				io.to(room(lobbyId)).emit("ui:unlock");
				io.to(room(lobbyId)).emit("roll:required", {
					player: actor.name,
					sides: Number(dmObj.roll.sides),
					stats: Array.isArray(dmObj.roll.stats) ? dmObj.roll.stats : [],
					mods: Number(dmObj.roll.mods) || 0,
					dc: Number(dmObj.roll.dc) || 0,
				});
				return;
			}

			if (!v.tableTalk) {
				store.nextTurn(lobbyId);
				const { current, order } = resolveActiveTurn(lobbyId);
				io.to(room(lobbyId)).emit("turn:update", { current, order });
				scheduleTimerAfterNarration(lobbyId);
			}

			io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
			io.to(room(lobbyId)).emit("ui:unlock");

			if (store.needsSummarization(lobbyId, HISTORY_SUMMARIZE_THRESHOLD)) {
				store.autoSummarize(lobbyId, getLLMResponse, llmOpts(lobbyId), 10, MAX_SUMMARY_LENGTH).catch(() => {});
			}
		} catch (err) {
			console.error("💥 Error processing action:", err);
			socket.emit("toast", { type: "error", message: "The DM stumbled on that one. Try again." });
			io.to(room(lobbyId)).emit("ui:unlock");
		}
	});

	// === DICE ROLL ===
	socket.on("dice:roll", ({ lobbyId, kind, value }) => {
		try {
			const actor = store.playerBySid(lobbyId, socket.id);
			if (!actor) return;
			const text = `${actor.name} rolls a ${kind} and gets ${value}!`;
			io.to(room(lobbyId)).emit("action:log", { player: actor.name, text, timestamp: Date.now() });
			store.appendUser(lobbyId, actor.name, text);
			const messages = store.composeMessages(lobbyId, actor.name, text);
			getLLMResponse(messages, llmOpts(lobbyId)).then(async (dm) => {
				const replyText = typeof dm === "string" ? dm.trim() : "";
				const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
				const narrationText = dmObj?.text || replyText;
				store.appendDM(lobbyId, narrationText);
				io.to(room(lobbyId)).emit("narration", { content: narrationText });
				streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId), undefined, ttsDeps);
				sendState(lobbyId);
			});
		} catch (err) {
			log("💥 Dice roll error:", err);
		}
	});

	// === GAME END & STORY ===
	socket.on("game:end", ({ lobbyId }) => {
		if (!store.isHost(lobbyId, socket.id)) return;
		const s = store.index[lobbyId];
		if (!s || s.phase !== "running") return;
		store.setPhase(lobbyId, "completed");
		cancelTurnTimer(lobbyId);
		io.to(room(lobbyId)).emit("game:over", { reason: "completed" });
		broadcastLobbies();
		log(`🏆 Campaign completed for lobby ${lobbyId}`);
	});

	socket.on("game:summarize", async ({ lobbyId }) => {
		try {
			if (!store.belongs(lobbyId, socket.id)) return;
			log(`🧾 Summarizing game for lobby ${lobbyId}`);
			const prompt = store.composeSummaryPrompt(lobbyId);
			const s = await getLLMResponse([{ role: "system", content: prompt }, ...store.tail(lobbyId, 8)], llmOpts(lobbyId));
			store.summarize(lobbyId, s);
			io.to(room(lobbyId)).emit("narration", { content: `[Summary]\n${s}` });
			sendState(lobbyId);
		} catch (err) {
			log("💥 Error summarizing:", err);
		}
	});

	socket.on("story:pin", ({ lobbyId, historyIndex }) => {
		if (!store.belongs(lobbyId, socket.id)) return;
		const playerName = store.index[lobbyId]?.sockets?.[socket.id]?.playerName || "Unknown";
		const result = store.pinMoment(lobbyId, historyIndex, playerName);
		if (result.ok) {
			sendState(lobbyId);
			if (result.remaining <= 3) {
				socket.emit("toast", { message: `📌 Pinned! ${result.remaining} pin${result.remaining === 1 ? "" : "s"} remaining.`, type: "warning" });
			}
		} else if (result.reason === "limit_reached") {
			socket.emit("toast", { message: `📌 Pin limit reached (${store.constructor.MAX_PINS}). Unpin a less important moment first.`, type: "warning" });
		}
	});

	socket.on("story:unpin", ({ lobbyId, historyIndex }) => {
		if (!store.belongs(lobbyId, socket.id)) return;
		if (store.unpinMoment(lobbyId, historyIndex)) sendState(lobbyId);
	});

	socket.on("narration:done", ({ lobbyId }) => {
		if (pendingTimerStarts.has(lobbyId)) {
			clearTimeout(pendingTimerStarts.get(lobbyId));
			pendingTimerStarts.delete(lobbyId);
			startTurnTimer(lobbyId, 0);
		}
	});

	// === CONNECTION LIFECYCLE ===
	socket.on("disconnecting", () => {
		log(`⚡ disconnecting: ${socket.id} | rooms: ${[...socket.rooms].join(", ")}`);
		try {
			for (const [lobbyId, lobby] of Object.entries(store.index || {})) {
				const rec = lobby.sockets?.[socket.id];
				if (!rec) continue;

				const playerName = rec.playerName;
				log(`🔍 disconnecting: socket ${socket.id} found in lobby ${lobbyId} as "${playerName}" (phase: ${lobby.phase})`);

				if (lobby.phase === "waiting" && lobby.hostSid === socket.id) {
					log(`🗑️ Host disconnected from waiting lobby ${lobbyId} — removing lobby`);
					io.to(room(lobbyId)).emit("toast", { type: "error", message: "The host has left. This lobby has been closed." });
					io.to(room(lobbyId)).emit("lobby:closed");
					for (const sid of Object.keys(lobby.sockets)) {
						if (sid !== socket.id) {
							const otherSocket = io.sockets.sockets.get(sid);
							if (otherSocket) otherSocket.leave(room(lobbyId));
						}
					}
					store.deleteLobby(lobbyId);
					broadcastLobbies();
					continue;
				}

				if (playerName && (lobby.phase === "running" || lobby.phase === "hibernating")) {
					if (lobby.players[playerName]) lobby.players[playerName].disconnected = true;

					const timerEntry = activeTimers.get(lobbyId);
					if (timerEntry?.playerName === playerName) cancelTurnTimer(lobbyId);

					store.removeFromTurnOrder(lobbyId, playerName);

					log(`📣 Emitting player:left + toast + turn:update to room ${lobbyId}`);
					io.to(room(lobbyId)).emit("toast", { type: "warning", message: `${playerName} has left the adventure.` });
					io.to(room(lobbyId)).emit("player:left", { player: playerName });

					const { current, order } = resolveActiveTurn(lobbyId);
					log(`🔄 New turn order after disconnect: [${order.join(", ")}], current: ${current}`);
					io.to(room(lobbyId)).emit("turn:update", { current, order });
					startTurnTimer(lobbyId);

					const remaining = Object.values(lobby.sockets).filter((s) => s.playerName && s !== rec);
					log(`👥 Remaining connected players: ${remaining.map((s) => s.playerName).join(", ") || "none"}`);
					if (remaining.length === 0 && lobby.phase === "running") {
						lobby.phase = "hibernating";
						store.persist(lobbyId);
						log(`💤 Lobby ${lobbyId} hibernating — all players gone`);
						broadcastLobbies();
					}
				}
			}
		} catch (e) {
			console.warn("disconnecting cleanup error", e);
		}
	});

	socket.on("disconnect", () => {
		log(`❌ Client disconnected: ${socket.id}`);
		adminAuth.hostAdminSockets.delete(socket.id);
		try {
			for (const [lobbyId, lobby] of Object.entries(store.index || {})) {
				if (!lobby.sockets?.[socket.id]) continue;
				delete lobby.sockets[socket.id];
				store.persist(lobbyId);
				sendState(lobbyId);
				broadcastPartyState(io, store, lobbyId);
				broadcastLobbies();
				log(`📤 Post-disconnect state broadcast for lobby ${lobbyId}`);
			}
		} catch (e) {
			console.warn("disconnect cleanup error", e);
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// ██ HTTP API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/api/lobbies", (req, res) => {
	store.syncMetaFromDisk();
	res.json({ lobbies: getPublicLobbies() });
});

app.get("/api/lobby/:code/story", (req, res) => {
	const lobbyId = store.findLobbyByCode(req.params.code.toUpperCase());
	const s = lobbyId ? store.index[lobbyId] : null;
	if (!s) return res.status(404).json({ error: "Not found" });
	res.json({
		adventureName: s.adventureName || null,
		phase: s.phase,
		players: Object.keys(s.players || {}),
		history: s.history || [],
		storyContext: s.storyContext || null,
		ancientHistory: s.ancientHistory || "",
		pinnedMoments: s.pinnedMoments || [],
	});
});

app.get("/api/features", (req, res) => {
	res.json({
		openai:     serviceStatus.openai,
		claude:     serviceStatus.claude,
		elevenlabs: serviceStatus.elevenlabs,
		devMode,
		version:    process.env.APP_VERSION || "0.0",
	});
});

registerMapEndpoints(app, store);

// === CHARACTER IMAGE GENERATION ===
app.post("/api/character-image", async (req, res) => {
	try {
		const { lobbyId, playerName, sheet } = req.body;
		if (!lobbyId || !playerName) return res.status(400).json({ error: "Missing lobbyId or playerName" });
		if (devMode) return res.status(REJECTED_REQUEST_STATUS).json({ message: "Character image generation disabled in developer mode." });
		if (!hasLLM()) return res.status(503).json({ error: "Image generation unavailable — no OpenAI key configured" });

		log(`🎨 Generating character image for ${playerName} in lobby ${lobbyId}`);
		const b64 = await generateCharacterImage(sheet);

		const safeName = playerName.replace(/[^a-zA-Z0-9]/g, "_");
		const filename = `${lobbyId}-${safeName}.png`;
		const filepath = path.join(IMAGES_DIR, filename);
		fs.writeFileSync(filepath, Buffer.from(b64, "base64"));

		const imageUrl = `/character-images/${filename}`;
		const key = store.findPlayerKey(lobbyId, playerName);
		if (key && store.index[lobbyId]?.players[key]) {
			store.index[lobbyId].players[key].imageUrl = imageUrl;
			store.persist(lobbyId);
			sendState(lobbyId);
		}
		log(`✅ Character image saved: ${filename}`);
		res.json({ ok: true, url: imageUrl });
	} catch (err) {
		console.error("💥 Character image generation failed:", err);
		res.status(500).json({ error: err.message || "Image generation failed" });
	}
});

// === CHARACTER EXPORT/IMPORT ===
app.post("/api/character/export", (req, res) => {
	try {
		const { name, sheet } = req.body;
		if (!name || !sheet) return res.status(400).json({ error: "Missing character data" });
		const payload = JSON.stringify({ name, sheet, exportedAt: new Date().toISOString() });
		const data = Buffer.from(payload).toString("base64");
		const sign = createSign("SHA256");
		sign.update(data);
		sign.end();
		const sig = sign.sign(charPrivateKey, "base64");
		res.json({ v: 1, data, sig });
	} catch (err) {
		console.error("Character export error:", err);
		res.status(500).json({ error: "Export failed" });
	}
});

app.post("/api/character/import", (req, res) => {
	try {
		const { data, sig } = req.body;
		if (!data || !sig) return res.status(400).json({ error: "Missing export fields" });
		const verify = createVerify("SHA256");
		verify.update(data);
		verify.end();
		const valid = verify.verify(charPublicKey, sig, "base64");
		if (!valid) return res.status(400).json({ error: "Character file is invalid or has been tampered with" });
		const character = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
		res.json({ ok: true, character });
	} catch (err) {
		console.error("Character import error:", err);
		res.status(400).json({ error: "Import failed — file may be corrupted" });
	}
});

// ══════════════════════════════════════════════════════════════════════════════
// ██ STARTUP
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

async function validateServices() {
	log("🔑 Validating API keys...");
	const llm = await validateLLMKeys();
	serviceStatus.openai = llm.openai.ok;
	serviceStatus.claude = llm.claude.ok;
	if (llm.openai.ok)  log("  ✅ OpenAI API key is valid");
	else                 log(`  ❌ OpenAI: ${llm.openai.error}`);
	if (llm.claude.ok)  log("  ✅ Claude API key is valid");
	else                 log(`  ❌ Claude: ${llm.claude.error}`);
	if (!ELEVEN_API_KEY) {
		log("  ❌ ElevenLabs: No API key configured");
	} else if (devMode) {
		log("  ⏭️  ElevenLabs: Skipped (dev mode)");
		serviceStatus.elevenlabs = true;
	} else {
		try {
			const voices = await fetchVoices(ttsDeps);
			if (voices.length > 0) {
				serviceStatus.elevenlabs = true;
				log(`  ✅ ElevenLabs API key is valid (${voices.length} voices loaded)`);
			} else {
				log("  ❌ ElevenLabs: Key may be invalid (0 voices returned)");
			}
		} catch (err) {
			log(`  ❌ ElevenLabs: ${err.message || err}`);
		}
	}
	const active = [
		serviceStatus.openai && "OpenAI",
		serviceStatus.claude && "Claude",
		serviceStatus.elevenlabs && "ElevenLabs",
	].filter(Boolean);
	log(`🟢 Active services: ${active.length ? active.join(", ") : "none (stub mode)"}`);
}

function validateConfigFiles() {
	log("📋 Validating config files...");
	const configDir = path.join(__dirname, "..", "client", "config");
	const configs = [
		{ file: "armor.json", check: (d) => { if (!Array.isArray(d)) return "Expected an array"; if (!d.length) return "Array is empty"; const missing = []; if (!d[0].name) missing.push("name"); if (d[0].ac === undefined) missing.push("ac"); if (!d[0].classes) missing.push("classes"); if (missing.length) return `First entry missing: ${missing.join(", ")}`; return null; } },
		{ file: "weapons.json", check: (d) => { if (!Array.isArray(d)) return "Expected an array"; if (!d.length) return "Array is empty"; const missing = []; if (!d[0].name) missing.push("name"); if (!d[0].damage) missing.push("damage"); if (!d[0].classes) missing.push("classes"); if (missing.length) return `First entry missing: ${missing.join(", ")}`; return null; } },
		{ file: "raceNames.json", check: (d) => { if (typeof d !== "object" || Array.isArray(d)) return "Expected an object keyed by race"; const races = Object.keys(d); if (!races.length) return "No races defined"; const first = d[races[0]]; if (!first.male_first || !first.female_first || !first.last) return `Race "${races[0]}" missing male_first, female_first, or last`; return null; } },
		{ file: "campaignFlavors.json", check: (d) => { if (typeof d !== "object") return "Expected an object"; if (!Array.isArray(d.tones) || !d.tones.length) return "Missing or empty 'tones' array"; if (!Array.isArray(d.themes) || !d.themes.length) return "Missing or empty 'themes' array"; const t = d.tones[0]; if (!t.id || !t.label || !t.prompt) return "First tone missing id, label, or prompt"; return null; } },
		{ file: "music_moods.json", check: (d) => { if (typeof d !== "object") return "Expected an object"; if (!Array.isArray(d.moods) || !d.moods.length) return "Missing or empty 'moods' array"; const m = d.moods[0]; if (!m.id || !m.label) return "First mood missing id or label"; return null; } },
		{ file: "classProgression.json", check: (d) => { if (typeof d !== "object" || Array.isArray(d)) return "Expected an object keyed by class name"; const classes = Object.keys(d); if (!classes.length) return "No classes defined"; const first = d[classes[0]]; const levels = Object.keys(first); if (!levels.length) return `Class "${classes[0]}" has no level entries`; const entry = first[levels[0]]; if (!Array.isArray(entry) || !entry.length) return `Class "${classes[0]}" level ${levels[0]} should be a non-empty array`; if (!entry[0].name || !entry[0].description) return `First ability in "${classes[0]}" missing name or description`; return null; } },
	];
	let allOk = true;
	for (const { file, check } of configs) {
		const filePath = path.join(configDir, file);
		try {
			if (!fs.existsSync(filePath)) { log(`  ❌ ${file}: File not found`); allOk = false; continue; }
			const raw = fs.readFileSync(filePath, "utf8");
			let data;
			try { data = JSON.parse(raw); } catch (parseErr) { log(`  ❌ ${file}: Invalid JSON — ${parseErr.message}`); allOk = false; continue; }
			const problem = check(data);
			if (problem) { log(`  ⚠️  ${file}: ${problem}`); allOk = false; }
			else {
				const keys = Object.keys(data);
				const size = Array.isArray(data) ? `${data.length} entries` : data.songs ? `${Object.keys(data.moods).length} moods, ${data.songs.length} songs` : data.tones ? `${data.tones.length} tones, ${data.themes.length} themes` : file === "classProgression.json" ? `${keys.length} classes` : `${keys.length} entries`;
				log(`  ✅ ${file} (${size})`);
			}
		} catch (err) { log(`  ❌ ${file}: ${err.message}`); allOk = false; }
	}
	if (allOk) log("📋 All config files OK");
}

ensureMusic().then(() => ensureMenuMusic()).then(() => ensureSfx()).then(() => ensureUiSfx()).then(() => {
	server.listen(PORT, async () => {
		log(`✅ Server running at http://localhost:${PORT}`);
		validateConfigFiles();
		await validateServices();
	});
});
