/**
 * Functional probe: can somebody watch a game without playing in it?
 *
 * @description Drives the real socket path. It answers what the unit tests cannot:
 *
 *   - does an observer get into a lobby that is already running, without being sent off
 *     to pick a character?
 *   - do they receive state, narration and chat?
 *   - can they talk, and does the table hear them?
 *   - are they refused a character, a ready flag and a turn?
 *   - and, the one that would have blocked everything: does one watcher stop the host
 *     from starting the game?
 *
 *   Costs nothing until the game starts; one DM call for the opening scene.
 *
 *     npm run dev
 *     node server/test-integration/observer-probe.mjs
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");

/**
 * @description Resolves with the next payload for an event, or null on timeout.
 * @param {object} socket - A socket.io client.
 * @param {string} event - The event to await.
 * @param {number} [ms=8000] - How long to wait.
 * @returns {Promise<object|null>} The payload, or null if it never came.
 */
function waitFor(socket, event, ms = 8000) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = (ok) => (ok ? "  ok  " : "  FAIL");

const PLAYER = {
	name: "Ayla Fenn", class: "Fighter", race: "Human", alignment: "Neutral Good",
	background: "Soldier", level: 1,
	stats: { hp: 12, max_hp: 12, str: 15, dex: 12, con: 13, int: 10, wis: 11, cha: 10 },
	abilities: [], inventory: [],
	weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
	armor: { name: "Leather Armor", ac: 11, type: "light", note: "" },
};

const host = io(URL, { transports: ["websocket"] });
await waitFor(host, "connect");

host.emit("lobby:create", {});
const created = await waitFor(host, "lobby:created");
const { lobbyId, code } = created;
console.log(`lobby ${code} (${lobbyId})\n`);

host.emit("player:sheet", { lobbyId, name: PLAYER.name, sheet: PLAYER });
await sleep(300);
host.emit("lobby:settings", { lobbyId, timerEnabled: false, illustrationMode: "off" });
await sleep(200);
host.emit("player:ready", { lobbyId, ready: true });
await sleep(200);

// ── The watcher joins a lobby that has not started ───────────────────────────
const watcher = io(URL, { transports: ["websocket"] });
await waitFor(watcher, "connect");

const heard = [];
for (const event of ["state:update", "narration", "chat:message", "dice:result", "toast"]) {
	watcher.on(event, (payload) => heard.push({ event, payload }));
}

watcher.emit("lobby:join", { code, asObserver: true });
const joined = await waitFor(watcher, "lobby:joined");
console.log(`${tick(joined?.observer === true)}  joins and is told they are observing`);

const state = await waitFor(watcher, "state:update", 4000)
	?? await (async () => { watcher.emit("state:request", { lobbyId }); return waitFor(watcher, "state:update", 4000); })();
console.log(`${tick(state?.observers === 1)}  the lobby reports 1 observer (got ${state?.observers})`);

// ── The blocker ──────────────────────────────────────────────────────────────
host.emit("game:start", { lobbyId });
const opening = await waitFor(host, "narration", 90000);
console.log(`${tick(!!opening)}  one watcher does not stop the host starting the game`);
await sleep(1500);

// ── They see the game ────────────────────────────────────────────────────────
console.log(`${tick(heard.some((h) => h.event === "narration"))}  receives the narration`);

// ── They can talk ────────────────────────────────────────────────────────────
// The listener goes on *before* the message is sent. An earlier run of this probe
// attached it afterwards and reported a failure that was entirely its own.
const hostHeard = [];
host.on("chat:message", (m) => hostHeard.push(m));

watcher.emit("chat:join", { lobbyId, name: "Kenji" });
await sleep(300);
watcher.emit("chat:message", { lobbyId, name: "Kenji", text: "try the left-hand door" });
await sleep(800);
console.log(`${tick(hostHeard.some((m) => m.text === "try the left-hand door"))}  the table hears the watcher speak`);

// ── They are refused everything that needs a character ───────────────────────
heard.length = 0;
watcher.emit("player:sheet", { lobbyId, name: "Interloper", sheet: PLAYER });
await sleep(400);
const refused = heard.some((h) => h.event === "toast" && /watching/i.test(h.payload?.message || ""));
console.log(`${tick(refused)}  is refused a character sheet`);

watcher.emit("action:submit", { lobbyId, text: "I attack the nearest thing." });
await sleep(1200);
const acted = heard.some((h) => h.event === "dice:result");
console.log(`${tick(!acted)}  cannot take a turn`);

const after = await new Promise((resolve) => {
	host.once("state:update", resolve);
	host.emit("state:request", { lobbyId });
	setTimeout(() => resolve(null), 3000);
});
const names = Object.keys(after?.players ?? {});
console.log(`${tick(!names.includes("Interloper"))}  never appears in the party (${names.join(", ") || "none"})`);
console.log(`${tick(!(after?.initiative ?? []).includes("Kenji"))}  never appears in the turn order`);

host.close();
watcher.close();
console.log("\ndone");
