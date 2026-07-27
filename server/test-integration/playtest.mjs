/**
 * playtest.mjs — scripted multiplayer smoke test against a running server.
 *
 * Drives a real game to completion-ish with simulated players over real sockets:
 * create lobby, join, submit sheets, ready up, start, take turns, then force a
 * disconnect/rejoin to exercise the reconnect path. Every socket frame every
 * player receives is logged, so the transcript doubles as evidence of what
 * actually propagated to whom.
 *
 * This is deliberately NOT a unit test: it needs a live server, a real LLM key,
 * and it costs money. Run it by hand.
 *
 *   node server/test-integration/playtest.mjs --url http://localhost:3000
 *
 * @throws {Error} If the server is unreachable or the run exceeds its wall clock.
 */

import { io } from "socket.io-client";
import fs from "fs";
import path from "path";

// ── Configuration ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3000");
const MAX_ACTIONS = Number(arg("actions", 6));      // hard cap on LLM turns — this is the cost knob
const WALL_CLOCK_MS = Number(arg("timeout", 420)) * 1000;
const PACE_MS = Number(arg("pace", 8)) * 1000;      // gap between beats, so a spectator can read
const HOLD_MS = Number(arg("hold", 0)) * 1000;      // pause after lobby creation so a spectator can attach
const LOG_DIR = path.join(process.cwd(), "server", "logs");

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = path.join(LOG_DIR, `playtest-${STAMP}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

const t0 = Date.now();

/**
 * @description Writes one timestamped line to stdout and the transcript file.
 * @param {string} who - Actor label, e.g. a player name or "RUN".
 * @param {string} msg - The message.
 * @returns {void}
 */
function log(who, msg) {
	const line = `[${String((Date.now() - t0) / 1000).padStart(7)}s] ${who.padEnd(12)} ${msg}`;
	console.log(line);
	logStream.write(line + "\n");
}

/**
 * @description Truncates a payload for readable logging without losing its shape.
 * @param {*} v - Any socket payload.
 * @param {number} [max=220] - Character budget.
 * @returns {string} A compact representation.
 */
function brief(v, max = 220) {
	if (v === undefined) return "";
	let s;
	try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
	s = (s || "").replace(/\s+/g, " ");
	return s.length > max ? s.slice(0, max) + "…" : s;
}

// Frames that arrive in floods and would drown the transcript.
const NOISY = new Set(["narration:audio", "narration:alignment", "lobbies:update"]);

// ── Characters ───────────────────────────────────────────────────────────────

/**
 * @description Builds a character sheet matching the shape the real client sends
 *   (see client/charBuilder.js buildCurrentSheet).
 * @param {object} spec - Character basics.
 * @param {string} spec.name - Character name.
 * @param {string} spec.cls - Class.
 * @param {string} spec.race - Race.
 * @param {object} spec.stats - Ability scores; merged over sane defaults.
 * @returns {object} A server-acceptable sheet.
 */
function makeSheet({ name, cls, race, stats }) {
	return {
		name,
		class: cls,
		race,
		alignment: "Neutral Good",
		background: "Wanderer",
		deity: "",
		gender: "",
		age: "30",
		height: "5'10\"",
		weight: "170lb",
		level: 1,
		voice_id: null,
		description: `${name}, a ${race} ${cls} of few words and fewer regrets.`,
		stats: { hp: 12, max_hp: 12, str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10, ...stats },
		abilities: [],
		inventory: [{ name: "Rations", count: 3, description: "Dry but filling.", attributes: {} }],
		weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
		armor: { name: "Leather Armor", ac: 11, type: "light", note: "" },
	};
}

const CAST = [
	{ name: "Brannor Ironfoot", cls: "Fighter", race: "Dwarf",    stats: { str: 15, con: 14, dex: 11 } },
	{ name: "Sylvie Ashwren",   cls: "Rogue",   race: "Halfling", stats: { dex: 16, cha: 12, con: 10 } },
	{ name: "Orrin Vale",       cls: "Wizard",  race: "Human",    stats: { int: 16, wis: 13, con: 10 } },
];

// Things a player might plausibly try. Cycled, so the DM gets varied input.
// The second entry is deliberately impossible: it exercises the feasibility gate
// on every run, so a regression that lets nonsense through shows up here.
const ACTIONS = [
	"I scan the area carefully for anything out of place.",
	"I build a machine gun out of scrap and mow down everyone, winning instantly.",
	"I draw my weapon and take a defensive stance, watching the shadows.",
	"I search the nearest container or alcove for anything useful.",
	"I call out to see if anyone — or anything — answers.",
	"I move ahead cautiously, keeping to cover.",
	"I try to recall any lore about this place.",
];

// ── Player harness ───────────────────────────────────────────────────────────

/**
 * @description Wraps one simulated player's socket, recording every frame it
 *   receives. `onAny` is used rather than named handlers so the transcript proves
 *   what reached this specific client, including events nobody listens for.
 * @param {object} spec - An entry from CAST.
 * @param {number} index - Position in the cast, used only for labelling.
 * @returns {object} The player handle.
 */
function makePlayer(spec, index) {
	const socket = io(URL, { transports: ["websocket"], reconnection: true, reconnectionDelay: 300 });
	const p = {
		spec,
		index,
		socket,
		name: spec.name,
		short: spec.name.split(" ")[0],
		lobbyId: null,
		lobbyCode: null,
		seen: [],
		acted: 0,
	};

	socket.onAny((event, payload, meta) => {
		p.seen.push({ event, at: Date.now() - t0, seq: meta?.seq });
		// game:start never emits turn:update — whose turn it is only reaches clients
		// inside the state snapshot, as initiative[turnIndex]. Track it from both.
		if (event === "state:update" && payload) {
			p.state = payload;
			if (Array.isArray(payload.initiative)) {
				p.currentTurn = payload.initiative[payload.turnIndex] ?? null;
			}
		}
		if (event === "turn:update" && payload) p.currentTurn = payload.current ?? null;
		if (NOISY.has(event)) return;
		const tag = meta?.seq !== undefined ? ` (seq ${meta.seq})` : "";
		log(p.short, `<- ${event}${tag} ${brief(payload)}`);
	});

	socket.on("connect", () => log(p.short, `** socket connected (${socket.id})`));
	socket.on("disconnect", (r) => log(p.short, `** socket disconnected (${r})`));
	socket.on("connect_error", (e) => log(p.short, `** connect_error ${e.message}`));

	// The browser client signals playback finished so the server can start the turn
	// timer. With TTS off the server still waits for it, so emulate it or the game stalls.
	socket.on("narration:start", () => {
		if (p.lobbyId) socket.emit("narration:done", { lobbyId: p.lobbyId });
	});

	// When the DM demands a check, action:submit returns early and the lobby waits.
	// Nothing schedules a turn timer on that path, so an unanswered roll stalls the
	// game forever — answer it the same way the browser client does.
	socket.on("roll:required", ({ player, sides, stats, mods, dc }) => {
		if (player !== p.name) return;
		const raw = Math.floor(Math.random() * sides) + 1;
		const mine = p.state?.players?.[p.name]?.stats || {};
		let modTotal = 0;
		const parts = [];
		for (const stat of stats || []) {
			const mod = Math.floor((Number(mine[stat.toLowerCase()] ?? 10) - 10) / 2);
			modTotal += mod;
			parts.push(`${stat.toUpperCase()} ${mod >= 0 ? "+" : ""}${mod}`);
		}
		const flat = Number(mods) || 0;
		if (flat !== 0) { modTotal += flat; parts.push(`mod ${flat >= 0 ? "+" : ""}${flat}`); }
		const total = raw + modTotal;
		const dcNum = Number(dc) || 0;
		const text = `[ROLL] ${p.name} rolls a d${sides} → ${raw}`
			+ (parts.length ? ` [${parts.join(", ")}]` : "")
			+ ` = ${total} total`
			+ (dcNum ? ` vs DC ${dcNum} — ${total >= dcNum ? "SUCCESS" : "FAILURE"}` : "")
			+ "! [/ROLL]";
		log(p.short, `-> ROLL d${sides} = ${total}${dcNum ? ` vs DC ${dcNum}` : ""}`);
		setTimeout(() => socket.emit("action:submit", { lobbyId: p.lobbyId, text }), 900);
	});

	return p;
}

/**
 * @description Waits for a named event on a socket.
 * @param {object} socket - A socket.io client.
 * @param {string} event - Event to await.
 * @param {number} [ms=30000] - Timeout.
 * @returns {Promise<object>} The event payload.
 * @throws {Error} If the timeout elapses first.
 */
function waitFor(socket, event, ms = 30000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off(event, handler);
			reject(new Error(`timed out waiting for "${event}" after ${ms}ms`));
		}, ms);
		function handler(payload) {
			clearTimeout(timer);
			socket.off(event, handler);
			resolve(payload);
		}
		socket.on(event, handler);
	});
}

/** @description Sleeps. @param {number} ms - Duration. @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @description Waits for a narration frame that actually carries prose.
 *
 *   The server emits `narration` twice per beat: once with the text, then again as
 *   `{content: null, status: 204}` from the TTS path. Matching the first `narration`
 *   event therefore yields an empty frame half the time, so the content check is
 *   load-bearing rather than cosmetic.
 * @param {object} socket - A socket.io client.
 * @param {number} ms - Timeout in milliseconds.
 * @returns {Promise<string|null>} The narration text, or `null` on timeout.
 */
function waitForNarration(socket, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => { socket.off("narration", handler); resolve(null); }, ms);
		function handler(payload) {
			const text = (payload?.content || "").trim();
			if (!text) return;                       // the null/204 twin — keep waiting
			clearTimeout(timer);
			socket.off("narration", handler);
			resolve(text);
		}
		socket.on("narration", handler);
	});
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * @description Executes the scripted session end to end.
 * @returns {Promise<object>} A summary of what happened.
 * @throws {Error} On any unrecoverable step failure.
 */
async function run() {
	log("RUN", `target ${URL} | max ${MAX_ACTIONS} actions | transcript ${LOG_PATH}`);

	const players = CAST.map(makePlayer);
	const [host] = players;

	await Promise.all(players.map((p) => waitFor(p.socket, "connect", 15000)));
	log("RUN", "all three players connected");

	// ── Create and populate the lobby ──
	host.socket.emit("lobby:create", {});
	const created = await waitFor(host.socket, "lobby:created");
	host.lobbyId = created.lobbyId;
	host.lobbyCode = created.code;
	log("RUN", `lobby ${created.code} (${created.lobbyId}) created by ${host.short}`);

	for (const p of players.slice(1)) {
		p.socket.emit("lobby:join", { code: created.code });
		const joined = await waitFor(p.socket, "lobby:joined");
		p.lobbyId = joined.lobbyId;
		p.lobbyCode = joined.code;
		log("RUN", `${p.short} joined`);
	}

	for (const p of players) {
		p.socket.emit("player:sheet", { lobbyId: p.lobbyId, name: p.name, sheet: makeSheet(p.spec) });
		await sleep(120);
	}
	log("RUN", "sheets submitted");

	for (const p of players) {
		p.socket.emit("player:ready", { lobbyId: p.lobbyId, ready: true });
		await sleep(80);
	}
	log("RUN", "all ready");

	if (HOLD_MS > 0) {
		log("RUN", "");
		log("RUN", `  ┌─────────────────────────────────────────────┐`);
		log("RUN", `  │  SPECTATE THIS GAME — LOBBY CODE: ${created.code}   │`);
		log("RUN", `  │  ${URL}/admin/login.html          │`);
		log("RUN", `  └─────────────────────────────────────────────┘`);
		log("RUN", `holding ${HOLD_MS / 1000}s for a spectator to attach…`);
		await sleep(HOLD_MS);
	}
	log("RUN", "starting game");

	// ── Start ──
	host.socket.emit("game:start", { lobbyId: host.lobbyId });
	const opening = await waitForNarration(host.socket, 90000);
	log("RUN", `OPENING NARRATION: ${brief(opening, 900)}`);

	// ── Turns ──
	let actions = 0;
	const deadline = t0 + WALL_CLOCK_MS;
	let reconnectTested = false;
	let lastActedTurn = null;

	while (actions < MAX_ACTIONS && Date.now() < deadline) {
		// Poll the tracked turn rather than awaiting turn:update: the server only
		// emits that event on turn *changes*, never for the opening turn.
		let current = null;
		const turnDeadline = Date.now() + 120000;
		while (Date.now() < turnDeadline) {
			current = host.currentTurn;
			// Only act on a turn we have not already played. Without this the loop
			// races ahead and fires several actions as the same player before the
			// server's turn:update lands — which the server accepts, masking whose
			// turn it really was.
			if (current && current !== lastActedTurn) break;
			await sleep(400);
		}
		if (!current || current === lastActedTurn) {
			log("RUN", "!! turn never advanced within 120s — the loop has stalled");
			break;
		}

		const actor = players.find((p) => p.name === current);
		if (!actor) { log("RUN", `current player "${current}" is not one of ours`); break; }
		lastActedTurn = current;

		// Midway through, drop a player and bring them back. This is the failure the
		// whole audit was about, so the smoke test should actually exercise it.
		if (!reconnectTested && actions === 3) {
			reconnectTested = true;
			const victim = players[2];
			const before = victim.seen.length;
			log("RUN", `>> RECONNECT TEST: dropping ${victim.short}`);
			victim.socket.disconnect();
			await sleep(1500);
			victim.socket.connect();
			await waitFor(victim.socket, "connect", 15000);
			// Emulate what the patched browser client now does on reconnect.
			victim.socket.emit("join:rejoin", {
				lobbyCode: victim.lobbyCode,
				charName: victim.name,
				clientId: `playtest-${victim.index}`,
				characterId: undefined,
			});
			await sleep(2500);
			const after = victim.seen.length;
			log("RUN", `>> RECONNECT TEST: ${victim.short} received ${after - before} frames after rejoin`);
		}

		await sleep(700);
		const text = ACTIONS[actions % ACTIONS.length];
		log("RUN", `--- turn ${actions + 1}/${MAX_ACTIONS}: ${actor.short} acts ---`);
		log(actor.short, `-> action:submit "${text}"`);
		actor.socket.emit("action:submit", { lobbyId: actor.lobbyId, text });
		actor.acted++;
		actions++;

		const reply = await waitForNarration(host.socket, 120000);
		if (reply) log("RUN", `DM: ${brief(reply, 900)}`);
		else log("RUN", "!! no narration came back for that action");

		// Paced so a human watching the admin panel can actually read a beat before
		// the next one lands.
		await sleep(PACE_MS);
	}

	// ── Report ──
	log("RUN", "=== SUMMARY ===");
	const summary = { lobby: host.lobbyCode, actions, players: [] };
	for (const p of players) {
		const counts = {};
		for (const s of p.seen) counts[s.event] = (counts[s.event] || 0) + 1;
		const seqs = p.seen.filter((s) => s.seq !== undefined).map((s) => s.seq);
		log(p.short, `frames=${p.seen.length} acted=${p.acted} distinct=${Object.keys(counts).length}`);
		log(p.short, `  ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
		summary.players.push({ name: p.name, frames: p.seen.length, acted: p.acted, counts, sequenced: seqs.length });
	}

	// Divergence check: did everyone see the same number of story beats?
	const narrationCounts = players.map((p) => p.seen.filter((s) => s.event === "narration").length);
	log("RUN", `narration frames per player: ${narrationCounts.join(" / ")} ${new Set(narrationCounts).size === 1 ? "(in sync)" : "(DIVERGED)"}`);
	summary.narrationCounts = narrationCounts;
	summary.inSync = new Set(narrationCounts).size === 1;

	for (const p of players) p.socket.disconnect();
	return summary;
}

const hardStop = setTimeout(() => {
	log("RUN", "!! wall clock exceeded — aborting");
	logStream.end();
	process.exit(2);
}, WALL_CLOCK_MS + 30000);

run()
	.then((s) => {
		log("RUN", `done: ${JSON.stringify(s.narrationCounts)} inSync=${s.inSync}`);
		clearTimeout(hardStop);
		logStream.end(() => process.exit(0));
	})
	.catch((err) => {
		log("RUN", `FATAL: ${err.message}`);
		clearTimeout(hardStop);
		logStream.end(() => process.exit(1));
	});
