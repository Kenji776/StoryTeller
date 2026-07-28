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
import { broadcastXPUpdates, broadcastHPUpdates, broadcastInventoryUpdates, broadcastGoldUpdates, broadcastConditionUpdates, broadcastPartyState, broadcastAbilityUpdates } from "./services/gameUpdates.js";
import { updateMap, registerMapEndpoints, getDefaultPlayerEmoji } from "./services/mapService.js";
import { getAbilityForLevel } from "./helpers/classProgression.js";
import { resolveSfx, findMatch as findSfxMatch } from "./services/sfxService.js";

// Sub-modules
import { configure as configureAssets, ensureMusic, ensureMenuMusic, ensureSfx, ensureUiSfx } from "./helpers/assetDownloads.js";
import { parseDMJson } from "./helpers/parseDMJson.js";
import { registerAdminAuth } from "./routes/adminAuth.js";
import { registerAdminEvents } from "./routes/adminEvents.js";
import { registerTTSRoutes } from "./routes/ttsService.js";
import { streamNarrationToClients } from "./services/tts/narrate.js";
import { resolveTTSProvider, normalizeProviderId, probeAvailability } from "./services/tts/registry.js";
import { loadLocalTtsUrl, saveLocalTtsUrl } from "./services/tts/localConfig.js";
import { createTimerSystem } from "./routes/turnTimer.js";
import { registerChatEvents } from "./routes/chatEvents.js";
import { createActionGate } from "./services/actionGate.js";
import { createAdvisor } from "./services/newbieAdvisor.js";
import { EventJournal } from "./services/eventJournal.js";
import { createLobbyBus } from "./services/lobbyBus.js";
import { PlayerSessions } from "./services/playerSessions.js";
import { createSessionSystem } from "./routes/sessionEvents.js";
import { createIncidentLog, SEVERITY } from "./services/incidents.js";
import { isLLMFailure } from "./services/llmFailure.js";
import { createRepairs } from "./services/adminRepairs.js";
import { configureUpdates } from "./services/gameUpdates.js";
import { buildCapability, slotCapacity } from "./services/characterCapability.js";
import { xpForKills } from "./services/experience.js";

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
// Admins watching a lobby join this alongside the game room, so operator-facing
// traffic can be addressed without broadcasting it to the players. Kept in step
// with the join in routes/adminEvents.js.
const adminRoom = (lobbyId) => `admin:${lobbyId}`;

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

/**
 * Reconnection layer. The journal and bus give every state-bearing broadcast a
 * per-lobby sequence number, so a client can tell it missed something and ask for
 * exactly the events it lacks. `busIo` is an io-compatible facade: broadcasts aimed
 * at a lobby are sequenced, everything else passes through untouched.
 */
const eventJournal = new EventJournal();
const lobbyBus = createLobbyBus({
	io,
	journal: eventJournal,
	epoch: Date.now(),
	buildSnapshot: (id) => store.publicState(id),
});
const busIo = lobbyBus.wrapIo(io, (target) => !!store.index[target]);
const playerSessions = new PlayerSessions();

/**
 * Anything the server cannot heal by itself is recorded here and pushed live to any
 * admin watching that lobby, so a silently-dropped update stops being invisible.
 */
const incidents = createIncidentLog({
	notify: (lobbyId, incident) => io.to(adminRoom(lobbyId)).emit("admin:incident", incident),
});
configureUpdates({ incidents });

const repairs = createRepairs({
	store,
	log,
	emitToLobby: (lobbyId, event, payload) => busIo.to(lobbyId).emit(event, payload),
	broadcastPartyState: (lobbyId) => broadcastPartyState(busIo, store, lobbyId),
});

const args = process.argv.slice(2);
const devMode = args.includes("--devmode") || process.env.DEV_MODE?.toUpperCase() === "TRUE";
if (devMode) log("🧩 Developer mode enabled — skipping ElevenLabs TTS.");

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "dAcds2QMcvmv86jQMC3Y";
// Seed address for the local speech server. A host can point the game somewhere
// else from the settings window, and that choice is persisted and wins from then
// on — a self-hosted server can be on any machine and port and there is no way to
// guess it. Every supplied address must resolve onto a private network before the
// server will dial it; see docs/decisions/0006-host-configurable-local-tts-address.md.
const LOCAL_TTS_URL = process.env.LOCAL_TTS_URL || "http://127.0.0.1:8199";
const TTS_CONFIG_FILE = path.join(__dirname, "data", "tts-config.json");
const REJECTED_REQUEST_STATUS = 204;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60000;
const HISTORY_SUMMARIZE_THRESHOLD = Number(process.env.HISTORY_SUMMARIZE_THRESHOLD) || 2;
const MAX_SUMMARY_LENGTH = Number(process.env.MAX_SUMMARY_LENGTH) || 60000;
const VOICE_CACHE_FILE = path.join(__dirname, "..", "client", "config", "voices_cache.json");

const serviceStatus = { openai: false, claude: false, elevenlabs: false };
const llmOpts = (lobbyId) => store.getLLMSettings(lobbyId);

/**
 * Which TTS engines are reachable right now. Populated by the boot probe and
 * updated by the voice routes when a provider that was down starts answering.
 */
const ttsAvailability = { local: false, elevenlabs: false };

/** Voice each provider falls back to when a lobby has chosen none. */
const ttsDefaultVoice = { local: null, elevenlabs: ELEVEN_VOICE_ID };

/** Spoken player lines fall back to this ElevenLabs voice when a sheet carries none. */
const PLAYER_FALLBACK_VOICE_ID = "nVR3DsQbqULlGfUZGjwn";

/**
 * Live address of the local speech server, shared by mutation with the TTS routes.
 *
 * A saved address beats the environment: once a host has pointed the game at a real
 * server, a stale `LOCAL_TTS_URL` in a compose file must not win on the next restart.
 */
const localTts = { url: loadLocalTtsUrl({ configPath: TTS_CONFIG_FILE, fallback: LOCAL_TTS_URL }) };

// ── Configure sub-modules ────────────────────────────────────────────────────

configureAssets({ musicDir: MUSIC_DIR, sfxDir: SFX_DIR, log });

/**
 * Builds the dependency bundle a TTS adapter needs.
 *
 * @description Each adapter takes only what it uses, so the ElevenLabs key is never
 *   handed to the local server and vice versa.
 * @param {string} id - A registered provider id.
 * @returns {object} The bundle for that provider.
 */
const providerDepsFor = (id) => (id === "local"
	? { LOCAL_TTS_URL: localTts.url, log }
	: { ELEVEN_API_KEY, VOICE_CACHE_FILE, log });

/**
 * Decides which engine and voice a lobby's narration should use.
 *
 * @description The stored choice is normalised against live availability, so a
 *   lobby whose provider has gone offline degrades to one that works rather than
 *   falling silent. Voice preference runs caller → lobby setting → provider default.
 * @param {string} lobbyId - The lobby about to narrate.
 * @param {string|null} requestedVoiceId - Voice the call site asked for, if any.
 * @returns {{provider: object, providerDeps: object, voiceId: string|null}|null}
 *   Null when no engine is available.
 */
const resolveTTS = (lobbyId, requestedVoiceId) => {
	const providerId = normalizeProviderId(store.getTTSProvider(lobbyId), ttsAvailability);
	const provider = resolveTTSProvider(providerId);
	if (!provider) return null;
	return {
		provider,
		providerDeps: providerDepsFor(providerId),
		voiceId: requestedVoiceId || store.getNarratorVoice(lobbyId) || ttsDefaultVoice[providerId] || null,
	};
};

const ttsDeps = { resolve: resolveTTS, devMode, REJECTED_REQUEST_STATUS, log, room };

/**
 * Whether narration audio will actually reach a lobby.
 *
 * @description The turn timer branches on this: when audio is coming it waits for
 *   the client's `narration:done`, and when it is not it applies a fixed reading
 *   delay instead. Before TTS was pluggable this was "is there an ElevenLabs key",
 *   which would now wrongly report silence for a lobby narrating locally.
 * @param {string} lobbyId - The lobby about to take a turn.
 * @returns {boolean} True when a provider is resolvable and dev mode is off.
 */
const ttsActiveFor = (lobbyId) => !devMode && Boolean(resolveTTS(lobbyId, null));

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

// TTS routes (/api/tts/providers, /api/voices, /api/voice-preview/:id)
registerTTSRoutes(app, {
	providerDepsFor,
	availability: ttsAvailability,
	devMode,
	log,
	localTts,
	saveLocalUrl: (url) => saveLocalTtsUrl(url, { configPath: TTS_CONFIG_FILE }),
});

// Populated once the session registry is constructed below; the timer system is
// created first, so it reaches the check through this indirection.
let graceCheck = () => false;

// Timer system (creates closures over all game-loop helpers)
const timerSystem = createTimerSystem({
	io: busIo, store, room, log, devMode, ELEVEN_API_KEY, ttsActiveFor,
	LLM_TIMEOUT_MS, HISTORY_SUMMARIZE_THRESHOLD, MAX_SUMMARY_LENGTH,
	getLLMResponse, llmOpts, parseDMJson,
	streamNarrationToClients: (ioRef, lobbyId, text, voiceId, pn) => streamNarrationToClients(ioRef, lobbyId, text, voiceId, pn, ttsDeps),
	broadcastXPUpdates, broadcastHPUpdates, broadcastInventoryUpdates,
	broadcastGoldUpdates, broadcastConditionUpdates, broadcastPartyState,
	broadcastAbilityUpdates,
	updateMap, resolveSfx, broadcastLobbies,
	// Lets the timer system honour a disconnect grace window; supplied after the
	// session registry exists, via the mutable holder below.
	hasGrace: (lobbyId, playerName) => graceCheck(lobbyId, playerName),
});

const {
	activeTimers, pendingTimerStarts, restVoteTimers,
	scheduleTimerAfterNarration, startTurnTimer, cancelTurnTimer,
	resumeTurnTimer, skipTurn,
	handleTimerExpiry, kickPlayerForInactivity,
	isPlayerConnected, resolveActiveTurn, checkAndEndIfAllDead,
	handleRestResolved, sendState,
} = timerSystem;

/**
 * Feasibility gate. Defaults to "observe": it forms a verdict and logs it but
 * rejects nothing, so a session's real judgements can be reviewed before it starts
 * telling players no. Set FEASIBILITY_MODE=hard or =judge to enforce.
 */
graceCheck = (lobbyId, playerName) => playerSessions.byPlayer(lobbyId, playerName)?.state === "grace";

const sessionSystem = createSessionSystem({
	io: busIo, store, room, log,
	sessions: playerSessions,
	bus: lobbyBus,
	resolveActiveTurn, startTurnTimer, cancelTurnTimer, broadcastLobbies,
});

// Releases seats whose grace window has fully lapsed. Runs often enough that a
// genuinely departed player does not hold up the table for long.
setInterval(() => { try { sessionSystem.sweep(); } catch (err) { log('sweep error', err.message); } }, 15_000).unref();

const advisor = createAdvisor({ store, log, getLLMResponse, llmOpts, buildCapability });

const actionGate = createActionGate({
	store,
	log,
	mode: process.env.FEASIBILITY_MODE || "observe",
	getLLMResponse,
	llmOpts,
	resumeTurnTimer,
	skipTurn,
});

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
	busIo.to("lobbies:list").emit("lobbies:update", { lobbies: getPublicLobbies() });
}

// ══════════════════════════════════════════════════════════════════════════════
// ██ SOCKET CONNECTION HANDLER
// ══════════════════════════════════════════════════════════════════════════════

io.on("connection", (socket) => {
	log(`🔌 Client connected: ${socket.id}`);

	// ── Delegate to sub-modules ──
	sessionSystem.registerSessionEvents(socket);
	registerChatEvents(socket, { io, store, room, log, sendState });
	registerAdminEvents(socket, {
		io, store, room, adminRoom, log,
		adminSessions: adminAuth.adminSessions,
		hostAdminTokens: adminAuth.hostAdminTokens,
		hostAdminSockets: adminAuth.hostAdminSockets,
		parseCookie: adminAuth.parseCookie,
		cleanExpired: adminAuth.cleanExpired,
		sendState, broadcastLobbies, broadcastPartyState,
		incidents, repairs,
		cancelTurnTimer, resolveActiveTurn, startTurnTimer, checkAndEndIfAllDead,
		resolveSfx, findSfxMatch, ELEVEN_API_KEY, getAbilityForLevel,
	});

	// ===== BASIC LOBBY =====
	socket.on("lobby:create", ({ password } = {}) => {
		try {
			const defaultTTS = normalizeProviderId(null, ttsAvailability);
			const { lobbyId, code } = store.createLobby(socket.id, ttsDefaultVoice[defaultTTS] || null);
			if (defaultTTS) store.setTTSProvider(lobbyId, defaultTTS);
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
		// Carries the watermark even though this is a targeted reply, not a broadcast.
		// Without it a client that recovers through state:request holds no sequence or
		// epoch, so its gap detector can never fire — and any later resync request is
		// answered with a full snapshot because the epoch does not match.
		socket.emit("state:update", state, {
			lid: lobbyId,
			seq: lobbyBus.seqOf(lobbyId),
			epoch: lobbyBus.epoch,
			ts: Date.now(),
		});
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

	socket.on("lobby:settings", ({ lobbyId, timerEnabled, timerMinutes, maxMissedTurns, ttsProvider, narratorVoiceId, narratorVoiceName, campaignTone, campaignTheme, brutalityLevel, difficulty, lootGenerosity, campaignSetting, startingLevel, abilitySlotsBase, llmProvider, llmModel }) => {
		if (!store.isHost(lobbyId, socket.id)) return;
		store.setTimerSettings(lobbyId, timerEnabled, timerMinutes, maxMissedTurns);
		// Provider first: switching engines swaps in that engine's remembered voice,
		// which a narratorVoiceId in the same message is then free to overwrite.
		if (ttsProvider !== undefined) store.setTTSProvider(lobbyId, ttsProvider);
		if (narratorVoiceId !== undefined) store.setNarratorVoice(lobbyId, narratorVoiceId, narratorVoiceName);
		if (campaignTone !== undefined || campaignTheme !== undefined) store.setCampaignFlavor(lobbyId, campaignTone, campaignTheme);
		if (brutalityLevel !== undefined) store.setBrutalityLevel(lobbyId, brutalityLevel);
		if (difficulty     !== undefined) store.setDifficulty(lobbyId, difficulty);
		if (lootGenerosity !== undefined) store.setLootGenerosity(lobbyId, lootGenerosity);
		if (campaignSetting !== undefined) store.setCampaignSetting(lobbyId, campaignSetting);
		if (startingLevel  !== undefined) store.setStartingLevel(lobbyId, startingLevel);
		if (abilitySlotsBase !== undefined) store.setAbilitySlotsBase(lobbyId, abilitySlotsBase);
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
		busIo.to(room(lobbyId)).emit("rest:vote:start", state);

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
			if (finalState) busIo.to(room(lobbyId)).emit("rest:vote:update", finalState);
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
		busIo.to(room(lobbyId)).emit("rest:vote:update", state);
		const result = store.checkVoteResolved(lobbyId);
		if (result) await handleRestResolved(lobbyId, result, state.type, state.proposer);
	});

	// === PLAYER MANAGEMENT ===
	socket.on("player:kick", ({ lobbyId, playerName }) => {
		if (!store.isHost(lobbyId, socket.id)) return;
		const kickedSid = store.kickPlayer(lobbyId, playerName);
		if (kickedSid) {
			busIo.to(kickedSid).emit("player:kicked", { reason: "You were removed by the host." });
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
		sessionSystem.openSession(lobbyId, charName, socket);
		socket.join(lobbyId);

		if (lobby.players[charName]) delete lobby.players[charName].disconnected;

		if (lobby.phase !== "running") {
			log(`▶️ Lobby ${lobbyId} phase "${lobby.phase}" → "running" (player rejoined)`);
			lobby.phase = "running";
			store.persist(lobbyId);
		}

		// Rolls a fresh initiative and places them by it; DEX is read from the stored
		// sheet, so no score needs passing in.
		store.insertIntoInitiative(lobbyId, charName);
		const { current, order } = resolveActiveTurn(lobbyId);
		busIo.to(room(lobbyId)).emit("turn:update", store.turnInfo(lobbyId));

		if (current) startTurnTimer(lobbyId, 2 * 60 * 1000);

		const isRejoiningHost = !!(lobby.hostCharacterId && characterId && lobby.hostCharacterId === characterId);
		if (isRejoiningHost) {
			lobby.hostSid = socket.id;
			store.persist(lobbyId);
			log(`👑 Host reconnected: ${charName} (${socket.id})`);
		}

		busIo.to(room(lobbyId)).emit("toast", { type: "info", message: `${charName} has returned to the adventure!` });
		socket.emit("join:confirmed", { lobbyId, lobbyCode: lobby.code, state: store.publicState(lobbyId), isHost: isRejoiningHost });
		busIo.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
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
			sessionSystem.openSession(lobbyId, cleanName, socket);
			store.upsertPlayer(lobbyId, socket.id, cleanName, sheet);
			store.initializeAtLevel(lobbyId, cleanName, getAbilityForLevel);

			store.insertIntoInitiative(lobbyId, cleanName);

			socket.emit("join:confirmed", { lobbyId, lobbyCode, state: store.publicState(lobbyId) });

			busIo.to(room(lobbyId)).emit("turn:update", store.turnInfo(lobbyId));
			busIo.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
			busIo.to(room(lobbyId)).emit("player:joined", { player: cleanName });
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
			busIo.to(room(lobbyId)).emit("narration", { content: narration });
			await streamNarrationToClients(busIo, lobbyId, narration, store.getNarratorVoice(lobbyId), undefined, ttsDeps);
			busIo.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));

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
			busIo.to(room(lobbyId)).emit("toast", { type: "info", message: `Phase → ${phase}` });
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
			// This is where a pre-game player first has a name, so it is the earliest
			// point a session can be tied to them.
			sessionSystem.openSession(lobbyId, name, socket);
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
			broadcastPartyState(busIo, store, lobbyId);
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
			broadcastPartyState(busIo, store, lobbyId);
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

		broadcastPartyState(busIo, store, lobbyId);

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
			busIo.to(room(lobbyId)).emit("game:starting", { message: "✨ The Dungeon Master is preparing your tale..." });
			const initiativeRolls = store.startGame(lobbyId);
			sendState(lobbyId);
			broadcastLobbies();
			broadcastPartyState(busIo, store, lobbyId);

			// Show the party how the order was decided. Turn order used to be socket
			// registration order, which players had no way to understand or predict.
			if (initiativeRolls.length) {
				const summary = initiativeRolls
					.map((r, i) => `${i + 1}. ${r.name} — ${r.roll}${r.dexMod >= 0 ? "+" : ""}${r.dexMod} = ${r.total}`)
					.join("<br>");
				busIo.to(room(lobbyId)).emit("narration", { content: `<p><strong>⚔️ Initiative</strong><br>${summary}</p>` });
				const { current, order, round } = store.turnInfo(lobbyId);
				busIo.to(room(lobbyId)).emit("turn:update", { current, order, round });
				log(`🎲 Initiative for ${lobbyId}: ${initiativeRolls.map((r) => `${r.name}=${r.total}`).join(", ")}`);
			}

			await new Promise((r) => setTimeout(r, 200));

			const setupPrompt = store.composeSetupPrompt(lobbyId);
			const namePrompt = `You are naming a Dungeons & Dragons adventure. Based on the party composition below, generate a short, dramatic adventure title of 3–5 words. Reply with ONLY the title — no quotes, no punctuation except hyphens, no extra text.\n\nParty:\n${store.playersSummary(lobbyId)}`;

			const [openingRaw, adventureNameRaw] = await Promise.all([
				getLLMResponse([{ role: "system", content: setupPrompt }], llmOpts(lobbyId)),
				getLLMResponse([{ role: "system", content: namePrompt }], llmOpts(lobbyId)),
			]);

			log(`🔍 [DEBUG] Raw setup LLM response:\n${openingRaw}`);

			// A dead provider must not become the story. The adapters return an error
			// string rather than throwing, so without this check the failure was
			// published as the opening narration, stored as the adventure's name,
			// written to the durable history, and the turn clock started on top of it.
			if (isLLMFailure(openingRaw)) {
				log(`💥 Opening narration failed for lobby ${lobbyId} — refusing to publish the error as story`);
				incidents.raise(lobbyId, {
					kind: "llm_failure",
					severity: SEVERITY.ERROR,
					message: "The Dungeon Master could not be reached, so the adventure has not started.",
					detail: { phase: "opening", provider: store.index[lobbyId]?.llmProvider ?? null, model: store.index[lobbyId]?.llmModel ?? null },
					suggestedFix: "Check the lobby's AI provider and API key, then start the game again.",
				});
				busIo.to(room(lobbyId)).emit("toast", {
					type: "error",
					message: "The Dungeon Master is not responding. The game has not started — ask your host to check the AI settings.",
				});
				store.setPhase(lobbyId, "waiting");
				busIo.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
				busIo.to(room(lobbyId)).emit("ui:unlock");
				return;
			}

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
			// Admins only — see the note on the `debug:llm` emit below.
			busIo.to(adminRoom(lobbyId)).emit("debug:setup", { raw: openingRaw, parsedMusic: setupMusic, parsedSuggestions: setupSuggestions });

			const adventureName = typeof adventureNameRaw === "string" ? adventureNameRaw.trim().replace(/^["']|["']$/g, "") : "Untitled Adventure";
			store.setAdventureName(lobbyId, adventureName);
			busIo.to(room(lobbyId)).emit("adventure:name", { name: adventureName });

			// Store raw JSON in history so the LLM sees JSON format in prior turns
			store.appendDM(lobbyId, typeof openingRaw === "string" ? openingRaw.trim() : cleanText);
			busIo.to(room(lobbyId)).emit("narration", { content: cleanText });

			const openingMood = setupMusic || "exploration";
			store.setCurrentMusic(lobbyId, openingMood);
			busIo.to(room(lobbyId)).emit("music:change", { mood: openingMood });
			if (setupSuggestions.length) busIo.to(room(lobbyId)).emit("suggestions:update", { suggestions: setupSuggestions });

			if (setupSfx.length) {
				resolveSfx(setupSfx, ELEVEN_API_KEY).then(sfxFiles => {
					if (sfxFiles.length) busIo.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
				}).catch(err => log("⚠️ SFX resolve error:", err.message));
			}

			await streamNarrationToClients(busIo, lobbyId, cleanText, store.getNarratorVoice(lobbyId), undefined, ttsDeps);

			busIo.to(room(lobbyId)).emit("game:ready");
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
				updateMap(busIo, store, lobbyId, initialChars, { type: "plains", features: [] });
			} catch (err) {
				console.error("💥 Failed to generate initial map:", err);
			}
		} catch (err) {
			log("💥 Error starting game:", err);
			console.error(err);
			try { store.setPhase(lobbyId, "waiting"); } catch (_) {}
			busIo.to(room(lobbyId)).emit("game:failed", { message: "The Dungeon Master ran into a problem. Please try again." });
			busIo.to(room(lobbyId)).emit("toast", { type: "error", message: `Failed to start game: ${err.message || "unknown error"}` });
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
			busIo.to(room(lobbyId)).emit("ui:lock", { actor: actor.name });

			const v = store.validateAction(lobbyId, socket.id, text);
			if (!v.ok) {
				console.log("⚠️ Action rejected:", v.reason);
				socket.emit("action:rejected", { reason: v.reason });
				busIo.to(room(lobbyId)).emit("ui:unlock");
				// The turn clock was cancelled above; put back what was left of it, or
				// this player's turn simply never ends.
				resumeTurnTimer(lobbyId);
				return;
			}

			// Can this character actually attempt this? The gate owns the whole
			// consequence chain — telling the player, spending one of their three
			// chances, restoring the clock, forfeiting the turn on the third failure.
			const gate = await actionGate.check({ lobbyId, socket, playerName: actor.name, text });
			if (!gate.allow) {
				busIo.to(room(lobbyId)).emit("ui:unlock");
				return;
			}

			store.appendUser(lobbyId, actor.name, text);
			const rollPayload = store.autoRollIfNeeded(lobbyId, socket.id, text);
			if (rollPayload) busIo.to(room(lobbyId)).emit("dice:result", rollPayload);

			const msgs = store.composeMessages(lobbyId, actor.name, text, rollPayload);
			console.log(`🎭 Action from ${actor.name}: "${text}"`);

			// Player voice narration. A character sheet's voice_id is an ElevenLabs id,
			// so it is only meaningful when ElevenLabs is the active engine — handing it
			// to the local server would be rejected as a voice it has not built. On any
			// other engine the player speaks in the lobby's narrator voice.
			const playerVoice = store.getTTSProvider(lobbyId) === "elevenlabs"
				? (actor?.sheet?.voice_id || PLAYER_FALLBACK_VOICE_ID)
				: null;
			await streamNarrationToClients(busIo, lobbyId, text, playerVoice, actor.name, ttsDeps);

			// LLM DM response
			const _timerLabel = `LLM_response_time_${lobbyId}_${Date.now()}`;
			console.time(_timerLabel);
			const rawReply = await Promise.race([getLLMResponse(msgs, llmOpts(lobbyId)), new Promise((_, rej) => setTimeout(() => rej(new Error(`LLM timeout after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS))]);
			console.timeEnd(_timerLabel);

			const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
			console.log(`📝 [LLM raw response] lobby=${lobbyId}:\n${replyText.slice(0, 2000)}${replyText.length > 2000 ? "…(truncated)" : ""}`);

			// Covers both an empty reply and the error strings the adapters return in
			// place of throwing. Publishing one of those as narration put an error
			// message into the players' story log and the DM's own context, where it
			// then influenced every later turn.
			if (isLLMFailure(replyText)) {
				console.warn("⚠️ DM reply unusable — not publishing it as narration");
				incidents.raise(lobbyId, {
					kind: "llm_failure",
					severity: SEVERITY.ERROR,
					message: `The Dungeon Master did not answer ${actor.name}'s turn. Nothing was narrated and the turn was not consumed.`,
					detail: { phase: "turn", player: actor.name, provider: store.index[lobbyId]?.llmProvider ?? null },
					suggestedFix: "If this repeats, check the lobby's AI provider and API key.",
				});
				busIo.to(room(lobbyId)).emit("toast", { type: "error", message: "The Dungeon Master did not respond. Try your action again." });
				busIo.to(room(lobbyId)).emit("ui:unlock");
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
				broadcastXPUpdates(busIo, store, lobbyId, u.xp);
				broadcastHPUpdates(busIo, store, lobbyId, u.hp);
				await checkAndEndIfAllDead(lobbyId);

				if (store.index[lobbyId]?.phase === "wiped") {
					busIo.to(room(lobbyId)).emit("ui:unlock");
					return;
				}

				broadcastInventoryUpdates(busIo, store, lobbyId, u.inventory);
				broadcastGoldUpdates(busIo, store, lobbyId, u.gold);
				broadcastConditionUpdates(busIo, store, lobbyId, u.conditions);
				broadcastAbilityUpdates(busIo, store, lobbyId, u.abilities);
				if (Array.isArray(u.enemies)) {
					// XP for kills is awarded here rather than left to the narrator. Asked
					// to volunteer an `updates.xp` block, the model went a full 30-turn
					// playtest without ever doing so — including for a confirmed kill —
					// leaving every character at zero XP and the whole progression system
					// unreachable. The enemy blocks carry a challenge rating; read it.
					const killed = store.updateEnemies(lobbyId, u.enemies);
					const living = Object.values(store.index[lobbyId]?.players || {})
						.filter((p) => !p.dead)
						.map((p) => p.name);
					const earned = xpForKills(killed, living);
					if (earned.length) broadcastXPUpdates(busIo, store, lobbyId, earned);
				}
				if (dmObj.combat_over) store.purgeDeadEnemies(lobbyId);

				if (dmObj.spellUsed === true) {
					const player = store.index[lobbyId]?.players?.[actor.name];
					if (player) {
						// The host-configured pool, not player.level. These disagreed: a level-1
						// character with a base of 3 was shown "3 uses left" but could spend only
						// one, because this clamp had not been told the base was configurable.
						const maxSlots = slotCapacity(player, store.index[lobbyId]?.abilitySlotsBase);
						if ((player.spellSlotsUsed || 0) < maxSlots) {
							player.spellSlotsUsed = (player.spellSlotsUsed || 0) + 1;
							store.persist(lobbyId);
							log(`🔮 Ability use spent by ${actor.name} (${player.spellSlotsUsed}/${Number.isFinite(maxSlots) ? maxSlots : "∞"})`);
						}
					}
				}

				broadcastPartyState(busIo, store, lobbyId);
				updateMap(busIo, store, lobbyId, dmObj.characters || [], dmObj.terrain || null);
				busIo.to(room(lobbyId)).emit("suggestions:update", {
					suggestions: Array.isArray(dmObj.suggestions) ? dmObj.suggestions : [],
				});
				if (dmObj.music) {
					store.setCurrentMusic(lobbyId, dmObj.music);
					busIo.to(room(lobbyId)).emit("music:change", { mood: dmObj.music });
				}
				if (Array.isArray(dmObj.sfx) && dmObj.sfx.length) {
					resolveSfx(dmObj.sfx, ELEVEN_API_KEY).then(sfxFiles => {
						if (sfxFiles.length) busIo.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
					}).catch(err => log("⚠️ SFX resolve error:", err.message));
				}
			} else {
				console.warn("⚠️ LLM reply not structured or parse failed");
				console.log("Raw reply text:", replyText);
				// Clear stale suggestions when parse fails
				busIo.to(room(lobbyId)).emit("suggestions:update", { suggestions: [] });
			}

			// Store the full raw LLM reply in history so future calls see their
			// own JSON-formatted responses and maintain the expected format.
			store.appendDM(lobbyId, replyText);
			// Admins only. This frame carries the DM's raw JSON — hidden DCs, full enemy
			// stat blocks, and every mechanical update — and it was being broadcast to
			// every player, where anyone with devtools open could read the numbers they
			// are supposed to be rolling against.
			busIo.to(adminRoom(lobbyId)).emit("debug:llm", { raw: replyText, parsed: dmObj ?? null, narrationText });
			busIo.to(room(lobbyId)).emit("narration", { content: narrationText });
			await streamNarrationToClients(busIo, lobbyId, narrationText, store.getNarratorVoice(lobbyId), undefined, ttsDeps);

			if (dmObj?.roll?.sides) {
				busIo.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
				busIo.to(room(lobbyId)).emit("ui:unlock");
				busIo.to(room(lobbyId)).emit("roll:required", {
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
				resolveActiveTurn(lobbyId);
				busIo.to(room(lobbyId)).emit("turn:update", store.turnInfo(lobbyId));
				scheduleTimerAfterNarration(lobbyId);
			}

			busIo.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
			busIo.to(room(lobbyId)).emit("ui:unlock");

			if (store.needsSummarization(lobbyId, HISTORY_SUMMARIZE_THRESHOLD)) {
				store.autoSummarize(lobbyId, getLLMResponse, llmOpts(lobbyId), 10, MAX_SUMMARY_LENGTH).catch(() => {});
			}
		} catch (err) {
			console.error("💥 Error processing action:", err);
			socket.emit("toast", { type: "error", message: "The DM stumbled on that one. Try again." });
			busIo.to(room(lobbyId)).emit("ui:unlock");
		}
	});

	// === DICE ROLL ===
	socket.on("dice:roll", ({ lobbyId, kind, value }) => {
		try {
			const actor = store.playerBySid(lobbyId, socket.id);
			if (!actor) return;
			const text = `${actor.name} rolls a ${kind} and gets ${value}!`;
			busIo.to(room(lobbyId)).emit("action:log", { player: actor.name, text, timestamp: Date.now() });
			store.appendUser(lobbyId, actor.name, text);
			const messages = store.composeMessages(lobbyId, actor.name, text);
			getLLMResponse(messages, llmOpts(lobbyId)).then(async (dm) => {
				const replyText = typeof dm === "string" ? dm.trim() : "";
				const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
				const narrationText = (dmObj && typeof dmObj === "object") ? (dmObj.text || dmObj.prompt || replyText) : replyText;
				store.appendDM(lobbyId, replyText);
				busIo.to(room(lobbyId)).emit("narration", { content: narrationText });
				streamNarrationToClients(busIo, lobbyId, narrationText, store.getNarratorVoice(lobbyId), undefined, ttsDeps);
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
		busIo.to(room(lobbyId)).emit("game:over", { reason: "completed" });
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
			busIo.to(room(lobbyId)).emit("narration", { content: `[Summary]\n${s}` });
			sendState(lobbyId);
		} catch (err) {
			log("💥 Error summarizing:", err);
		}
	});

	// ==== Chat with DM (out-of-game Q&A) ====
	// This may come from a separate popup window with its own socket,
	// so we identify the player by name+lobbyId rather than socket ID.
	// "What can I do?" — private, per-character tactical help for new players.
	socket.on("advisor:ask", (payload) => advisor.handle(socket, payload));

	socket.on("dm:chat", async ({ lobbyId, playerName, question }) => {
		try {
			const s = store.index[lobbyId];
			if (!s || !playerName || !question || typeof question !== "string") return;
			// Verify the player actually exists in this lobby
			if (!s.players[playerName]) return;

			const trimmed = question.trim().slice(0, 500);
			if (!trimmed) return;

			log(`💬 [DM Chat] ${playerName}: "${trimmed}"`);

			const msgs = store.composeDMChat(lobbyId, playerName, trimmed);
			const reply = await getLLMResponse(msgs, llmOpts(lobbyId));
			const answer = typeof reply === "string" ? reply.trim() : "The DM is lost in thought...";

			socket.emit("dm:chat:reply", { question: trimmed, answer });
		} catch (err) {
			log("💥 DM Chat error:", err.message);
			socket.emit("dm:chat:reply", { question: question || "", answer: "The DM seems distracted... (an error occurred)" });
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
					busIo.to(room(lobbyId)).emit("toast", { type: "error", message: "The host has left. This lobby has been closed." });
					busIo.to(room(lobbyId)).emit("lobby:closed");
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
					// A dropped connection no longer means the player is gone. The session
					// keeps their seat and their place in the turn order through a grace
					// window; only if they fail to come back does the sweeper release them
					// and announce that they left. Previously a two-second blip ejected
					// them from initiative and told the party they had gone, before the
					// player had even noticed anything was wrong.
					sessionSystem.handleDisconnecting(socket);

					const timerEntry = activeTimers.get(lobbyId);
					if (timerEntry?.playerName === playerName) cancelTurnTimer(lobbyId);

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
				broadcastPartyState(busIo, store, lobbyId);
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
		// Narration is available if any engine is, not just ElevenLabs. The settings
		// window gates its voice controls on this.
		tts:        { ...ttsAvailability, any: Object.values(ttsAvailability).some(Boolean) },
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

/**
 * Probes every TTS engine and records which can narrate.
 *
 * @description Also learns the local server's own default voice, so a lobby that
 *   has chosen no voice still gets a valid one rather than whatever the server
 *   does with a null. Dev mode skips the network entirely but reports engines as
 *   present, because the settings window should still be explorable.
 * @returns {Promise<void>} Resolves once `ttsAvailability` reflects reality.
 */
async function probeTTS() {
	if (devMode) {
		ttsAvailability.local = true;
		ttsAvailability.elevenlabs = Boolean(ELEVEN_API_KEY);
		log("  ⏭️  TTS: probing skipped (dev mode)");
		return;
	}

	Object.assign(ttsAvailability, await probeAvailability({ depsFor: providerDepsFor }));

	if (ttsAvailability.local) {
		try {
			const voices = await resolveTTSProvider("local").listVoices(providerDepsFor("local"));
			ttsDefaultVoice.local = (voices.find((v) => v.isDefault) || voices[0])?.id || null;
			log(`  ✅ Local TTS server is ready at ${localTts.url} (${voices.length} voices, default "${ttsDefaultVoice.local}")`);
		} catch (err) {
			log(`  ⚠️  Local TTS server answered /health but not /voices: ${err.message}`);
		}
	} else {
		log(`  ❌ Local TTS: not reachable at ${localTts.url} — set its address in the game's settings window`);
	}

	if (!ELEVEN_API_KEY) log("  ❌ ElevenLabs: No API key configured");
	else if (ttsAvailability.elevenlabs) log("  ✅ ElevenLabs API key is valid");
	else log("  ❌ ElevenLabs: key rejected or no voices returned");

	// serviceStatus is what /api/features and the admin panel have always read.
	serviceStatus.elevenlabs = ttsAvailability.elevenlabs;
}

async function validateServices() {
	log("🔑 Validating API keys...");
	const llm = await validateLLMKeys();
	serviceStatus.openai = llm.openai.ok;
	serviceStatus.claude = llm.claude.ok;
	if (llm.openai.ok)  log("  ✅ OpenAI API key is valid");
	else                 log(`  ❌ OpenAI: ${llm.openai.error}`);
	if (llm.claude.ok)  log("  ✅ Claude API key is valid");
	else                 log(`  ❌ Claude: ${llm.claude.error}`);
	await probeTTS();

	const active = [
		serviceStatus.openai && "OpenAI",
		serviceStatus.claude && "Claude",
		ttsAvailability.local && "Local TTS",
		ttsAvailability.elevenlabs && "ElevenLabs",
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
