/**
 * Attaches as an admin and reports every game event the panel receives.
 *
 * @description Proves the admin activity feed actually receives live game traffic,
 *   rather than assuming it because the handlers exist. Mirrors what
 *   `client/admin/admin.js` subscribes to, so a gap here is a gap in the panel.
 *
 *   node server/test-integration/admin-watch.mjs <url> <lobbyCode> <adminPassword>
 */

import { io } from "socket.io-client";
import crypto from "crypto";

const URL = process.argv[2] || "http://localhost:3077";
const CODE = process.argv[3];
const PASSWORD = process.argv[4];
const RUN_FOR_MS = Number(process.argv[5] ?? 120) * 1000;

/**
 * @description Completes the challenge-response admin login.
 * @returns {Promise<string>} The `admin_token` cookie value.
 * @throws {Error} If either leg fails.
 */
async function login() {
	const res1 = await fetch(`${URL}/api/admin/challenge`);
	if (!res1.ok) throw new Error(`challenge failed: ${res1.status}`);
	const { nonce } = await res1.json();
	const hash = crypto.createHash("sha256").update(PASSWORD + nonce).digest("hex");
	const res2 = await fetch(`${URL}/api/admin/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ nonce, hash }),
	});
	if (!res2.ok) throw new Error(`login failed: ${res2.status}`);
	const token = (res2.headers.get("set-cookie") || "").match(/admin_token=([^;]+)/)?.[1];
	if (!token) throw new Error("no admin_token returned");
	return token;
}

const token = await login();
const socket = io(URL, { transports: ["websocket"], extraHeaders: { Cookie: `admin_token=${token}` } });

// Exactly what client/admin/admin.js listens for.
const PANEL_EVENTS = [
	"narration", "turn:update", "hp:update", "xp:update", "gold:update",
	"conditions:update", "inventory:update", "spellslots:update", "abilities:update",
	"player:death", "dice:result", "roll:required", "music:change", "sfx:play",
	"state:update", "toast", "rest:vote:start", "rest:vote:result", "game:over",
	"turn:skipped", "player:reconnecting", "player:left",
];

const counts = new Map();
const t0 = Date.now();

socket.on("connect", () => {
	console.log("admin socket connected; joining lobby");
	socket.emit("admin:connect", { code: CODE });
});

socket.on("admin:connected", (state) => {
	console.log(`ADMIN CONNECTED to ${state.code} — ${Object.keys(state.players || {}).length} players, phase ${state.phase}\n`);
});

for (const ev of PANEL_EVENTS) {
	socket.on(ev, (payload) => {
		counts.set(ev, (counts.get(ev) ?? 0) + 1);
		const at = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
		let brief = "";
		try { brief = JSON.stringify(payload).replace(/\s+/g, " ").slice(0, 110); } catch { brief = String(payload); }
		console.log(`[${at}s] ${ev.padEnd(20)} ${brief}`);
	});
}

socket.on("admin:incident", (i) => console.log(`[INCIDENT] ${i.severity} ${i.kind}: ${i.message}`));

setTimeout(() => {
	console.log(`\n=== WHAT THE ADMIN PANEL RECEIVED IN ${RUN_FOR_MS / 1000}s ===`);
	if (!counts.size) {
		console.log("  NOTHING — the panel would have shown an empty feed.");
	} else {
		for (const [ev, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${ev.padEnd(22)} ${n}`);
	}
	socket.disconnect();
	process.exit(0);
}, RUN_FOR_MS);
