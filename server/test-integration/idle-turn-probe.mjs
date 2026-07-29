/**
 * Functional probe: does letting the clock run out still cost you?
 *
 * @description The enemies' round was resolved only in the `action:submit` handler,
 *   so a turn that expired went to the narrator without one and the enemies did not
 *   attack. Standing still was mechanically safer than acting — in a hard fight, the
 *   optimal play. This stages a fight, then does nothing, and reports whether the
 *   party took damage anyway.
 *
 *   Slow by nature: the turn timer clamps to a minute, so a run takes a few.
 *
 *     npm run dev
 *     node server/test-integration/idle-turn-probe.mjs
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
const WAIT_MS = Number(arg("wait", 150)) * 1000;

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
		socket.once(event, (p) => { clearTimeout(timer); resolve(p); });
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHEET = {
	name: "Brannor Ironfoot", class: "Fighter", race: "Dwarf", alignment: "Lawful Good",
	background: "Soldier", level: 3, description: "Patient to a fault.",
	stats: { hp: 28, max_hp: 28, str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
	abilities: [], inventory: [],
	weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
	armor: { name: "Chain Shirt", ac: 13, type: "medium", note: "" },
};

let lobbyId = null;
const socket = io(URL, { transports: ["websocket"] });
const hpFrames = [];
socket.on("hp:update", (p) => hpFrames.push(p));

// A real client reports when narration has finished playing, and the turn timer will
// not start until it does — falling back only after three minutes. Without this the
// probe sits through the fallback instead of the timer it came to test.
socket.on("narration", () => setTimeout(() => socket.emit("narration:done", { lobbyId }), 500));

await waitFor(socket, "connect", 15000);

socket.emit("lobby:create", {});
const created = await waitFor(socket, "lobby:created");
lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId})`);

socket.emit("player:sheet", { lobbyId, name: SHEET.name, sheet: SHEET });
await sleep(300);
// The timer has to be on — this probe is about what happens when it fires.
socket.emit("lobby:settings", {
	lobbyId, timerEnabled: true, timerMinutes: 1, maxMissedTurns: 5,
	difficulty: "merciless", brutalityLevel: 5, illustrationMode: "off",
	llmProvider: PROVIDER, llmModel: MODEL,
});
await sleep(300);
socket.emit("player:ready", { lobbyId, ready: true });
await sleep(200);

socket.emit("game:start", { lobbyId });
await waitFor(socket, "narration");
await sleep(1500);

console.log("staging a fight…");
socket.emit("action:submit", {
	lobbyId,
	text: "[admin_command] Two hobgoblin raiders attack the party right now. Introduce them with full stat blocks in the enemies array. AC 18, 11 hit points each, CR 1/2.",
});
await waitFor(socket, "narration");
await sleep(2000);

hpFrames.length = 0;
console.log(`now doing nothing for ${WAIT_MS / 1000}s, letting the clock run out…\n`);
await sleep(WAIT_MS);

socket.close();

const wounds = hpFrames.filter((f) => f.player === SHEET.name && f.delta < 0);
console.log(`── result ${"─".repeat(50)}`);
for (const w of wounds) console.log(`   hp:update  ${w.delta} → ${w.hp}  "${w.reason}"`);
console.log(`\n   idling drew ${wounds.length} wound(s) totalling ${wounds.reduce((n, w) => n + Math.abs(w.delta), 0)} damage`);
console.log(`   ${wounds.length ? "✓ standing still is no longer safe" : "✗ the clock is still a shield"}`);

process.exit(wounds.length ? 0 : 1);
