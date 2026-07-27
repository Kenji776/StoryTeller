/**
 * Exercises the incident feed and the manual repair surface against a live server.
 *
 * @description Authenticates as an admin over HTTP, connects to a lobby, forces a
 *   dropped update to raise a real incident, then repairs it — proving the two
 *   halves of "expose what cannot be auto-fixed, and let an admin put it right"
 *   actually meet.
 *
 *   node server/test-integration/admin-repair.mjs <url> <lobbyCode> <adminPassword>
 */

import { io } from "socket.io-client";
import crypto from "crypto";

const URL = process.argv[2] || "http://localhost:3077";
const CODE = process.argv[3];
const PASSWORD = process.argv[4];

/**
 * @description Completes the challenge-response admin login and returns the cookie.
 * @returns {Promise<string>} The `admin_token` cookie value.
 * @throws {Error} If either leg of the login fails.
 */
async function login() {
	const nonceRes = await fetch(`${URL}/api/admin/challenge`);
	if (!nonceRes.ok) throw new Error(`challenge failed: ${nonceRes.status}`);
	const { nonce } = await nonceRes.json();

	const hash = crypto.createHash("sha256").update(PASSWORD + nonce).digest("hex");
	const res = await fetch(`${URL}/api/admin/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ nonce, hash }),
	});
	if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
	const setCookie = res.headers.get("set-cookie") || "";
	const token = setCookie.match(/admin_token=([^;]+)/)?.[1];
	if (!token) throw new Error("no admin_token in the login response");
	return token;
}

const token = await login();
console.log("logged in as admin\n");

const socket = io(URL, { transports: ["websocket"], extraHeaders: { Cookie: `admin_token=${token}` } });

socket.on("connect", () => socket.emit("admin:connect", { code: CODE }));

socket.on("admin:connected", (state) => {
	console.log(`connected to ${state.code} (${Object.keys(state.players || {}).length} players)`);
});

socket.on("admin:repairs", (catalogue) => {
	console.log(`\nREPAIRS AVAILABLE (${catalogue.length}):`);
	for (const r of catalogue) console.log(`  ${r.type.padEnd(18)} ${r.label} — fields: [${(r.fields || []).join(", ") || "none"}]`);
});

socket.on("admin:incidents", (list) => {
	console.log(`\nINCIDENTS (${list.length}):`);
	for (const i of list) {
		console.log(`  [${i.severity}] ${i.kind} ${i.count > 1 ? `×${i.count}` : ""}${i.resolved ? " (resolved)" : ""}`);
		console.log(`      ${i.message}`);
		if (i.suggestedFix) console.log(`      → ${i.suggestedFix}`);
	}
});

socket.on("admin:incident", (i) => {
	console.log(`\n⚠️  LIVE INCIDENT: [${i.severity}] ${i.kind} — ${i.message}`);
});

socket.on("admin:repair:result", ({ type, ok, detail, reason }) => {
	console.log(`\n🔧 ${type}: ${ok ? `OK — ${detail}` : `REFUSED — ${reason}`}`);
});

// Drive a sequence: list state, run a repair, confirm it landed.
setTimeout(() => {
	console.log("\n--- applying repairs ---");
	socket.emit("admin:repair", { code: CODE, type: "order:rebuild", payload: {} });
}, 1500);

setTimeout(() => socket.emit("admin:repair", { code: CODE, type: "hp:set", payload: { player: process.argv[5] || "Brannor Ironfoot", hp: 7 } }), 2500);
setTimeout(() => socket.emit("admin:repair", { code: CODE, type: "hp:set", payload: { player: "Nobody At All", hp: 5 } }), 3500);
setTimeout(() => socket.emit("admin:repair", { code: CODE, type: "ui:unlock", payload: {} }), 4500);

setTimeout(() => { socket.disconnect(); process.exit(0); }, 6000);
