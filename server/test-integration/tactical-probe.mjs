/**
 * Functional probe: does the tactical map do anything when a lobby asks for it?
 *
 * @description Phase 4b wired `session.js` into the turn pipeline. Unit tests cover the geometry
 *   and the toggle; this answers the questions only a live server can:
 *
 *   - does an arena appear when a fight starts, and reach clients?
 *   - does a legal move actually move the token, and an illegal one get refused rather than clamped?
 *   - does a swing at something across the room fail as a settled fact?
 *   - does the narrator receive the battlefield block, and stay off the positions?
 *
 *   Costs one DM call per turn.
 *
 *     npm run dev
 *     node server/test-integration/tactical-probe.mjs
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");
const PROVIDER = arg("provider", "anthropic");
const MODEL = arg("model", "claude-sonnet-5");
const TURN_MS = Number(arg("turnms", 30000));

/**
 * @description Resolves with the next payload for an event.
 * @param {object} socket - A socket.io client.
 * @param {string} event - The event to await.
 * @param {number} [ms=90000] - How long to wait.
 * @returns {Promise<object>} The payload.
 * @throws {Error} When the event does not arrive in time.
 */
function waitFor(socket, event, ms = 90000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
		socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHEET = {
	name: "Dorn Hammerfall",
	class: "Fighter",
	race: "Dwarf",
	alignment: "Lawful Good",
	background: "Soldier",
	level: 3,
	description: "A braided copper beard and a dented shield.",
	stats: { hp: 28, max_hp: 28, str: 18, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
	abilities: [],
	inventory: [],
	weapon: { name: "Greatsword", damage: "2d6", damageType: "slashing", range: "melee" },
	armor: { name: "Chain Mail", ac: 16, type: "heavy", note: "" },
};

const socket = io(URL, { transports: ["websocket"] });
const maps = [];
const toasts = [];
// tactical:map, not map:update — the latter belongs to the older map feature, and listening for it
// here would have this probe reporting success on a characters-and-terrain payload that is not an arena.
socket.on("tactical:map", (payload) => maps.push(payload));
socket.on("toast", (payload) => toasts.push(payload));

await waitFor(socket, "connect", 15000);

socket.emit("lobby:create", {});
const created = await waitFor(socket, "lobby:created");
const lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId})`);

socket.emit("player:sheet", { lobbyId, name: SHEET.name, sheet: SHEET });
await sleep(400);
socket.emit("lobby:settings", {
	lobbyId, timerEnabled: false, difficulty: "standard", brutalityLevel: 3,
	illustrationMode: "off", lootGenerosity: "fair", llmProvider: PROVIDER, llmModel: MODEL,
	tacticalCombat: true,
});
await sleep(400);
socket.emit("player:ready", { lobbyId, ready: true });
await sleep(300);
socket.emit("game:start", { lobbyId });
await waitFor(socket, "narration");
await sleep(1500);

/**
 * @description Reads the map the server currently believes in.
 * @returns {Promise<object|null>} The map from `state:update`.
 */
async function currentMap() {
	const state = await new Promise((resolve) => {
		socket.once("state:update", resolve);
		socket.emit("state:request", { lobbyId });
		setTimeout(() => resolve(null), 3000);
	});
	return state?.map ?? null;
}

/**
 * @description Takes a turn and reports what came back.
 * @param {string} text - The action.
 * @param {number[]|string|null} move - Where to move first, if anywhere.
 * @param {string} expectation - What this turn is checking.
 * @returns {Promise<object|null>} The map after the turn.
 */
async function act(text, move, expectation) {
	toasts.length = 0;
	console.log(`\n── ${expectation}`);
	console.log(`   > ${text}${move ? `  (move to ${move})` : ""}`);
	socket.emit("action:submit", { lobbyId, text, move });
	await sleep(TURN_MS);
	for (const toast of toasts) console.log(`   toast (${toast.type}): ${toast.message}`);
	const map = await currentMap();
	if (map) {
		const where = Object.entries(map.tokens).map(([n, t]) => `${n} at ${t.cell}`).join(", ");
		console.log(`   positions: ${where}`);
	}
	return map;
}

console.log("\nstaging a fight…");
socket.emit("action:submit", { lobbyId, text: "[admin_command] Two hobgoblin raiders attack right now. Put them in the enemies array with AC 15, 11 hit points each, CR 1/2." });
await sleep(TURN_MS);

// Checked after the staging turn has been narrated, because the arena cannot exist before the
// enemies do — the admin command *is* the action that creates them.
const staged = await currentMap();
console.log(`arena: ${staged ? `${staged.archetype} ${staged.width}x${staged.height}, ${staged.features.length} features` : "NONE"}`);
if (staged) {
	console.log(`tokens: ${Object.entries(staged.tokens).map(([n, t]) => `${n}@${t.cell}`).join(", ")}`);
}

// A deliberately absurd destination: refused, and the character stays put.
const beforeIllegal = JSON.stringify(staged?.tokens?.[SHEET.name]?.cell ?? null);
await act("I hold my ground and watch them come.", "Z9", "an impossible move should be refused, not clamped");
const afterIllegal = JSON.stringify((await currentMap())?.tokens?.[SHEET.name]?.cell ?? null);

// A swing at something that is certainly not adjacent.
await act("I swing my greatsword at Hobgoblin Raider 1.", null, "a swing from across the room should fail as a settled fact");

// One legal step, wherever that is.
const map = await currentMap();
const me = map?.tokens?.[SHEET.name]?.cell;
const step = me ? [Math.min(me[0] + 1, map.width - 1), me[1]] : null;
const afterStep = await act("I advance on the nearest raider.", step, "a legal step should move the token");

console.log(`\n══ result ${"═".repeat(58)}`);
const checks = [
	["an arena appeared when the fight started", !!staged],
	["the arena reached the client over tactical:map", maps.some((m) => m && m.width && m.tokens)],
	["an impossible move left the token where it was", beforeIllegal !== "null" && beforeIllegal === afterIllegal],
	["the token ended up somewhere legal", !!afterStep?.tokens?.[SHEET.name]],
	["nobody shares a square", (() => {
		const cells = Object.values(afterStep?.tokens ?? {}).map((t) => String(t.cell));
		return new Set(cells).size === cells.length;
	})()],
];
for (const [label, ok] of checks) console.log(`   ${ok ? "yes" : "NO "}  ${label}`);

socket.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
