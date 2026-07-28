/**
 * Functional probe: does the wired server actually grant loot in a real game?
 *
 * @description `loot-probe.mjs` drives the prompt and the engine directly. This
 *   drives `server.js` — the part no unit test covers, because the game loop is
 *   untested legacy — over real sockets: create a lobby, start a game, and take a
 *   looting turn. It reports the frames a browser would have received, so a reward
 *   that was rolled but never reached the player is visible.
 *
 *   Costs two real DM calls (the opening scene and one turn).
 *
 *     npm run dev
 *     node server/test-integration/loot-e2e-probe.mjs --url http://localhost:3013
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");
const PROVIDER = arg("provider", "anthropic");
const MODEL = arg("model", "claude-sonnet-4-6");
const ACTION = arg("action", "I search the fallen bandits for coin and anything else worth taking.");

/**
 * @description Resolves with the next payload for an event, or rejects on timeout.
 * @param {object} socket - A socket.io client.
 * @param {string} event - The event to await.
 * @param {number} [ms=60000] - How long to wait; a DM call is slow.
 * @returns {Promise<object>} The payload.
 * @throws {Error} When the event does not arrive in time.
 */
function waitFor(socket, event, ms = 60000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
		socket.once(event, (payload) => {
			clearTimeout(timer);
			resolve(payload);
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHEET = {
	name: "Sylvie Ashwren",
	class: "Rogue",
	race: "Halfling",
	alignment: "Neutral Good",
	background: "Wanderer",
	level: 3,
	description: "Quick hands, quicker exits.",
	stats: { hp: 21, max_hp: 21, str: 8, dex: 16, con: 12, int: 12, wis: 12, cha: 14 },
	abilities: [{ name: "Sneak Attack", description: "Extra damage with advantage.", details: {} }],
	inventory: [{ name: "Thieves' Tools", count: 1, description: "Picks and tension bars.", attributes: { item_type: "trinket" } }],
	weapon: { name: "Dagger", damage: "1d4", damageType: "piercing", range: "melee" },
	armor: { name: "Leather Armor", ac: 11, type: "light", note: "" },
};

const socket = io(URL, { transports: ["websocket"] });
const frames = [];
for (const event of ["inventory:update", "gold:update", "narration", "toast"]) {
	socket.on(event, (payload) => frames.push({ event, payload }));
}

await waitFor(socket, "connect", 15000);

socket.emit("lobby:create", {});
const created = await waitFor(socket, "lobby:created");
const lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId})`);

socket.emit("player:sheet", { lobbyId, name: SHEET.name, sheet: SHEET });
await sleep(300);

socket.emit("lobby:settings", {
	lobbyId, timerEnabled: false, lootGenerosity: "generous",
	difficulty: "standard", brutalityLevel: 5, illustrationMode: "off",
	llmProvider: PROVIDER, llmModel: MODEL,
});
await sleep(300);

socket.emit("player:ready", { lobbyId, ready: true });
await sleep(200);

console.log("starting the game (one DM call)…");
socket.emit("game:start", { lobbyId });
await waitFor(socket, "narration");
await sleep(1500);

console.log(`taking a looting turn: "${ACTION}"`);
frames.length = 0;
socket.emit("action:submit", { lobbyId, text: ACTION });
await sleep(35000);

console.log(`\n── frames a browser would have received ${"─".repeat(24)}`);
let grantedItems = 0;
let grantedGold = 0;
for (const { event, payload } of frames) {
	if (event === "inventory:update") {
		grantedItems++;
		console.log(`   inventory:update   ${payload.item} ${payload.change > 0 ? "+" : ""}${payload.change} → ${payload.newCount}`);
		console.log(`                      ${JSON.stringify(payload.attributes)}`);
	} else if (event === "gold:update") {
		grantedGold += Number(payload.delta) || 0;
		console.log(`   gold:update        ${payload.player} ${payload.delta > 0 ? "+" : ""}${payload.delta} → ${payload.gold} (${payload.reason || "no reason"})`);
	} else if (event === "narration") {
		console.log(`   narration          "${String(payload.content || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").slice(0, 200)}…"`);
	}
}

console.log(`\n══ result ${"═".repeat(50)}`);
console.log(`   the turn completed and the room was told about it : ${frames.some((f) => f.event === "narration") ? "yes" : "NO"}`);
console.log(`   inventory frames: ${grantedItems}   gold granted: ${grantedGold}`);
console.log(`   (a "nothing" roll is a correct outcome here — check the server log for the 💰 line)`);

socket.close();
process.exit(frames.some((f) => f.event === "narration") ? 0 : 1);
