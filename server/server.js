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
import { roll } from "./services/dice.js";
import fetch from "node-fetch";
import { PassThrough } from "stream";
import { randomUUID, randomBytes, generateKeyPairSync, createSign, createVerify, createPublicKey, createHash, createHmac } from "crypto";
import { execSync } from "child_process";
import { broadcastXPUpdates, broadcastHPUpdates, broadcastInventoryUpdates, broadcastGoldUpdates, broadcastConditionUpdates, broadcastPartyState } from "./services/gameUpdates.js";
import { updateMap, registerMapEndpoints, getDefaultPlayerEmoji } from "./services/mapService.js";
import { getAbilityForLevel } from "./services/classProgression.js";
import { resolveSfx, findMatch as findSfxMatch } from "./services/sfxService.js";
import { pipeline } from "stream/promises";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

// === ADMIN AUTH ===
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD not set in .env — admin panel will be inaccessible.");

// Pending nonces (challenge-response): Map<nonce, expiresAt>
const adminNonces = new Map();
// Active sessions: Map<token, expiresAt>
const adminSessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const NONCE_TTL = 60 * 1000;             // 60 seconds

// Host-as-admin tokens: Map<token, { lobbyCode, expiresAt }>
const hostAdminTokens = new Map();
const HOST_TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours
// Track which sockets are authorized as host-admin: Map<socketId, lobbyCode>
const hostAdminSockets = new Map();

function cleanExpired(map) {
	const now = Date.now();
	for (const [k, v] of map) {
		const exp = typeof v === "number" ? v : v?.expiresAt;
		if (exp < now) map.delete(k);
	}
}

function isAdminAuthenticated(req) {
	// Check cookie first, then Authorization header
	const token =
		parseCookie(req.headers.cookie || "").admin_token ||
		(req.headers.authorization || "").replace("Bearer ", "");
	if (!token) return false;
	cleanExpired(adminSessions);
	return adminSessions.has(token);
}

function parseCookie(cookieStr) {
	const obj = {};
	cookieStr.split(";").forEach(pair => {
		const [k, ...v] = pair.trim().split("=");
		if (k) obj[k.trim()] = decodeURIComponent(v.join("="));
	});
	return obj;
}

// === ASSET DOWNLOAD CONFIG ===
import readline from "readline";
const MUSIC_ZIP_URL      = "https://github.com/Kenji776/StoryTeller/releases/download/resource/music.zip";
const SFX_ZIP_URL        = "https://github.com/Kenji776/StoryTeller/releases/download/sfx/sfx.zip";
const MENU_MUSIC_ZIP_URL = "https://github.com/Kenji776/StoryTeller/releases/download/menu-music/menu-music.zip";
const UI_SFX_ZIP_URL     = "https://github.com/Kenji776/StoryTeller/releases/download/ui-sfx/ui-sfx.zip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// === ADMIN AUTH ENDPOINTS (before static middleware) ===

// Request a challenge nonce
app.get("/api/admin/challenge", (req, res) => {
	if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Admin login not configured" });
	cleanExpired(adminNonces);
	const nonce = randomBytes(32).toString("hex");
	adminNonces.set(nonce, Date.now() + NONCE_TTL);
	res.json({ nonce });
});

// Submit hashed response: SHA-256(password + nonce)
app.post("/api/admin/login", (req, res) => {
	if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Admin login not configured" });
	const { nonce, hash } = req.body;
	if (!nonce || !hash) return res.status(400).json({ error: "Missing nonce or hash" });

	cleanExpired(adminNonces);
	if (!adminNonces.has(nonce)) return res.status(401).json({ error: "Invalid or expired challenge" });
	adminNonces.delete(nonce);

	// Server computes expected hash the same way the client does
	const expected = createHash("sha256").update(ADMIN_PASSWORD + nonce).digest("hex");
	if (hash !== expected) return res.status(401).json({ error: "Incorrect password" });

	// Issue session token
	const token = randomBytes(32).toString("hex");
	adminSessions.set(token, Date.now() + SESSION_TTL);
	res.setHeader("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
	res.json({ ok: true });
});

// Check if current session is valid — also return authType so the client
// can gate features (e.g. char-file tool is admin-only, not host).
app.get("/api/admin/session", (req, res) => {
	if (isAdminAuthenticated(req)) return res.json({ authenticated: true, authType: "admin" });
	if (isHostToken(req))          return res.json({ authenticated: true, authType: "host" });
	res.json({ authenticated: false });
});

// Logout
app.post("/api/admin/logout", (req, res) => {
	const token = parseCookie(req.headers.cookie || "").admin_token;
	if (token) adminSessions.delete(token);
	res.setHeader("Set-Cookie", "admin_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
	res.json({ ok: true });
});

// === HOST-AS-ADMIN: verify character file and issue token ===
app.post("/api/admin/host-verify", (req, res) => {
	const { lobbyCode, data, sig } = req.body;
	if (!lobbyCode || !data || !sig) return res.status(400).json({ error: "Missing fields" });

	// Verify the character file signature
	const verifier = createVerify("SHA256");
	verifier.update(data);
	verifier.end();
	if (!verifier.verify(charPublicKey, sig, "base64")) {
		return res.status(401).json({ error: "Invalid character file signature" });
	}

	// Parse character data and extract characterId
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
	} catch { return res.status(400).json({ error: "Malformed character data" }); }

	const charId = parsed.sheet?.characterId;
	if (!charId) return res.status(400).json({ error: "Character file has no characterId" });

	// Find the lobby and check hostCharacterId
	const lobbyId = store.findLobbyByCode(lobbyCode);
	if (!lobbyId) return res.status(404).json({ error: "Lobby not found" });

	const lobby = store.index[lobbyId];
	if (!lobby.hostCharacterId) return res.status(403).json({ error: "Lobby has no host character on record" });
	if (lobby.hostCharacterId !== charId) return res.status(403).json({ error: "Character file does not match the game host" });

	// Issue a host admin token scoped to this lobby
	cleanExpired(hostAdminTokens);
	const token = randomBytes(32).toString("hex");
	hostAdminTokens.set(token, { lobbyCode, expiresAt: Date.now() + HOST_TOKEN_TTL });
	res.setHeader("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${HOST_TOKEN_TTL / 1000}`);
	res.json({ ok: true, lobbyCode });
});

function isHostToken(req) {
	const token =
		parseCookie(req.headers.cookie || "").admin_token ||
		(req.headers.authorization || "").replace("Bearer ", "");
	if (!token) return null;
	cleanExpired(hostAdminTokens);
	const entry = hostAdminTokens.get(token);
	return entry ? entry.lobbyCode : null;
}

// Redirect old /admin.html to new location
app.get("/admin.html", (req, res) => res.redirect("/admin/login.html"));

// === PROTECT /admin/ — gate all files except login.html and login.js ===
app.use("/admin", (req, res, next) => {
	// Root → login page
	if (req.path === "/") return res.redirect("/admin/login.html");
	// Allow the login page and its JS without auth
	const allowed = ["/login.html", "/login.js"];
	if (allowed.includes(req.path)) return next();
	// Everything else requires admin password auth OR a valid host token
	if (!isAdminAuthenticated(req) && !isHostToken(req)) {
		// If requesting HTML, redirect to login
		if (req.headers.accept?.includes("text/html")) {
			return res.redirect("/admin/login.html");
		}
		return res.status(401).json({ error: "Unauthorized" });
	}
	next();
});

// Serve admin subfolder as static
app.use("/admin", express.static(path.join(__dirname, "..", "client", "admin")));

// Serve main client (admin files are no longer here)
app.use(express.static(path.join(__dirname, "..", "client")));

// List available menu music files
const MENU_MUSIC_DIR = path.join(__dirname, "..", "client", "music", "menu");
app.get("/api/menu-music", (req, res) => {
	try {
		if (!fs.existsSync(MENU_MUSIC_DIR)) return res.json([]);
		const files = fs.readdirSync(MENU_MUSIC_DIR).filter(f => f.endsWith(".mp3"));
		res.json(files);
	} catch {
		res.json([]);
	}
});

const IMAGES_DIR = path.join(__dirname, "data", "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
app.use("/character-images", express.static(IMAGES_DIR));

// === CHARACTER SIGNING KEYS ===
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

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const store = new LobbyStore();

// === Add after dotenv.config(); ===
const args = process.argv.slice(2);
const devMode = args.includes("--devmode") || process.env.DEV_MODE?.toUpperCase() === "TRUE";
if (devMode) {
	log("🧩 Developer mode enabled — skipping ElevenLabs TTS.");
}

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "dAcds2QMcvmv86jQMC3Y";
const REJECTED_REQUEST_STATUS = 204; //this is the http status code that is sent if the server gets a request but decides to skip it, usually due to being in devmode
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60000;
const HISTORY_SUMMARIZE_THRESHOLD = Number(process.env.HISTORY_SUMMARIZE_THRESHOLD) || 2;
const MAX_SUMMARY_LENGTH = Number(process.env.MAX_SUMMARY_LENGTH) || 60000;
const VOICE_CACHE_FILE = path.join(__dirname, "..", "client", "config", "voices_cache.json");

let ELEVEN_VOICES = [];


function log(...args) {
	const stamp = new Date()
		.toISOString()
		.split("T")[1]
		.split(".")[0];
	console.log(`[${stamp}]`, ...args);
}
const room = (lobbyId) => lobbyId;

// === MUSIC ASSET DOWNLOAD ===
const MUSIC_DIR = path.join(__dirname, "..", "client", "music");

async function ensureMusic() {
	const GAME_MUSIC_DIR = path.join(MUSIC_DIR, "game");
	const hasMp3s = fs.existsSync(GAME_MUSIC_DIR) && fs.readdirSync(GAME_MUSIC_DIR).some(f => f.endsWith(".mp3"));
	if (hasMp3s) return; // game music already present

	if (!fs.existsSync(GAME_MUSIC_DIR)) fs.mkdirSync(GAME_MUSIC_DIR, { recursive: true });

	// In non-interactive environments (Docker, etc.), auto-download without prompting
	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise(resolve => {
			rl.question("🎵 No music files found. Download the standard music library? (y/n): ", resolve);
		});
		rl.close();

		if (answer.trim().toLowerCase() !== "y") {
			log("⏭️  Skipping music download. The game will run without background music.");
			log(`   You can manually place MP3 files in: ${path.join(MUSIC_DIR, "game")}`);
			return;
		}
	} else {
		log("🎵 No music files found. Non-interactive environment detected — downloading automatically...");
	}

	const zipPath = path.join(MUSIC_DIR, "music.zip");

	log("🎵 Downloading music pack...");
	log(`   ${MUSIC_ZIP_URL}`);

	try {
		const res = await fetch(MUSIC_ZIP_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		await pipeline(res.body, fs.createWriteStream(zipPath));
		log("🎵 Download complete. Extracting...");

		execSync(`unzip -o "${zipPath}" -d "${GAME_MUSIC_DIR}"`);
		fs.unlinkSync(zipPath);

		const count = fs.readdirSync(GAME_MUSIC_DIR, { recursive: true }).filter(f => String(f).endsWith(".mp3")).length;
		log(`🎵 Music ready — ${count} tracks extracted to game music folder.`);
	} catch (err) {
		log(`❌ Music download failed: ${err.message}`);
		log(`   You can manually download music.zip from:`);
		log(`   ${MUSIC_ZIP_URL}`);
		log(`   and extract the MP3 files into: ${GAME_MUSIC_DIR}`);
		if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
	}
}

// === SFX ASSET DOWNLOAD ===
const SFX_DIR = path.join(__dirname, "..", "client", "sfx");

async function ensureSfx() {
	const GAME_SFX_DIR = path.join(SFX_DIR, "game");
	const hasSfx = fs.existsSync(GAME_SFX_DIR) && fs.readdirSync(GAME_SFX_DIR).some(f => f.endsWith(".mp3"));
	if (hasSfx) return; // game sfx already present

	if (!fs.existsSync(GAME_SFX_DIR)) fs.mkdirSync(GAME_SFX_DIR, { recursive: true });

	// In non-interactive environments (Docker, etc.), auto-download without prompting
	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise(resolve => {
			rl.question("🔊 No sound effects found. Download the standard SFX library? (y/n): ", resolve);
		});
		rl.close();

		if (answer.trim().toLowerCase() !== "y") {
			log("⏭️  Skipping SFX download. The game will run without sound effects.");
			log(`   You can manually place MP3 files in: ${path.join(SFX_DIR, "game")}`);
			return;
		}
	} else {
		log("🔊 No sound effects found. Non-interactive environment detected — downloading automatically...");
	}

	const zipPath = path.join(SFX_DIR, "sfx.zip");

	log("🔊 Downloading SFX pack...");
	log(`   ${SFX_ZIP_URL}`);

	try {
		const res = await fetch(SFX_ZIP_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		await pipeline(res.body, fs.createWriteStream(zipPath));
		log("🔊 Download complete. Extracting...");

		execSync(`unzip -o "${zipPath}" -d "${GAME_SFX_DIR}"`);
		fs.unlinkSync(zipPath);

		const count = fs.readdirSync(GAME_SFX_DIR, { recursive: true }).filter(f => String(f).endsWith(".mp3")).length;
		log(`🔊 SFX ready — ${count} effects extracted to game SFX folder.`);
	} catch (err) {
		log(`❌ SFX download failed: ${err.message}`);
		log(`   You can manually download sfx.zip from:`);
		log(`   ${SFX_ZIP_URL}`);
		log(`   and extract the MP3 files into: ${GAME_SFX_DIR}`);
		if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
	}
}

// === MENU MUSIC ASSET DOWNLOAD ===
async function ensureMenuMusic() {
	const menuDir = path.join(MUSIC_DIR, "menu");
	const hasMp3s = fs.existsSync(menuDir) && fs.readdirSync(menuDir).some(f => f.endsWith(".mp3"));
	if (hasMp3s) return;

	if (!fs.existsSync(menuDir)) fs.mkdirSync(menuDir, { recursive: true });

	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise(resolve => {
			rl.question("🎶 No menu music found. Download the menu music library? (y/n): ", resolve);
		});
		rl.close();

		if (answer.trim().toLowerCase() !== "y") {
			log("⏭️  Skipping menu music download.");
			log(`   You can manually place MP3 files in: ${menuDir}`);
			return;
		}
	} else {
		log("🎶 No menu music found. Non-interactive environment detected — downloading automatically...");
	}

	const zipPath = path.join(MUSIC_DIR, "menu-music.zip");

	log("🎶 Downloading menu music pack...");
	log(`   ${MENU_MUSIC_ZIP_URL}`);

	try {
		const res = await fetch(MENU_MUSIC_ZIP_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		await pipeline(res.body, fs.createWriteStream(zipPath));
		log("🎶 Download complete. Extracting...");

		execSync(`unzip -o "${zipPath}" -d "${menuDir}"`);
		fs.unlinkSync(zipPath);

		const count = fs.readdirSync(menuDir).filter(f => f.endsWith(".mp3")).length;
		log(`🎶 Menu music ready — ${count} tracks extracted.`);
	} catch (err) {
		log(`❌ Menu music download failed: ${err.message}`);
		log(`   You can manually download menu-music.zip from:`);
		log(`   ${MENU_MUSIC_ZIP_URL}`);
		log(`   and extract the MP3 files into: ${menuDir}`);
		if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
	}
}

// === UI SFX ASSET DOWNLOAD ===
async function ensureUiSfx() {
	const uiDir = path.join(SFX_DIR, "ui");
	const hasMp3s = fs.existsSync(uiDir) && fs.readdirSync(uiDir).some(f => f.endsWith(".mp3"));
	if (hasMp3s) return;

	if (!fs.existsSync(uiDir)) fs.mkdirSync(uiDir, { recursive: true });

	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise(resolve => {
			rl.question("🔔 No UI sound effects found. Download the UI SFX library? (y/n): ", resolve);
		});
		rl.close();

		if (answer.trim().toLowerCase() !== "y") {
			log("⏭️  Skipping UI SFX download.");
			log(`   You can manually place MP3 files in: ${uiDir}`);
			return;
		}
	} else {
		log("🔔 No UI sound effects found. Non-interactive environment detected — downloading automatically...");
	}

	const zipPath = path.join(SFX_DIR, "ui-sfx.zip");

	log("🔔 Downloading UI SFX pack...");
	log(`   ${UI_SFX_ZIP_URL}`);

	try {
		const res = await fetch(UI_SFX_ZIP_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		await pipeline(res.body, fs.createWriteStream(zipPath));
		log("🔔 Download complete. Extracting...");

		execSync(`unzip -o "${zipPath}" -d "${uiDir}"`);
		fs.unlinkSync(zipPath);

		const count = fs.readdirSync(uiDir).filter(f => f.endsWith(".mp3")).length;
		log(`🔔 UI SFX ready — ${count} effects extracted.`);
	} catch (err) {
		log(`❌ UI SFX download failed: ${err.message}`);
		log(`   You can manually download ui-sfx.zip from:`);
		log(`   ${UI_SFX_ZIP_URL}`);
		log(`   and extract the MP3 files into: ${uiDir}`);
		if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
	}
}

// Shorthand: get the LLM provider+model for a specific lobby
const llmOpts = (lobbyId) => store.getLLMSettings(lobbyId);

// ── Turn Timers ──────────────────────────────────────────────────────────────
const activeTimers = new Map(); // lobbyId → { timeout, playerName }
const pendingTimerStarts = new Map(); // lobbyId → fallback timeout handle — waits for narration:done before starting turn timer

const hasTTS = () => !devMode && !!ELEVEN_API_KEY && serviceStatus.elevenlabs;
const READING_DELAY_MS = 60_000; // grace period when TTS is off

// === SERVICE STATUS (populated at startup) ===
const serviceStatus = { openai: false, claude: false, elevenlabs: false };

// Schedule the turn timer to start after narration finishes playing on the client.
// When TTS is active, waits for a "narration:done" signal from any client in the lobby
// (with a 3-minute safety fallback). When TTS is off, uses the standard reading delay.
function scheduleTimerAfterNarration(lobbyId) {
	if (!hasTTS()) {
		startTurnTimer(lobbyId, READING_DELAY_MS);
		return;
	}
	// Clear any previous pending start for this lobby
	if (pendingTimerStarts.has(lobbyId)) {
		clearTimeout(pendingTimerStarts.get(lobbyId));
	}
	// Safety fallback: start timer after 3 minutes even if narration:done never arrives
	const fallback = setTimeout(() => {
		if (pendingTimerStarts.has(lobbyId)) {
			pendingTimerStarts.delete(lobbyId);
			startTurnTimer(lobbyId, 0);
		}
	}, 3 * 60 * 1000);
	pendingTimerStarts.set(lobbyId, fallback);
}

// Returns true if the named player has at least one live socket in the lobby room.
function isPlayerConnected(lobbyId, playerName) {
	const s = store.index[lobbyId];
	if (!s) return false;
	return Object.entries(s.sockets).some(
		([sid, rec]) => rec.playerName === playerName && io.sockets.sockets.has(sid)
	);
}

// After any turn-order change, skip over players with no live connection.
// Returns the resolved { current, order } to use in the turn:update emission.
function resolveActiveTurn(lobbyId) {
	const s = store.index[lobbyId];
	if (!s || s.phase !== "running") return store.turnInfo(lobbyId);

	let { current, order } = store.turnInfo(lobbyId);
	let steps = 0;

	while (current && !isPlayerConnected(lobbyId, current) && steps < order.length) {
		log(`⚠️ ${current} has no active connection — removing from turn order`);
		io.to(room(lobbyId)).emit("toast", {
			type: "warning",
			message: `${current} is not in the game — skipping their turn.`,
		});
		store.removeFromTurnOrder(lobbyId, current);
		const info = store.turnInfo(lobbyId);
		current = info.current;
		order = info.order;
		steps++;
		if (!order.length) break;
	}

	return store.turnInfo(lobbyId);
}

async function checkAndEndIfAllDead(lobbyId) {
	if (!store.checkAllDead(lobbyId)) return;

	store.setPhase(lobbyId, "wiped");
	cancelTurnTimer(lobbyId);
	log(`💀 All players dead in lobby ${lobbyId} — generating TPK epilogue...`);

	// Show lock overlay while the LLM generates the epilogue
	io.to(room(lobbyId)).emit("ui:lock", { actor: "DM", message: "The DM is writing the final chapter..." });

	// Generate a dramatic epilogue via the LLM
	try {
		const msgs = store.composeWipeEpilogue(lobbyId);
		const rawReply = await Promise.race([
			getLLMResponse(msgs, llmOpts(lobbyId)),
			new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)),
		]);
		const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
		let epilogueHtml = "";
		let music = "sad_moment";
		let sfx = [];

		if (replyText) {
			try {
				const parsed = JSON.parse(replyText.replace(/^```json?\s*|```$/g, "").trim());
				epilogueHtml = parsed.text || replyText;
				if (parsed.music) music = parsed.music;
				if (Array.isArray(parsed.sfx)) sfx = parsed.sfx;
			} catch {
				epilogueHtml = replyText;
			}
		}

		if (epilogueHtml) {
			store.appendDM(lobbyId, epilogueHtml);
			io.to(room(lobbyId)).emit("narration", { content: epilogueHtml });
			if (music) io.to(room(lobbyId)).emit("music:change", { mood: music });
			if (sfx.length) {
				const { resolveSFXFiles } = await import("./services/sfxResolver.js");
				resolveSFXFiles(sfx).then(sfxFiles => {
					if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
				}).catch(() => {});
			}
			await streamNarrationToClients(io, room(lobbyId), epilogueHtml, store.getNarratorVoice(lobbyId));
		}
	} catch (err) {
		log(`⚠️ TPK epilogue generation failed: ${err.message}`);
		// Fall through to emit game:over even if epilogue fails
	}

	io.to(room(lobbyId)).emit("ui:unlock");
	io.to(room(lobbyId)).emit("game:over", { reason: "wiped" });
	broadcastLobbies();
}

function startTurnTimer(lobbyId, readingDelayMs = 0) {
	cancelTurnTimer(lobbyId);
	const s = store.index[lobbyId];
	if (!s || !s.timerEnabled || !s.timerMinutes || s.phase !== "running") return;

	const { current } = store.turnInfo(lobbyId);
	if (!current) return;

	if (readingDelayMs > 0) {
		log(`⏱ Timer pending for ${current} in lobby ${lobbyId} (${readingDelayMs / 1000}s reading delay)`);
		io.to(room(lobbyId)).emit("timer:pending", { player: current, readingDelayMs, ttsActive: hasTTS() });
		const delayTimeout = setTimeout(() => {
			activeTimers.delete(lobbyId);
			startTurnTimer(lobbyId, 0);
		}, readingDelayMs);
		activeTimers.set(lobbyId, { timeout: delayTimeout, playerName: current });
		return;
	}

	const durationMs = s.timerMinutes * 60 * 1000;
	const endsAt = Date.now() + durationMs;

	io.to(room(lobbyId)).emit("timer:start", { player: current, endsAt, durationMs });
	log(`⏱ Timer started for ${current} in lobby ${lobbyId} (${s.timerMinutes}m)`);

	const timeout = setTimeout(() => handleTimerExpiry(lobbyId, current), durationMs);
	activeTimers.set(lobbyId, { timeout, playerName: current });
}

function cancelTurnTimer(lobbyId) {
	const entry = activeTimers.get(lobbyId);
	if (!entry) return;
	clearTimeout(entry.timeout);
	activeTimers.delete(lobbyId);
	io.to(room(lobbyId)).emit("timer:cancel");
}

async function kickPlayerForInactivity(lobbyId, playerName) {
	const s = store.index[lobbyId];
	if (!s) return;

	log(`🚫 Kicking ${playerName} from lobby ${lobbyId} for inactivity`);

	const sid = store.sidByPlayerName(lobbyId, playerName);

	if (s.players[playerName]) s.players[playerName].disconnected = true;
	store.removeFromTurnOrder(lobbyId, playerName);

	// Remove from sockets before disconnecting so the disconnecting handler skips it
	if (sid) delete s.sockets[sid];
	store.persist(lobbyId);

	io.to(room(lobbyId)).emit("toast", { type: "error", message: `${playerName} was removed from the adventure due to inactivity.` });
	io.to(room(lobbyId)).emit("player:left", { player: playerName });
	const { current, order } = resolveActiveTurn(lobbyId);
	io.to(room(lobbyId)).emit("turn:update", { current, order });

	if (sid) {
		const sock = io.sockets.sockets.get(sid);
		if (sock) sock.disconnect(true);
	}

	sendState(lobbyId);
	broadcastPartyState(io, store, lobbyId);
	broadcastLobbies();
}

async function handleTimerExpiry(lobbyId, playerName) {
	activeTimers.delete(lobbyId);
	const s = store.index[lobbyId];
	if (!s || s.phase !== "running") return;

	// Guard: verify it's still their turn
	const { current } = store.turnInfo(lobbyId);
	if (current !== playerName) return;

	log(`⏰ Turn timeout for ${playerName} in lobby ${lobbyId}`);

	io.to(room(lobbyId)).emit("timer:cancel");
	io.to(room(lobbyId)).emit("toast", { type: "warning", message: `${playerName}'s turn was skipped due to timeout.` });

	// Track missed turns; kick if threshold reached
	const missed = store.incrementMissedTurns(lobbyId, playerName);
	if (missed >= (s.maxMissedTurns || 3)) {
		await kickPlayerForInactivity(lobbyId, playerName);
		startTurnTimer(lobbyId, hasTTS() ? 0 : READING_DELAY_MS);
		return;
	}

	const skipText = `${playerName} took no action and stared blankly into the distance`;
	store.appendUser(lobbyId, playerName, skipText);
	io.to(room(lobbyId)).emit("action:log", { player: playerName, text: skipText, timestamp: Date.now() });

	try {
		io.to(room(lobbyId)).emit("ui:lock", { actor: playerName });

		const msgs = store.composeMessages(lobbyId, playerName, skipText, null);
		const rawReply = await Promise.race([
			getLLMResponse(msgs, llmOpts(lobbyId)),
			new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)),
		]);

		const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
		if (replyText) {
			const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
			const narrationText = dmObj?.text || replyText;

			if (dmObj && typeof dmObj === "object") {
				const u = dmObj.updates || {};
				broadcastXPUpdates(io, store, lobbyId, u.xp);
				broadcastHPUpdates(io, store, lobbyId, u.hp);
				await checkAndEndIfAllDead(lobbyId);

				// If everyone is dead, the epilogue already played — bail out
				if (store.index[lobbyId]?.phase === "wiped") return;

				broadcastInventoryUpdates(io, store, lobbyId, u.inventory);
				broadcastGoldUpdates(io, store, lobbyId, u.gold);
				broadcastConditionUpdates(io, store, lobbyId, u.conditions);
				if (Array.isArray(u.enemies)) store.updateEnemies(lobbyId, u.enemies);
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
			}

			store.appendDM(lobbyId, narrationText);
			io.to(room(lobbyId)).emit("narration", { content: narrationText });
			await streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId));
		}
	} catch (err) {
		log(`⏰ Timer expiry LLM error: ${err.message}`);
	}

	// Don't advance turns or unlock if game already ended
	if (store.index[lobbyId]?.phase === "wiped") return;

	store.nextTurn(lobbyId);
	const { current: next, order } = resolveActiveTurn(lobbyId);
	io.to(room(lobbyId)).emit("turn:update", { current: next, order });
	io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
	io.to(room(lobbyId)).emit("ui:unlock");
	scheduleTimerAfterNarration(lobbyId);

	// Keep story summary current after timer-expiry turns too
	if (store.needsSummarization(lobbyId, HISTORY_SUMMARIZE_THRESHOLD)) {
		store.autoSummarize(lobbyId, getLLMResponse, llmOpts(lobbyId), 10, MAX_SUMMARY_LENGTH).catch(() => {});
	}
}

async function handleRestResolved(lobbyId, result, type, proposer) {
	// Clear the 120s timeout if it's still pending
	if (restVoteTimers.has(lobbyId)) {
		clearTimeout(restVoteTimers.get(lobbyId));
		restVoteTimers.delete(lobbyId);
	}
	store.clearRestVote(lobbyId);
	io.to(room(lobbyId)).emit("rest:vote:result", { passed: result === "passed", type });

	if (result !== "passed") {
		io.to(room(lobbyId)).emit("ui:unlock");
		io.to(room(lobbyId)).emit("toast", { type: "warning", message: "Rest vote failed — take a different action." });
		return;
	}

	// Apply mechanical effects immediately so party table updates right away
	store.applyRest(lobbyId, type);
	broadcastPartyState(io, store, lobbyId);

	// Lock UI while waiting for LLM narration
	io.to(room(lobbyId)).emit("ui:lock", { actor: proposer });

	// Ask the LLM to narrate the rest
	const restText = type === "long"
		? "[LONG REST] The party settles in for a full 8-hour long rest. All HP is restored and conditions are cleared. Narrate what happens — it may be peaceful, or something may occur during the night."
		: "[SHORT REST] The party takes a short rest of 1–2 hours, tending wounds and catching their breath. Narrate the brief respite.";

	try {
		store.appendUser(lobbyId, proposer, restText);
		const msgs = store.composeMessages(lobbyId, proposer, restText, null);
		const rawReply = await Promise.race([
			getLLMResponse(msgs, llmOpts(lobbyId)),
			new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)),
		]);
		const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
		if (replyText) {
			const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
			let narrationText = dmObj?.text || replyText;
			if (!dmObj) {
				try {
					const fallback = JSON.parse(replyText);
					narrationText = fallback?.content ?? fallback?.text ?? replyText;
					if (typeof narrationText !== "string") narrationText = replyText;
				} catch {}
			}
			if (dmObj && typeof dmObj === "object") {
				const u = dmObj.updates || {};
				broadcastXPUpdates(io, store, lobbyId, u.xp);
				broadcastInventoryUpdates(io, store, lobbyId, u.inventory);
				broadcastGoldUpdates(io, store, lobbyId, u.gold);
				broadcastConditionUpdates(io, store, lobbyId, u.conditions);
				if (Array.isArray(u.enemies)) store.updateEnemies(lobbyId, u.enemies);
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
			}
			store.appendDM(lobbyId, narrationText);
			io.to(room(lobbyId)).emit("narration", { content: narrationText });
			await streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId));
		}
	} catch (err) {
		log(`⚠️ Rest LLM error: ${err.message}`);
	}

	store.nextTurn(lobbyId);
	const { current, order } = resolveActiveTurn(lobbyId);
	io.to(room(lobbyId)).emit("turn:update", { current, order });
	io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
	io.to(room(lobbyId)).emit("ui:unlock");
	scheduleTimerAfterNarration(lobbyId);
}

function sendState(lobbyId) {
	const state = store.publicState(lobbyId);
	io.to(room(lobbyId)).emit("state:update", state);
	log(`📤 State sent for lobby ${lobbyId} (${state?.phase})`);
}



const restVoteTimers = new Map(); // lobbyId → timeoutId

io.on("connection", (socket) => {
	log(`🔌 Client connected: ${socket.id}`);

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

	// When someone joins
	socket.on("lobby:join", ({ code, password }) => {
		try {
			log(`🚪 Join request by ${socket.id} for code ${code}`);
			const lobbyId = store.findLobbyByCode(code);
			if (!lobbyId) {
				log(`⚠️ Invalid join attempt (code ${code})`);
				return socket.emit("toast", { type: "error", message: "Lobby not found" });
			}

			// ✅ Fetch the full lobby object
			const lobby = store.index[lobbyId];
			if (!lobby) {
				log(`⚠️ Lobby ${lobbyId} not found in store.index`);
				return socket.emit("toast", { type: "error", message: "Lobby data not found" });
			}

			// ✅ Password check
			if (lobby.isPrivate) {
				if (!password) return socket.emit("lobby:needsPassword", { code });
				if (!store.verifyPassword(lobbyId, password)) {
					return socket.emit("toast", { type: "error", message: "Incorrect password." });
				}
			}

			// ✅ Handle rejoin / mid-game join (running or hibernating)
			if (lobby.phase === "running" || lobby.phase === "hibernating") {
				// Prune stale socket entries from previous server sessions
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

			// === Existing join logic ===
			socket.join(room(lobbyId));
			store.addConnection(lobbyId, socket.id);
			socket.emit("lobby:joined", { lobbyId, code });

			// 👇 Send recent chat to the newly joined client
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

		// Single-player lobby: resolve immediately
		const result = store.checkVoteResolved(lobbyId);
		if (result) {
			await handleRestResolved(lobbyId, result, type, actor.name);
			return;
		}

		// Set 120s timeout — auto-vote NO for anyone still pending
		const timerId = setTimeout(async () => {
			restVoteTimers.delete(lobbyId);
			const voteState = store.getVoteState(lobbyId);
			if (!voteState) return; // already resolved
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
		// ✅ Corrected lookup
		const lobbyId = store.findLobbyByCode(lobbyCode);
		if (!lobbyId) {
			return socket.emit("toast", { type: "error", text: "Lobby not found." });
		}

		const lobby = store.index[lobbyId];
		if (!lobby) {
			return socket.emit("toast", { type: "error", text: "Lobby data missing." });
		}

		if (lobby.phase !== "running" && lobby.phase !== "hibernating") {
			return socket.emit("toast", { type: "error", text: "That game hasn't started yet." });
		}

		if (!lobby.players[charName]) {
			return socket.emit("toast", { type: "error", text: "Character not found." });
		}

		// Verify characterId if BOTH the stored char and the uploaded file have one
		const storedChar = lobby.players[charName];
		if (storedChar.characterId && characterId && storedChar.characterId !== characterId) {
			return socket.emit("toast", { type: "error", message: "Character file does not match. Upload the correct .stchar file to reclaim this character." });
		}

		// Prune stale socket entries (from previous server sessions or disconnects)
		for (const sid of Object.keys(lobby.sockets)) {
			if (!io.sockets.sockets.has(sid)) {
				delete lobby.sockets[sid];
			}
		}

		// Prevent duplicate login for same character
		const active = new Set(Object.values(lobby.sockets).map((s) => s.playerName));
		if (active.has(charName)) {
			return socket.emit("toast", { type: "error", text: "That character is already in use." });
		}

		// ✅ Bind socket to the character
		lobby.sockets[socket.id] = { clientId, playerName: charName };
		socket.join(lobbyId);

		// Clear disconnected flag so player reappears in party panel
		if (lobby.players[charName]) {
			delete lobby.players[charName].disconnected;
		}

		// Ensure the game is running now that a player is back
		if (lobby.phase !== "running") {
			log(`▶️ Lobby ${lobbyId} phase "${lobby.phase}" → "running" (player rejoined)`);
			lobby.phase = "running";
			store.persist(lobbyId);
		}

		// Re-insert into turn order (player was removed on disconnect)
		const dex = Number(lobby.players[charName]?.stats?.dex) || 8;
		store.insertIntoInitiative(lobbyId, charName, dex);
		// Resolve active turn — skip any disconnected players so the
		// rejoining player can become the active player immediately.
		const { current, order } = resolveActiveTurn(lobbyId);
		io.to(room(lobbyId)).emit("turn:update", { current, order });

		// Give the rejoining player 2 minutes to re-read the story before
		// the turn timer starts counting down.
		if (current) {
			startTurnTimer(lobbyId, 2 * 60 * 1000);
		}

		// Check if this rejoining player is the host (by characterId match)
		const isRejoiningHost = !!(lobby.hostCharacterId && characterId && lobby.hostCharacterId === characterId);
		if (isRejoiningHost) {
			lobby.hostSid = socket.id;
			store.persist(lobbyId);
			log(`👑 Host reconnected: ${charName} (${socket.id})`);
		}

		// Notify all players
		io.to(room(lobbyId)).emit("toast", { type: "info", message: `${charName} has returned to the adventure!` });

		// Send updated state
		socket.emit("join:confirmed", { lobbyId, lobbyCode: lobby.code, state: store.publicState(lobbyId), isHost: isRejoiningHost });
		io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
		broadcastLobbies();
	});


	// === Join a game already in progress with a brand-new character ===
	socket.on("player:join:game", async ({ lobbyCode, name, sheet }) => {
		try {
			const lobbyId = store.findLobbyByCode(lobbyCode);
			if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found." });

			const lobby = store.index[lobbyId];
			if (!lobby) return socket.emit("toast", { type: "error", message: "Lobby data missing." });
			if (lobby.phase !== "running" && lobby.phase !== "hibernating") return socket.emit("toast", { type: "error", message: "Game is not currently running." });

			// Ensure the game is running now that a player is joining
			if (lobby.phase !== "running") {
				log(`▶️ Lobby ${lobbyId} phase "${lobby.phase}" → "running" (new player joined)`);
				lobby.phase = "running";
				store.persist(lobbyId);
			}

			const cleanName = (name || "").trim();
			if (!cleanName) return socket.emit("toast", { type: "error", message: "Character name is required." });

			// Prevent duplicate active character
			const active = getActivePlayerNames(lobby);
			if (active.has(cleanName)) {
				return socket.emit("toast", { type: "error", message: `${cleanName} is already in the game.` });
			}

			// Register socket in lobby and save sheet
			socket.join(lobbyId);
			lobby.sockets[socket.id] = { playerName: cleanName, ready: true };
			store.upsertPlayer(lobbyId, socket.id, cleanName, sheet);
			store.initializeAtLevel(lobbyId, cleanName, getAbilityForLevel);

			// Insert into initiative based on DEX (higher DEX = earlier turn)
			const dex = Number(sheet?.stats?.dex) || 8;
			store.insertIntoInitiative(lobbyId, cleanName, dex);

			// Confirm to the joining player
			socket.emit("join:confirmed", {
				lobbyId,
				lobbyCode,
				state: store.publicState(lobbyId),
			});

			// Update everyone else
			const { current, order } = store.turnInfo(lobbyId);
			io.to(room(lobbyId)).emit("turn:update", { current, order });
			io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `${cleanName} has joined the adventure!` });
			broadcastLobbies();

			// Generate a dramatic arrival narration
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
			await streamNarrationToClients(io, room(lobbyId), narration, store.getNarratorVoice(lobbyId));
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
			if (!result) {
				return socket.emit("toast", { type: "error", message: `Could not equip "${itemName}".` });
			}

			log(`⚔️ ${playerName} equipped "${itemName}" as ${slot} (lobby ${lobbyId})`);
			socket.emit("toast", { type: "success", message: `Equipped ${result.equipped.name} as ${slot}.` });
			if (result.unequipped?.name) {
				socket.emit("toast", { type: "info", message: `${result.unequipped.name} returned to inventory.` });
			}

			// Send full state so client sees updated weapon/armor/trinket + inventory
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
			if (!result) {
				return socket.emit("toast", { type: "error", message: `Nothing equipped in ${slot} slot.` });
			}

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

		// Grant the class ability for the new level
		const playerClass = lobby.players[playerName]?.class;
		const newAbility = getAbilityForLevel(playerClass, newLevel);
		if (newAbility) store.addAbility(lobbyId, playerName, { ...newAbility, level: newLevel });

		// Re-read stats after all mutations are applied
		const newStats = lobby.players[playerName]?.stats ?? null;

		socket.emit("player:levelup:confirm", { newStats, newLevel, hpGained, newAbility: newAbility || null });
		log(`⬆️ ${playerName} leveled up to ${newLevel} (+${hpGained} HP)${newAbility ? ` — gained: ${newAbility.name}` : ""}`);

		// Push updated level/HP/slots to the party tracker for all clients
		broadcastPartyState(io, store, lobbyId);

		// Chain: check if another level-up is warranted
		if (store.checkLevelUp(lobbyId, playerName)) {
			const nextLevel = newLevel + 1;
			const upcomingAbility = getAbilityForLevel(playerClass, nextLevel);
			socket.emit("player:levelup", { newLevel: nextLevel, upcomingAbility: upcomingAbility || null });
		}
	});

	// ===== QUICK START (dev mode only) =====
	socket.on("game:quickstart", async ({ lobbyId }) => {
		if (!devMode) {
			return socket.emit("toast", { type: "error", message: "Quick start is only available in dev mode" });
		}
		if (!store.isHost(lobbyId, socket.id)) {
			return socket.emit("toast", { type: "error", message: "Only host can quick start" });
		}

		log(`⚡ Quick start for lobby ${lobbyId}`);

		// Set LLM to test mode
		store.setLLMSettings(lobbyId, "test", "test-stub");

		// Mark all players ready
		const lobby = store.index[lobbyId];
		if (lobby) {
			for (const sid of Object.keys(lobby.sockets)) {
				store.setReady(lobbyId, sid, true);
			}
		}

		// Signal client to proceed with game:start
		socket.emit("game:quickstart:ready", { lobbyId });
	});

	// ===== GAME FLOW =====
	socket.on("game:start", async ({ lobbyId }) => {
		try {
			if (!store.isHost(lobbyId, socket.id)) {
				return socket.emit("toast", { type: "error", message: "Only host can start" });
			}
			if (!store.allReady(lobbyId)) {
				return socket.emit("toast", { type: "error", message: "Not all players ready" });
			}

			log(`🚀 Game starting for lobby ${lobbyId}`);

			// Notify everyone and set phase
			console.log('Game starting event dispatched to lobby: ' + lobbyId);
			io.to(room(lobbyId)).emit("game:starting", { message: "✨ The Dungeon Master is preparing your tale..." });
			store.startGame(lobbyId);
			sendState(lobbyId);
			broadcastLobbies();

			broadcastPartyState(io, store, lobbyId);

			// Give clients a moment before blocking on the LLM
			await new Promise((r) => setTimeout(r, 200));

			// === Setup prompt + adventure name (run in parallel) ===
			const setupPrompt = store.composeSetupPrompt(lobbyId);
			const namePrompt = `You are naming a Dungeons & Dragons adventure. Based on the party composition below, generate a short, dramatic adventure title of 3–5 words. Reply with ONLY the title — no quotes, no punctuation except hyphens, no extra text.\n\nParty:\n${store.playersSummary(lobbyId)}`;

			const [openingRaw, adventureNameRaw] = await Promise.all([
				getLLMResponse([{ role: "system", content: setupPrompt }], llmOpts(lobbyId)),
				getLLMResponse([{ role: "system", content: namePrompt }], llmOpts(lobbyId)),
			]);

			// Parse the setup response — it should be JSON with text/music/suggestions
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
			io.to(room(lobbyId)).emit("debug:setup", {
				raw: openingRaw,
				parsedMusic: setupMusic,
				parsedSuggestions: setupSuggestions,
			});

			const adventureName = typeof adventureNameRaw === "string" ? adventureNameRaw.trim().replace(/^["']|["']$/g, "") : "Untitled Adventure";

			store.setAdventureName(lobbyId, adventureName);
			io.to(room(lobbyId)).emit("adventure:name", { name: adventureName });

			// Save and broadcast narration
			store.appendDM(lobbyId, cleanText);

			io.to(room(lobbyId)).emit("narration", { content: cleanText });

			// Emit music from the opening scene (fall back to "exploration" if LLM didn't provide one)
			const openingMood = setupMusic || "exploration";
			store.setCurrentMusic(lobbyId, openingMood);
			io.to(room(lobbyId)).emit("music:change", { mood: openingMood });
			if (setupSuggestions.length) {
				io.to(room(lobbyId)).emit("suggestions:update", { suggestions: setupSuggestions });
			}

			// Resolve and emit SFX (non-blocking — don't delay narration)
			if (setupSfx.length) {
				resolveSfx(setupSfx, ELEVEN_API_KEY).then(sfxFiles => {
					if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
				}).catch(err => log("⚠️ SFX resolve error:", err.message));
			}

			await streamNarrationToClients(io, room(lobbyId), cleanText, store.getNarratorVoice(lobbyId));

			io.to(room(lobbyId)).emit("game:ready");
			scheduleTimerAfterNarration(lobbyId);
			log(`📜 Opening narration sent for lobby ${lobbyId}`);

			// Seed the map with initial player positions.
			// The DM's opening narration is plain text, so we place players
			// at default grid positions and let the first action update them properly.
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

			// Revert phase so the lobby is usable again
			try { store.setPhase(lobbyId, "waiting"); } catch (_) {}

			// Notify ALL players — they are stuck on the loading screen
			io.to(room(lobbyId)).emit("game:failed", {
				message: "The Dungeon Master ran into a problem. Please try again.",
			});
			io.to(room(lobbyId)).emit("toast", {
				type: "error",
				message: `Failed to start game: ${err.message || "unknown error"}`,
			});

			// Restore the lobby view for everyone
			sendState(lobbyId);
		}
	});

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
			}else{
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

			// --- STEP 1: Play player's own narration first ---
			const playerVoice = actor?.sheet?.voice_id || "nVR3DsQbqULlGfUZGjwn";

			if (playerVoice) {
				await streamNarrationToClients(io, room(lobbyId), text, playerVoice, actor.name);
			} else {
				console.warn("⚠️ No valid player voice found — skipping player narration");
			}

			// --- STEP 2: LLM generates DM narration ---
			const _timerLabel = `LLM_response_time_${lobbyId}_${Date.now()}`;
			console.time(_timerLabel);
			const rawReply = await Promise.race([getLLMResponse(msgs, llmOpts(lobbyId)), new Promise((_, rej) => setTimeout(() => rej(new Error(`LLM timeout after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS))]);
			console.timeEnd(_timerLabel);

			const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
			if (!replyText) {
				console.warn("⚠️ Empty LLM reply");
				io.to(room(lobbyId)).emit("toast", { type: "error", message: "DM returned an empty reply." });
				io.to(room(lobbyId)).emit("ui:unlock");
				return;
			}

			let dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
			let narrationText = dmObj?.text || replyText;
			// If parse failed, prevent raw JSON from poisoning history — strip to plain text best-effort
			if (!dmObj) {
				try {
					const fallback = JSON.parse(replyText);
					narrationText = fallback?.content ?? fallback?.text ?? replyText;
					if (typeof narrationText !== "string") narrationText = replyText;
				} catch {}
			}

			if (dmObj && typeof dmObj === "object") {
				const u = dmObj.updates || {};

				broadcastXPUpdates(io, store, lobbyId, u.xp);
				broadcastHPUpdates(io, store, lobbyId, u.hp);
				await checkAndEndIfAllDead(lobbyId);

				// If everyone is dead, the epilogue already played — bail out
				if (store.index[lobbyId]?.phase === "wiped") {
					io.to(room(lobbyId)).emit("ui:unlock");
					return;
				}

				broadcastInventoryUpdates(io, store, lobbyId, u.inventory);
				broadcastGoldUpdates(io, store, lobbyId, u.gold);
				broadcastConditionUpdates(io, store, lobbyId, u.conditions);
				if (Array.isArray(u.enemies)) store.updateEnemies(lobbyId, u.enemies);

				// Deduct a spell slot if the LLM confirmed a spell was cast
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

				// Use positions and terrain from the DM's own JSON response —
				// no second LLM call needed.
				updateMap(io, store, lobbyId, dmObj.characters || [], dmObj.terrain || null);
				if (Array.isArray(dmObj.suggestions) && dmObj.suggestions.length) {
					io.to(room(lobbyId)).emit("suggestions:update", { suggestions: dmObj.suggestions });
				}
				if (dmObj.music) {
					store.setCurrentMusic(lobbyId, dmObj.music);
					io.to(room(lobbyId)).emit("music:change", { mood: dmObj.music });
				}

				// Resolve and emit SFX (non-blocking)
				if (Array.isArray(dmObj.sfx) && dmObj.sfx.length) {
					resolveSfx(dmObj.sfx, ELEVEN_API_KEY).then(sfxFiles => {
						if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
					}).catch(err => log("⚠️ SFX resolve error:", err.message));
				}
			} else {
				console.warn("⚠️ LLM reply not structured or parse failed");
				console.log("Raw reply text:", replyText);
			}

			// --- STEP 3: DM narration follows ---
			store.appendDM(lobbyId, narrationText);

			io.to(room(lobbyId)).emit("narration", { content: narrationText });

			await streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId));

			// If the DM requested a roll, hold the turn and let the player roll
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

			// Background: update running summary if enough new turns have accumulated.
			// keep=10: always leave the 10 most recent messages unsummarized (sent verbatim to LLM).
			// That's ~5 full player turns of exact wording for continuity.
			// Threshold triggers the pass; keep controls how many survive as verbatim context.
			if (store.needsSummarization(lobbyId, HISTORY_SUMMARIZE_THRESHOLD)) {
				store.autoSummarize(lobbyId, getLLMResponse, llmOpts(lobbyId), 10, MAX_SUMMARY_LENGTH).catch(() => {});
			}
		} catch (err) {
			console.error("💥 Error processing action:", err);
			socket.emit("toast", {
				type: "error",
				message: "The DM stumbled on that one. Try again.",
			});
			io.to(room(lobbyId)).emit("ui:unlock");
		}
	});



	// === Chat System ===
	socket.on("chat:join", ({ lobbyId, name }) => {
		if (!store.index[lobbyId]) return;
		store.socketsAdd(lobbyId, socket.id);
		store.index[lobbyId].sockets[socket.id].playerName = name;
		socket.join(room(lobbyId));

		// Send chat history
		const history = store.getChat(lobbyId, 50);
		socket.emit("chat:history", history);

		// Broadcast new user list
		const users = store.getChatUsers(lobbyId);
		io.to(room(lobbyId)).emit("chat:users", users);
		console.log(`💬 ${name} joined chat for lobby ${lobbyId}`);
	});

	socket.on("chat:message", ({ lobbyId, name, text }) => {
		if (!store.index[lobbyId]) return;
		const msg = { name, text, timestamp: Date.now() };
		store.appendChat(lobbyId, name, text);
		io.to(room(lobbyId)).emit("chat:message", msg);
	});

	socket.on("chat:updateName", ({ lobbyId, oldName, newName, clientId }) => {
		if (!store.index[lobbyId]) return;
		const lobby = store.index[lobbyId];

		log(`💬 chat:updateName: ${oldName} → ${newName}`);

		// Update chat history messages authored under the old name
		if (Array.isArray(lobby.chat)) {
			for (const msg of lobby.chat) {
				if (msg.name === oldName) msg.name = newName;
			}
		}

		store.persist(lobbyId);

		// Broadcast name change to chat windows
		io.to(room(lobbyId)).emit("chat:nameChange", { oldName, newName, clientId });

		// Refresh users list and chat history for all clients
		const users = store.getChatUsers(lobbyId);
		const updatedHistory = store.getChat(lobbyId, 50);
		io.to(room(lobbyId)).emit("chat:users", users);
		io.to(room(lobbyId)).emit("chat:historyUpdate", updatedHistory);

		// Push updated player list to the lobby so all clients see the new name
		sendState(lobbyId);
	});

	socket.on("chat:users:request", ({ lobbyId }) => {
		const users = store.getChatUsers(lobbyId);
		socket.emit("chat:users", users);
	});

	// Fires while socket is still in its rooms — safe to emit to roommates
	socket.on("disconnecting", () => {
		log(`⚡ disconnecting: ${socket.id} | rooms: ${[...socket.rooms].join(", ")}`);
		try {
			for (const [lobbyId, lobby] of Object.entries(store.index || {})) {
				const rec = lobby.sockets?.[socket.id];
				if (!rec) {
					continue;
				}

				const playerName = rec.playerName;
				log(`🔍 disconnecting: socket ${socket.id} found in lobby ${lobbyId} as "${playerName}" (phase: ${lobby.phase})`);

				// Host left a waiting lobby — nobody can start the game, so remove it
				if (lobby.phase === "waiting" && lobby.hostSid === socket.id) {
					log(`🗑️ Host disconnected from waiting lobby ${lobbyId} — removing lobby`);
					io.to(room(lobbyId)).emit("toast", {
						type: "error",
						message: "The host has left. This lobby has been closed.",
					});
					io.to(room(lobbyId)).emit("lobby:closed");
					// Disconnect all other sockets from the room
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
					// Mark player as disconnected so party panel removes them
					if (lobby.players[playerName]) {
						lobby.players[playerName].disconnected = true;
					}

					// Cancel timer if this player's turn was active
					const timerEntry = activeTimers.get(lobbyId);
					if (timerEntry?.playerName === playerName) {
						cancelTurnTimer(lobbyId);
					}

					// Remove from turn order (keeps player data for rejoin)
					store.removeFromTurnOrder(lobbyId, playerName);

					// Notify remaining players (socket still in room — emit reaches them)
					log(`📣 Emitting player:left + toast + turn:update to room ${lobbyId}`);
					io.to(room(lobbyId)).emit("toast", {
						type: "warning",
						message: `${playerName} has left the adventure.`,
					});
					io.to(room(lobbyId)).emit("player:left", { player: playerName });

					const { current, order } = resolveActiveTurn(lobbyId);
					log(`🔄 New turn order after disconnect: [${order.join(", ")}], current: ${current}`);
					io.to(room(lobbyId)).emit("turn:update", { current, order });
					startTurnTimer(lobbyId);

					// If no active connections remain after this socket goes, hibernate
					const remaining = Object.values(lobby.sockets).filter(
						(s) => s.playerName && s !== rec
					);
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

	// Fires after socket has left rooms — final cleanup and state broadcast
	socket.on("disconnect", () => {
		log(`❌ Client disconnected: ${socket.id}`);
		hostAdminSockets.delete(socket.id);
		try {
			for (const [lobbyId, lobby] of Object.entries(store.index || {})) {
				if (!lobby.sockets?.[socket.id]) continue;
				delete lobby.sockets[socket.id];
				store.persist(lobbyId);
				// Push updated state (party now excludes disconnected player)
				sendState(lobbyId);
				broadcastPartyState(io, store, lobbyId);
				broadcastLobbies();
				log(`📤 Post-disconnect state broadcast for lobby ${lobbyId}`);
			}
		} catch (e) {
			console.warn("disconnect cleanup error", e);
		}
	});
	// Typing indicator
	socket.on("chat:typing", ({ lobbyId, name, typing }) => {
		if (!store.index[lobbyId]) return;
		socket.to(room(lobbyId)).emit("chat:typing", { name, typing });
	});
	socket.on("dice:roll", ({ lobbyId, kind, value }) => {
		try {
			const actor = store.playerBySid(lobbyId, socket.id);
			if (!actor) return;

			const text = `${actor.name} rolls a ${kind} and gets ${value}!`;

			// Redirect into the normal AI pipeline
			io.to(room(lobbyId)).emit("action:log", { player: actor.name, text, timestamp: Date.now() });

			// Feed it into the same LLM process
			store.appendUser(lobbyId, actor.name, text);
			const messages = store.composeMessages(lobbyId, actor.name, text);
			getLLMResponse(messages, llmOpts(lobbyId)).then(async (dm) => {
				const replyText = typeof dm === "string" ? dm.trim() : "";
				const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
				const narrationText = dmObj?.text || replyText;
				store.appendDM(lobbyId, narrationText);
				io.to(room(lobbyId)).emit("narration", { content: narrationText });
				streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId));
				sendState(lobbyId);
			});
		} catch (err) {
			log("💥 Dice roll error:", err);
		}
	});

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

	// === Pin / Unpin story moments ===
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
		if (store.unpinMoment(lobbyId, historyIndex)) {
			sendState(lobbyId);
		}
	});

	// Client signals that narration audio has finished playing — start the turn timer now
	socket.on("narration:done", ({ lobbyId }) => {
		if (pendingTimerStarts.has(lobbyId)) {
			clearTimeout(pendingTimerStarts.get(lobbyId));
			pendingTimerStarts.delete(lobbyId);
			startTurnTimer(lobbyId, 0);
		}
	});

	// === HOST SOCKET VERIFICATION ===
	// The host authenticates by presenting their signed .stchar file via HTTP (host-verify),
	// which sets a cookie. Then when they open the admin page the cookie grants access.
	// On the socket side, we authorize via the host:auth event with their characterId.
	socket.on("host:auth", ({ lobbyCode, characterId }) => {
		if (!lobbyCode || !characterId) return socket.emit("toast", { type: "error", message: "Missing auth data" });
		const lobbyId = store.findLobbyByCode(lobbyCode);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found" });
		const lobby = store.index[lobbyId];
		if (!lobby.hostCharacterId || lobby.hostCharacterId !== characterId) {
			log(`⚠️ host:auth failed — characterId mismatch for lobby ${lobbyCode} from ${socket.id}`);
			return socket.emit("toast", { type: "error", message: "Not authorized as host" });
		}
		hostAdminSockets.set(socket.id, lobbyCode);
		log(`🔓 Host socket ${socket.id} authorized for lobby ${lobbyCode}`);
		socket.emit("host:auth:ok", { lobbyCode });
	});

	// Helper: check if this socket can perform admin actions on the given lobby code.
	// Returns true if:
	// 1. Socket has a valid admin password session cookie (full admin), OR
	// 2. Socket is an authorized host for this specific lobby
	function isSocketAdmin(code) {
		// Check host-admin authorization (scoped to their lobby only)
		const hostCode = hostAdminSockets.get(socket.id);
		if (hostCode && hostCode === code) return true;
		// Check cookies from the socket handshake
		const cookieStr = socket.handshake?.headers?.cookie || "";
		const token = parseCookie(cookieStr).admin_token;
		if (token) {
			// Full admin password session — unrestricted
			cleanExpired(adminSessions);
			if (adminSessions.has(token)) return true;
			// Host token — scoped to their lobby only
			cleanExpired(hostAdminTokens);
			const hostEntry = hostAdminTokens.get(token);
			if (hostEntry && hostEntry.lobbyCode === code) return true;
		}
		return false;
	}

	// ===== ADMIN SOCKET EVENTS (RESTORED) =====
	socket.on("admin:connect", ({ code }) => {
		log(`🧭 ADMIN connect request for lobby code ${code} from ${socket.id}`);
		if (!isSocketAdmin(code)) {
			log(`⚠️ Unauthorized admin:connect attempt by ${socket.id} for lobby ${code}`);
			return socket.emit("toast", { type: "error", message: "Not authorized" });
		}
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ Admin tried to connect to invalid code: ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		socket.join(room(lobbyId));
		const state = store.publicState(lobbyId);
		socket.emit("admin:connected", state);
		log(`✅ ADMIN connected to lobby ${lobbyId} (${code}) with ${Object.keys(state.players).length} players`);
	});

	socket.on("admin:event", async ({ code, type, payload }) => {
		if (!isSocketAdmin(code)) {
			return socket.emit("toast", { type: "error", message: "Not authorized" });
		}
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return;

		// Apply effects server-side and broadcast updates
		switch (type) {
			case "xp:update": {
				const newXP = store.addXP(lobbyId, payload.player, payload.amount);
				io.to(room(lobbyId)).emit("xp:update", {
					player: payload.player,
					xp: newXP,
					amount: payload.amount,
					reason: payload.reason || "Manual adjustment",
				});
				if (store.checkLevelUp(lobbyId, payload.player)) {
					const sid = store.sidByPlayerName(lobbyId, payload.player);
					if (sid) {
						const playerData = store.index[lobbyId].players[payload.player];
						const newLvl = (playerData?.level || 1) + 1;
						const upcomingAbility = getAbilityForLevel(playerData?.class, newLvl);
						io.to(sid).emit("player:levelup", { newLevel: newLvl, upcomingAbility: upcomingAbility || null });
					}
				}
				break;
			}
			case "hp:update": {
				const newHP = store.applyHPChange(lobbyId, payload.player, payload.delta);
				io.to(room(lobbyId)).emit("hp:update", {
					player: payload.player,
					hp: newHP,
					delta: payload.delta,
					reason: payload.reason || "Manual change",
				});
				broadcastPartyState(io, store, lobbyId);
				break;
			}
			case "gold:update": {
				const newGold = store.applyGoldChange(lobbyId, payload.player, payload.delta);
				io.to(room(lobbyId)).emit("gold:update", {
					player: payload.player,
					gold: newGold,
					delta: payload.delta,
					reason: payload.reason || "Manual change",
				});
				break;
			}
			case "spellslots:update": {
			const newUsed = store.applySpellSlotChange(lobbyId, payload.player, payload.delta);
			const maxSlots = store.index[lobbyId]?.players[payload.player]?.level || 1;
			io.to(room(lobbyId)).emit("spellslots:update", {
				player: payload.player,
				spellSlotsUsed: newUsed,
				maxSlots,
			});
			broadcastPartyState(io, store, lobbyId);
			break;
		}
		case "inventory:update": {
				const newCount = store.applyInventoryChange(lobbyId, payload.player, payload.item, payload.change, payload.description || "", payload.attributes || {});
				io.to(room(lobbyId)).emit("inventory:update", {
					player: payload.player,
					item: payload.item,
					change: payload.change,
					newCount,
					description: payload.description || "",
					attributes: payload.attributes || {},
				});
				// Push full state so the game UI re-renders with the new item
				io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
				break;
			}
			case "player:death": {
				const { player, reason } = payload;
				console.log(`💀 Admin forced death for ${player} in lobby ${code}${reason ? ` — ${reason}` : ""}`);

				// Append death event to history so the LLM has context
				const deathNarration = reason
					? `${player} has been killed: ${reason}`
					: `${player} has been struck down by a fatal blow.`;
				store.appendDM(lobbyId, deathNarration);
				io.to(room(lobbyId)).emit("narration", { content: deathNarration });

				store.markPlayerDead(lobbyId, player);
				store.removeFromTurnOrder(lobbyId, player);

				// Emit player:death BEFORE checking for TPK so clients get the
				// individual death event before any potential wipe epilogue/game:over
				const { current: dCurrent, order: dOrder } = store.turnInfo(lobbyId);
				io.to(room(lobbyId)).emit("player:death", {
					player,
					message: reason ? `${player} has fallen: ${reason}` : `${player} has fallen (admin override)!`,
				});
				io.to(room(lobbyId)).emit("turn:update", { current: dCurrent, order: dOrder });

				await checkAndEndIfAllDead(lobbyId);

				if (store.index[lobbyId]?.phase !== "wiped") {
					sendState(lobbyId);
				}

				break;
			}
			case "player:kick": {
			const kickedSid = store.kickPlayer(lobbyId, payload.player);
			if (kickedSid) {
				io.to(kickedSid).emit("player:kicked", { reason: "You were removed by an admin." });
				const kickedSocket = io.sockets.sockets.get(kickedSid);
				if (kickedSocket) kickedSocket.leave(room(lobbyId));
			}
			sendState(lobbyId);
			broadcastLobbies();
			break;
		}
		case "roll:required": {
			const { player, sides, stats, mods, dc } = payload;
			io.to(room(lobbyId)).emit("roll:required", {
				player,
				sides: Number(sides),
				stats: Array.isArray(stats) ? stats : [],
				mods: Number(mods) || 0,
				dc: Number(dc) || 0,
			});
			break;
		}
		case "conditions:update": {
			const { player, add = [], remove = [] } = payload;
			const conds = store.applyConditions(lobbyId, player, add, remove);
			io.to(room(lobbyId)).emit("conditions:update", { player, conditions: conds });
			broadcastPartyState(io, store, lobbyId);
			break;
		}
		case "player:forceLevelUp": {
				const { player } = payload;
				const playerData = store.index[lobbyId]?.players[player];
				if (!playerData) return;

				// Do NOT call increaseLevel here — the confirm handler does that.
				// Just compute the upcoming level and send the event so the player
				// sees the stat-allocation modal (which triggers the confirm chain).
				const playerClass = playerData.class;
				const upcomingLevel = (playerData.level || 1) + 1;
				const upcomingAbility = getAbilityForLevel(playerClass, upcomingLevel);

				const sid = store.sidByPlayerName(lobbyId, player);
				if (sid) {
					io.to(sid).emit("player:levelup", { newLevel: upcomingLevel, upcomingAbility: upcomingAbility || null });
				}
				io.to(room(lobbyId)).emit("toast", {
					type: "info",
					message: `${player} has been awarded a level up to ${upcomingLevel}! (forced by admin)`,
				});
				console.log(`⚙️ [ADMIN] Force level-up event sent to ${player} → will reach level ${upcomingLevel}`);
				break;
			}
			default:
				log(`⚠️ Unknown admin event type: ${type}`);
				return;
		}

		log(`🧙‍♂️ Admin triggered ${type} for ${payload.player}`);
	});


	socket.on("admin:phase", ({ code, phase }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		log(`🔄 ADMIN phase change — lobby ${code}, new phase "${phase}"`);
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ Phase change failed — no lobby for ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		try {
			store.setPhase(lobbyId, phase);
			const state = store.publicState(lobbyId);
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `Phase changed → ${phase}` });
			io.to(room(lobbyId)).emit("state:update", state);
			socket.emit("admin:update", state);
			log(`✅ Phase for ${lobbyId} now "${phase}"`);
		} catch (err) {
			log(`💥 ADMIN phase change error:`, err);
			socket.emit("toast", { type: "error", message: err.message });
		}
	});

	socket.on("admin:nextTurn", ({ code }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		log(`⏭️ ADMIN next turn — lobby ${code}`);
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ Next turn failed — no lobby for ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		try {
			cancelTurnTimer(lobbyId);
			store.nextTurn(lobbyId);
			const turn = resolveActiveTurn(lobbyId);
			log(`➡️ Turn advanced to ${turn.current}`);
			io.to(room(lobbyId)).emit("turn:update", turn);
			io.to(room(lobbyId)).emit("toast", { type: "info", message: `Turn advanced manually` });
			startTurnTimer(lobbyId);
			socket.emit("admin:update", store.publicState(lobbyId));
		} catch (err) {
			log(`💥 ADMIN nextTurn error:`, err);
			socket.emit("toast", { type: "error", message: err.message });
		}
	});

	socket.on("admin:music", ({ code, mood }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found" });
		store.setCurrentMusic(lobbyId, mood || null);
		io.to(room(lobbyId)).emit("music:change", { mood: mood || null });
		log(`🎵 ADMIN music → lobby ${lobbyId}: ${mood || "stop"}`);
		socket.emit("toast", { type: "success", message: mood ? `Music changed to: ${mood}` : "Music stopped" });
	});

	socket.on("admin:llm", ({ code, provider, model }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: "Lobby not found" });
		store.setLLMSettings(lobbyId, provider, model);
		sendState(lobbyId);
		log(`🤖 ADMIN LLM → lobby ${lobbyId}: ${provider}/${model}`);
		socket.emit("toast", { type: "success", message: `LLM switched to ${provider} / ${model}` });
	});

	socket.on("admin:sfx", async ({ code, description }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		if (!description || typeof description !== "string" || !description.trim()) {
			return socket.emit("toast", { type: "error", message: "Enter a sound effect description" });
		}

		const desc = description.trim();
		log(`🔊 ADMIN SFX test → "${desc}"`);
		try {
			// Check for pre-existing match before resolving (which may generate)
			const preExisting = findSfxMatch(desc);
			const results = await resolveSfx([desc], ELEVEN_API_KEY);
			if (!results.length) {
				return socket.emit("admin:sfx:result", { ok: false, error: "No match found and generation failed or unavailable" });
			}
			const fx = results[0];
			// Play on all game clients in the lobby
			const lobbyId = store.findLobbyByCode(code);
			if (lobbyId) io.to(room(lobbyId)).emit("sfx:play", { effects: [fx] });
			socket.emit("admin:sfx:result", { ok: true, effect: fx, source: preExisting ? "library" : "generated" });
		} catch (err) {
			log(`💥 ADMIN SFX test error: ${err.message}`);
			socket.emit("admin:sfx:result", { ok: false, error: err.message });
		}
	});

	socket.on("admin:dm", ({ code, content }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		log(`📜 ADMIN DM message — lobby ${code}: ${content}`);
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) {
			log(`⚠️ DM failed — no lobby for ${code}`);
			return socket.emit("toast", { type: "error", message: "Lobby not found" });
		}
		try {
			store.appendDM(lobbyId, content);
			io.to(room(lobbyId)).emit("narration", { content: `[ADMIN] ${content}` });
			socket.emit("admin:update", store.publicState(lobbyId));
			log(`✅ DM narration sent to lobby ${lobbyId}`);
		} catch (err) {
			log(`💥 ADMIN DM error:`, err);
			socket.emit("toast", { type: "error", message: err.message });
		}
	});

	socket.on("admin:deleteLobby", ({ code }) => {
		if (!isSocketAdmin(code)) return socket.emit("toast", { type: "error", message: "Not authorized" });
		const lobbyId = store.findLobbyByCode(code);
		if (!lobbyId) return socket.emit("toast", { type: "error", message: `Lobby ${code} not found` });
		// Notify any connected players before wiping
		io.to(room(lobbyId)).emit("toast", { type: "warning", message: "This lobby has been deleted by an admin." });
		io.socketsLeave(room(lobbyId));
		store.deleteLobby(lobbyId);
		broadcastLobbies();
		log(`🗑️ Admin deleted lobby ${lobbyId} (${code})`);
		socket.emit("admin:lobbyDeleted", { code });
	});

});

//Helpers
function getActivePlayerNames(lobby) {
	if (!lobby || !lobby.sockets) return new Set();
	const names = new Set();
	for (const [sid, s] of Object.entries(lobby.sockets)) {
		// Only count sockets that are actually connected right now
		if (s && s.playerName && io.sockets.sockets.has(sid)) {
			names.add(s.playerName);
		}
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

// Compact schema used when asking the LLM to repair malformed JSON
const DM_JSON_SCHEMA = `{
  "text": string,
  "updates": {
    "xp": [{ "player": string, "amount": number, "reason": string }],
    "hp": [{ "player": string, "delta": number, "reason": string, "new_total": number }],
    "inventory": [{ "player": string, "item": string, "change": number, "description": string, "change_type": "add"|"remove", "attributes": object }],
    "gold": [{ "player": string, "delta": number }],
    "conditions": [{ "player": string, "add": string[], "remove": string[] }],
    "abilities": [{ "player": string, "change_type": "add"|"remove", "name": string, "description": string, "attributes": object }]
  },
  "prompt": string,
  "roll": { "sides": number, "stats": string[], "mods": number, "dc": number } | null,
  "suggestions": string[],
  "spellUsed": boolean,
  "music": string | null,
  "sfx": string[]
}`;

// Extract and parse the first JSON object from a string. Be tolerant to code fences, bare newlines, and unescaped quotes in string values.
// When llmRepairOpts is provided ({ getLLMResponse, llmOpts }), invalid JSON is sent back to the LLM for repair (up to 2 attempts) before falling back to local text hacks.
async function parseDMJson(text, llmRepairOpts) {
  if (!text) return null;

  text = String(text).trim();

  // Strip code fences anywhere in the text (LLMs sometimes prefix/suffix them)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const slice = text.startsWith('{')
    ? text
    : (() => {
        const first = text.indexOf('{'), last = text.lastIndexOf('}');
        return first !== -1 && last !== -1 && last > first ? text.slice(first, last + 1) : null;
      })();

  if (!slice) return null;

  // Helper: unwrap {role, content} envelope the LLM sometimes echoes from history
  function unwrap(obj) {
    if (obj && typeof obj === "object" && !obj.text && typeof obj.content === "string") {
      try { return JSON.parse(obj.content); } catch {}
    }
    return obj;
  }

  // Attempt 1: standard parse
  try { return unwrap(JSON.parse(slice)); } catch (e1) {
    console.warn(`⚠️ parseDMJson attempt 1 (standard parse) failed: ${e1.message}`);
  }

  // Attempt 2-3: ask the LLM to fix its own malformed JSON (up to 2 tries)
  if (llmRepairOpts?.getLLMResponse && llmRepairOpts?.llmOpts) {
    let lastBadJson = slice;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.warn(`🔧 parseDMJson: requesting LLM repair (attempt ${attempt}/2)...`);
        const repairReply = await llmRepairOpts.getLLMResponse([
          {
            role: "system",
            content: `You are a JSON repair assistant. The following JSON is malformed and cannot be parsed. Fix it so it is valid JSON conforming to this schema:\n\n${DM_JSON_SCHEMA}\n\nRules:\n- Return ONLY the repaired JSON object — no markdown, no code fences, no explanation.\n- Preserve all original content/values — only fix structural JSON issues (missing commas, unescaped quotes, trailing commas, unclosed braces, etc.).\n- Do NOT add or remove fields beyond what is already present.`,
          },
          {
            role: "user",
            content: lastBadJson,
          },
        ], llmRepairOpts.llmOpts);

        const repairText = typeof repairReply === "string" ? repairReply.trim() : "";
        // Strip code fences the repair LLM might add
        const cleaned = repairText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        console.log(`✅ parseDMJson: LLM repair attempt ${attempt} succeeded`);
        return unwrap(parsed);
      } catch (err) {
        console.warn(`⚠️ parseDMJson LLM repair attempt ${attempt} failed: ${err.message}`);
        // On the second attempt, feed the latest (still broken) reply back
        // so the LLM can see its own prior repair attempt
      }
    }
  }

  // Attempt 4: escape bare newlines/tabs inside string values
  try {
    return unwrap(JSON.parse(slice.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')));
  } catch (e2) {
    console.warn(`⚠️ parseDMJson attempt (newline escape) failed: ${e2.message}`);
  }

  // Attempt 5: repair unescaped double-quotes inside JSON string values.
  // Strategy: walk the string character-by-character tracking whether we're inside
  // a JSON string, and escape any " that isn't already preceded by a backslash
  // and isn't the opening/closing quote of a key or value.
  try {
    let repaired = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (escaped) {
        repaired += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        repaired += ch;
        continue;
      }
      if (ch === '"') {
        if (!inString) {
          inString = true;
          repaired += ch;
        } else {
          // Peek ahead: if the next non-whitespace char is :, ,, }, or ] this is a closing quote
          let j = i + 1;
          while (j < slice.length && (slice[j] === ' ' || slice[j] === '\t')) j++;
          const next = slice[j];
          if (next === ':' || next === ',' || next === '}' || next === ']') {
            inString = false;
            repaired += ch;
          } else {
            // Unescaped quote inside a string value — escape it
            repaired += '\\"';
          }
        }
        continue;
      }
      repaired += ch;
    }
    return unwrap(JSON.parse(repaired));
  } catch (e3) {
    console.warn(`⚠️ parseDMJson attempt (quote repair) failed: ${e3.message}`);
  }

  return null;
}

async function fetchVoices() {
	try {
		// If voices already loaded in memory, reuse them
		if (ELEVEN_VOICES.length) return ELEVEN_VOICES;
		const res = await fetch("https://api.elevenlabs.io/v1/voices", {
			headers: { "xi-api-key": ELEVEN_API_KEY },
		});
		if (!res.ok) throw new Error(`Failed to fetch voices: ${res.status}`);
		const data = await res.json();

		ELEVEN_VOICES = data.voices || [];

		// Save to cache file
		fs.mkdirSync(path.dirname(VOICE_CACHE_FILE), { recursive: true });
		fs.writeFileSync(VOICE_CACHE_FILE, JSON.stringify(ELEVEN_VOICES, null, 2));

		return ELEVEN_VOICES;

	} catch (err) {
		log(`⚠️  ElevenLabs API fetch failed: ${err.message} — checking cache...`);

		// Fall back to cached voices file
		try {
			if (fs.existsSync(VOICE_CACHE_FILE)) {
				const cached = JSON.parse(fs.readFileSync(VOICE_CACHE_FILE, "utf8"));
				if (Array.isArray(cached) && cached.length) {
					ELEVEN_VOICES = cached;
					log(`✅ Loaded ${cached.length} voices from cache`);
					return ELEVEN_VOICES;
				}
			}
		} catch (cacheErr) {
			log(`⚠️  Voice cache read failed: ${cacheErr.message}`);
		}

		return [];
	}
}

// ===== ElevenLabs streaming helper =====

/**
 * Convert ElevenLabs character-level alignment to word-level timing data.
 * @param {object}  alignment   - { characters, character_start_times_seconds, character_end_times_seconds }
 * @param {number}  timeOffset  - cumulative seconds from prior text chunks
 * @param {number}  indexOffset - cumulative word count from prior text chunks
 * @returns {Array<{word:string, start:number, end:number, index:number}>}
 */
function charAlignmentToWords(alignment, timeOffset, indexOffset) {
	const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
	if (!characters || !character_start_times_seconds || !character_end_times_seconds) return [];

	const words = [];
	let wordStart = null;
	let wordChars = "";

	for (let i = 0; i < characters.length; i++) {
		const ch = characters[i];
		if (ch === " " || ch === "\n" || ch === "\t") {
			if (wordChars) {
				words.push({
					word: wordChars,
					start: wordStart + timeOffset,
					end: character_end_times_seconds[i - 1] + timeOffset,
					index: indexOffset + words.length,
				});
				wordChars = "";
				wordStart = null;
			}
		} else {
			if (wordStart === null) wordStart = character_start_times_seconds[i];
			wordChars += ch;
		}
	}
	if (wordChars && characters.length > 0) {
		words.push({
			word: wordChars,
			start: wordStart + timeOffset,
			end: character_end_times_seconds[characters.length - 1] + timeOffset,
			index: indexOffset + words.length,
		});
	}
	return words;
}

async function streamNarrationToClients(io, lobbyId, text, voiceId, playerName) {
	const streamId = randomUUID();
	try {
		if (devMode) {
			io.to(room(lobbyId)).emit("narration", { content: null, status: REJECTED_REQUEST_STATUS });

			io.to(room(lobbyId)).emit("narration:start", {
				speaker: playerName || "DM",
				streamId,
				status: REJECTED_REQUEST_STATUS,
			});

			io.to(room(lobbyId)).emit("narration:audio:end", { streamId, status: REJECTED_REQUEST_STATUS });
			return;
		}

		if (!ELEVEN_API_KEY) {
			console.warn("⚠️ ElevenLabs API key not set, skipping TTS.");
			io.to(room(lobbyId)).emit("narration:start", {
				speaker: playerName || "DM",
				streamId,
				status: REJECTED_REQUEST_STATUS,
			});
			io.to(room(lobbyId)).emit("narration:audio:end", { streamId, status: REJECTED_REQUEST_STATUS });
			return;
		}

		voiceId = voiceId ? voiceId : ELEVEN_VOICE_ID;

		const chunks = text.match(/[\s\S]{1,1800}(?=\s|$)/g) || [text];

		io.to(room(lobbyId)).emit("narration:start", {
			speaker: playerName || "DM",
			streamId,
		});

		let cumulativeDuration = 0;
		let wordOffset = 0;

		for (let i = 0; i < chunks.length; i++) {
			const part = chunks[i].trim();
			if (!part) continue;
			let cleanText = part.replace(/\[[^\]]*\]/g, "").trim();
			if (!cleanText) {
				continue;
			}

			// Use with-timestamps endpoint for word-level alignment data
			const response = await fetch(
				`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream/with-timestamps`,
				{
					method: "POST",
					headers: {
						"xi-api-key": ELEVEN_API_KEY,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						text: cleanText,
						model_id: "eleven_flash_v2_5",
						voice_settings: { stability: 0.4, similarity_boost: 0.8 },
					}),
				}
			);

			if (!response.ok) {
				throw new Error(`TTS request failed: ${response.statusText}`);
			}

			// Response is newline-delimited JSON with audio_base64 and alignment fields
			const nodeStream = response.body instanceof PassThrough
				? response.body
				: response.body.pipe(new PassThrough());

			let audioBuffer = [];
			let jsonLine = "";
			let alignmentChars = null;
			const CHUNK_SIZE = 8 * 1024;

			await new Promise((resolve, reject) => {
				nodeStream.on("data", (rawChunk) => {
					jsonLine += rawChunk.toString();
					const lines = jsonLine.split("\n");
					jsonLine = lines.pop(); // keep incomplete tail

					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const obj = JSON.parse(line);
							if (obj.audio_base64) {
								const audioBuf = Buffer.from(obj.audio_base64, "base64");
								audioBuffer.push(audioBuf);
								const total = audioBuffer.reduce((s, b) => s + b.length, 0);
								if (total >= CHUNK_SIZE) {
									const combined = Buffer.concat(audioBuffer);
									io.to(room(lobbyId)).emit("narration:audio", {
										data: combined.toString("base64"),
										streamId,
									});
									audioBuffer = [];
								}
							}
							if (obj.alignment) {
								alignmentChars = obj.alignment;
							} else if (obj.normalizedAlignment && !alignmentChars) {
								alignmentChars = obj.normalizedAlignment;
							}
						} catch { /* skip malformed JSON lines */ }
					}
				});

				nodeStream.on("end", () => {
					// Process remaining partial JSON line
					if (jsonLine.trim()) {
						try {
							const obj = JSON.parse(jsonLine);
							if (obj.audio_base64) {
								audioBuffer.push(Buffer.from(obj.audio_base64, "base64"));
							}
							if (obj.alignment) alignmentChars = obj.alignment;
							else if (obj.normalizedAlignment && !alignmentChars) alignmentChars = obj.normalizedAlignment;
						} catch { /* ignore */ }
					}
					// Flush remaining audio
					if (audioBuffer.length > 0) {
						const combined = Buffer.concat(audioBuffer);
						io.to(room(lobbyId)).emit("narration:audio", {
							data: combined.toString("base64"),
							streamId,
						});
					}
					resolve();
				});

				nodeStream.on("error", reject);
			});

			// Emit word-level alignment data for this chunk
			if (alignmentChars) {
				const words = charAlignmentToWords(alignmentChars, cumulativeDuration, wordOffset);
				if (words.length > 0) {
					io.to(room(lobbyId)).emit("narration:alignment", { streamId, words });
					wordOffset += words.length;
					// Advance cumulative duration using the last character's end time
					const endTimes = alignmentChars.character_end_times_seconds;
					if (endTimes && endTimes.length > 0) {
						cumulativeDuration += endTimes[endTimes.length - 1];
					}
				}
			}

			if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 250));
		}

		io.to(room(lobbyId)).emit("narration:audio:end", { streamId });
	} catch (err) {
		console.error("💥 TTS Streaming Error:", err);
		io.to(lobbyId).emit("narration:audio:end", { streamId });
	}
}
// === ACTIVE LOBBIES LIST ===

// Auto-hibernate running games with no connected players or stale for 30+ minutes.
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

// === SERVICE AVAILABILITY ===
app.get("/api/features", (req, res) => {
	res.json({
		openai:     serviceStatus.openai,
		claude:     serviceStatus.claude,
		elevenlabs: serviceStatus.elevenlabs,
		devMode,
		version:    process.env.APP_VERSION || "0.0",
	});
});

// === ELEVENLABS VOICE ENDPOINT ===
app.get("/api/voices", async (req, res) => {
	// If ElevenLabs wasn't available at startup but we have a key, retry now
	// (Docker containers often have network delays at boot)
	if (!serviceStatus.elevenlabs && ELEVEN_API_KEY) {
		const retried = await fetchVoices();
		if (retried.length) {
			serviceStatus.elevenlabs = true;
			log("✅ ElevenLabs recovered on retry — voices now available");
		} else {
			return res.json({ ok: false, voices: [], error: "ElevenLabs is not available" });
		}
	} else if (!serviceStatus.elevenlabs) {
		return res.json({ ok: false, voices: [], error: "ElevenLabs is not available" });
	}
	try {
		let voices = ELEVEN_VOICES;

		// if not already cached
		if (!voices || !voices.length) {
			voices = await fetchVoices();
		}

		// Minimal payload for dropdown
		const list = voices.map(v => ({
			id: v.voice_id,
			name: v.name,
			category: v.category || "",
			accent: v.labels?.accent || "",
			description: v.description || "",
		}));

		res.json({ ok: true, voices: list });
	} catch (err) {
		console.error("💥 Failed to fetch voice list:", err);
		res.status(500).json({ ok: false, error: "Failed to fetch voices" });
	}
});

// === PREVIEW ENDPOINT (for play button) ===
app.get("/api/voice-preview/:id", async (req, res) => {
	try {

		if (devMode) {
			res.status(204).json({ ok: true, message: "Voice preview disabled in dev mode." });
			return;
		}
		const voiceId = req.params.id;
		const text = "Greetings, traveler. I am the voice of your adventure.";

		const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
			method: "POST",
			headers: {
				"xi-api-key": ELEVEN_API_KEY,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({
				text,
				model_id: "eleven_multilingual_v2",
				voice_settings: { stability: 0.4, similarity_boost: 0.8 },
			}),
		});

		if (!r.ok) throw new Error(`Preview failed: ${r.statusText}`);

		// Stream audio directly to browser
		res.setHeader("Content-Type", "audio/mpeg");
		r.body.pipe(res);
	} catch (err) {
		console.error("💥 Error generating preview:", err);
		res.status(500).send("Preview unavailable");
	}
});

//Import the map endpoints
registerMapEndpoints(app, store);

// === CHARACTER IMAGE GENERATION ===
app.post("/api/character-image", async (req, res) => {
	try {
		const { lobbyId, playerName, sheet } = req.body;
		if (!lobbyId || !playerName) {
			return res.status(400).json({ error: "Missing lobbyId or playerName" });
		}
		if (devMode) {
			return res.status(REJECTED_REQUEST_STATUS).json({ message: "Character image generation disabled in developer mode." });
		}
		if (!hasLLM()) {
			return res.status(503).json({ error: "Image generation unavailable — no OpenAI key configured" });
		}

		log(`🎨 Generating character image for ${playerName} in lobby ${lobbyId}`);
		const b64 = await generateCharacterImage(sheet);

		const safeName = playerName.replace(/[^a-zA-Z0-9]/g, "_");
		const filename = `${lobbyId}-${safeName}.png`;
		const filepath = path.join(IMAGES_DIR, filename);
		fs.writeFileSync(filepath, Buffer.from(b64, "base64"));

		const imageUrl = `/character-images/${filename}`;

		// Persist on the player record so other clients can see it
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

// === CHARACTER EXPORT — sign sheet with private key ===
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

// === CHARACTER IMPORT — verify signature, return sheet ===
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

const PORT = process.env.PORT || 3000;

// === STARTUP: Validate API keys and log results ===
async function validateServices() {
	log("🔑 Validating API keys...");

	// LLM providers
	const llm = await validateLLMKeys();
	serviceStatus.openai = llm.openai.ok;
	serviceStatus.claude = llm.claude.ok;

	if (llm.openai.ok)  log("  ✅ OpenAI API key is valid");
	else                 log(`  ❌ OpenAI: ${llm.openai.error}`);

	if (llm.claude.ok)  log("  ✅ Claude API key is valid");
	else                 log(`  ❌ Claude: ${llm.claude.error}`);

	// ElevenLabs
	if (!ELEVEN_API_KEY) {
		log("  ❌ ElevenLabs: No API key configured");
	} else if (devMode) {
		log("  ⏭️  ElevenLabs: Skipped (dev mode)");
		serviceStatus.elevenlabs = true; // key exists, just suppressed
	} else {
		try {
			const voices = await fetchVoices();
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

	// Summary
	const active = [
		serviceStatus.openai && "OpenAI",
		serviceStatus.claude && "Claude",
		serviceStatus.elevenlabs && "ElevenLabs",
	].filter(Boolean);
	log(`🟢 Active services: ${active.length ? active.join(", ") : "none (stub mode)"}`);
}

// === STARTUP: Validate config JSON files ===
function validateConfigFiles() {
	log("📋 Validating config files...");
	const configDir = path.join(__dirname, "..", "client", "config");

	const configs = [
		{
			file: "armor.json",
			check: (d) => {
				if (!Array.isArray(d)) return "Expected an array";
				if (!d.length) return "Array is empty";
				const missing = [];
				if (!d[0].name) missing.push("name");
				if (d[0].ac === undefined) missing.push("ac");
				if (!d[0].classes) missing.push("classes");
				if (missing.length) return `First entry missing: ${missing.join(", ")}`;
				return null;
			},
		},
		{
			file: "weapons.json",
			check: (d) => {
				if (!Array.isArray(d)) return "Expected an array";
				if (!d.length) return "Array is empty";
				const missing = [];
				if (!d[0].name) missing.push("name");
				if (!d[0].damage) missing.push("damage");
				if (!d[0].classes) missing.push("classes");
				if (missing.length) return `First entry missing: ${missing.join(", ")}`;
				return null;
			},
		},
		{
			file: "raceNames.json",
			check: (d) => {
				if (typeof d !== "object" || Array.isArray(d)) return "Expected an object keyed by race";
				const races = Object.keys(d);
				if (!races.length) return "No races defined";
				const first = d[races[0]];
				if (!first.male_first || !first.female_first || !first.last)
					return `Race "${races[0]}" missing male_first, female_first, or last`;
				return null;
			},
		},
		{
			file: "campaignFlavors.json",
			check: (d) => {
				if (typeof d !== "object") return "Expected an object";
				if (!Array.isArray(d.tones) || !d.tones.length) return "Missing or empty 'tones' array";
				if (!Array.isArray(d.themes) || !d.themes.length) return "Missing or empty 'themes' array";
				const t = d.tones[0];
				if (!t.id || !t.label || !t.prompt) return "First tone missing id, label, or prompt";
				return null;
			},
		},
		{
			file: "library.json",
			check: (d) => {
				if (typeof d !== "object") return "Expected an object";
				if (!d.moods || typeof d.moods !== "object") return "Missing 'moods' object";
				if (!Object.keys(d.moods).length) return "'moods' object is empty";
				if (!Array.isArray(d.songs)) return "Missing 'songs' array";
				if (d.songs.length) {
					const s = d.songs[0];
					if (!s.file || !s.title || !Array.isArray(s.tags))
						return "First song missing file, title, or tags";
				}
				return null;
			},
		},
		{
			file: "classProgression.json",
			check: (d) => {
				if (typeof d !== "object" || Array.isArray(d)) return "Expected an object keyed by class name";
				const classes = Object.keys(d);
				if (!classes.length) return "No classes defined";
				const first = d[classes[0]];
				const levels = Object.keys(first);
				if (!levels.length) return `Class "${classes[0]}" has no level entries`;
				const entry = first[levels[0]];
				if (!Array.isArray(entry) || !entry.length) return `Class "${classes[0]}" level ${levels[0]} should be a non-empty array`;
				if (!entry[0].name || !entry[0].description) return `First ability in "${classes[0]}" missing name or description`;
				return null;
			},
		},
	];

	let allOk = true;
	for (const { file, check } of configs) {
		const filePath = path.join(configDir, file);
		try {
			if (!fs.existsSync(filePath)) {
				log(`  ❌ ${file}: File not found`);
				allOk = false;
				continue;
			}
			const raw = fs.readFileSync(filePath, "utf8");
			let data;
			try {
				data = JSON.parse(raw);
			} catch (parseErr) {
				log(`  ❌ ${file}: Invalid JSON — ${parseErr.message}`);
				allOk = false;
				continue;
			}
			const problem = check(data);
			if (problem) {
				log(`  ⚠️  ${file}: ${problem}`);
				allOk = false;
			} else {
				const keys = Object.keys(data);
				const size = Array.isArray(data) ? `${data.length} entries`
					: data.songs ? `${Object.keys(data.moods).length} moods, ${data.songs.length} songs`
					: data.tones ? `${data.tones.length} tones, ${data.themes.length} themes`
					: file === "classProgression.json" ? `${keys.length} classes`
					: `${keys.length} entries`;
				log(`  ✅ ${file} (${size})`);
			}
		} catch (err) {
			log(`  ❌ ${file}: ${err.message}`);
			allOk = false;
		}
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
