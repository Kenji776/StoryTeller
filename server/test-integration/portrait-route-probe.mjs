/**
 * Drives the portrait route the way the browser does.
 *
 * @description The operator reported the button producing nothing, and no request
 *   for a portrait appeared in any server log. That leaves two possibilities — the
 *   browser never sent one, or it went somewhere else — and neither can be settled
 *   by reading the code. This creates a real lobby over a socket, saves a sheet, and
 *   POSTs to `/api/character-image` exactly as the client does, so the server half is
 *   either proven or the failure is named.
 *
 *   node server/test-integration/portrait-route-probe.mjs [url]
 */

import { io } from "socket.io-client";

const URL = process.argv[2] || "http://localhost:3077";
const NAME = "Probe Dwarf";

const socket = io(URL, { transports: ["websocket"] });

/**
 * @description Waits for one named event.
 * @param {string} event - Event name.
 * @param {number} [ms] - Timeout.
 * @returns {Promise<object>} The payload.
 * @throws {Error} On timeout.
 */
const once = (event, ms = 10000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
	socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

await once("connect");
console.log("connected");

socket.emit("lobby:create", {});
const lobby = await once("lobby:created");
console.log(`lobby ${lobby.code} (${lobby.lobbyId})`);

const sheet = {
	name: NAME, race: "Dwarf", class: "Fighter", level: 1, gender: "male",
	age: "90", height: "4ft 6in", weight: "170lb", alignment: "Lawful Good",
	background: "Soldier", description: "A blunt nose and a shaved head.",
	stats: { hp: 12, max_hp: 12, str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
	weapon: { name: "Battleaxe" }, armor: { name: "Chain Mail", ac: 16 },
};
socket.emit("player:sheet", { lobbyId: lobby.lobbyId, name: NAME, sheet });
await new Promise((r) => setTimeout(r, 500));

const { buildPortraitPrompt } = await import("../../client/portraitPrompt.js");
const prompt = `${buildPortraitPrompt(sheet)} In an epic pose.`;
console.log(`prompt (${prompt.length} chars): ${prompt.slice(0, 120)}…`);

const started = Date.now();
const res = await fetch(`${URL}/api/character-image`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ lobbyId: lobby.lobbyId, playerName: NAME, sheet, prompt }),
});

const body = await res.json().catch(() => ({}));
console.log(`\nHTTP ${res.status} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(body).slice(0, 300));

socket.disconnect();
process.exit(res.ok && body.url ? 0 : 1);
