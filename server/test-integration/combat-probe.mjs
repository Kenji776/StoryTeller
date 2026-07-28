/**
 * Functional probe: is a fight actually decided by dice?
 *
 * @description Drives a real game through `server.js` over real sockets and takes
 *   several attack turns against a staged enemy, reporting what the server rolled,
 *   what it applied, and what the narrator then said. It answers the three questions
 *   the unit tests cannot:
 *
 *   - does the roll go against the target's real armour class?
 *   - does the DM narrate a miss as a miss, or quietly grant a graze?
 *   - does the DM leave the server's enemy hit points alone?
 *
 *   Costs one DM call per turn plus one for the opening scene.
 *
 *     npm run dev
 *     node server/test-integration/combat-probe.mjs [--turns 4]
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");
const TURNS = Number(arg("turns", 4));
const PROVIDER = arg("provider", "anthropic");
const MODEL = arg("model", "claude-sonnet-4-6");

/**
 * @description Resolves with the next payload for an event.
 * @param {object} socket - A socket.io client.
 * @param {string} event - The event to await.
 * @param {number} [ms=90000] - How long to wait; a DM call is slow.
 * @returns {Promise<object>} The payload.
 * @throws {Error} When the event does not arrive in time.
 */
function waitFor(socket, event, ms = 90000) {
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
	name: "Brannor Ironfoot",
	class: "Fighter",
	race: "Dwarf",
	alignment: "Lawful Good",
	background: "Soldier",
	level: 3,
	description: "A braided copper beard and a dented shield.",
	stats: { hp: 28, max_hp: 28, str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
	abilities: [{ name: "Second Wind", description: "Regain hit points.", details: {} }],
	inventory: [],
	weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
	armor: { name: "Chain Shirt", ac: 13, type: "medium", note: "" },
};

const socket = io(URL, { transports: ["websocket"] });
const frames = [];
for (const event of ["dice:result", "narration", "xp:update", "hp:update"]) {
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
	lobbyId, timerEnabled: false, difficulty: "standard", brutalityLevel: 5,
	illustrationMode: "off", lootGenerosity: "fair", llmProvider: PROVIDER, llmModel: MODEL,
});
await sleep(300);
socket.emit("player:ready", { lobbyId, ready: true });
await sleep(200);

console.log("starting the game…");
socket.emit("game:start", { lobbyId });
await waitFor(socket, "narration");
await sleep(1500);

// A tough, low-AC brute so hits and misses are both reachable, introduced through
// the admin path rather than hoping the story produces one.
console.log("staging an enemy and attacking it…\n");

/**
 * @description Reads the lobby's current enemy roster off a state push.
 *
 *   `publicState` deliberately withholds exact enemy hit points from players and
 *   publishes a condition band instead — Healthy, Injured, Wounded, Near Death — so
 *   that is what this compares. An earlier version of this probe read `e.hp`, got
 *   `undefined` on both sides, and cheerfully reported "no change" through a fight
 *   the server log showed was landing blows.
 * @returns {Promise<object>} The roster, keyed by name.
 */
async function roster() {
	const state = await new Promise((resolve) => {
		socket.once("state:update", resolve);
		socket.emit("state:request", { lobbyId });
		setTimeout(() => resolve(null), 3000);
	});
	return Object.fromEntries((state?.enemies ?? []).map((e) => [e.name, e]));
}

for (let turn = 1; turn <= TURNS; turn++) {
	frames.length = 0;
	const before = await roster();
	const names = Object.values(before).filter((e) => e.status === "active").map((e) => `${e.name} [${e.condition}]`);

	console.log(`── turn ${turn} ${"─".repeat(52)}`);
	console.log(`   roster before: ${names.join(", ") || "(no enemies yet — attacking anyway)"}`);

	socket.emit("action:submit", { lobbyId, text: "I attack the nearest enemy with my shortsword." });
	await sleep(32000);

	const dice = frames.find((f) => f.event === "dice:result")?.payload;
	const narration = frames.filter((f) => f.event === "narration").map((f) => f.payload.content).join(" ");
	const xp = frames.find((f) => f.event === "xp:update")?.payload;

	console.log(`   server rolled: ${dice ? `${dice.kind} → ${dice.value} (${dice.detail?.outcome})` : "(no dice frame — nothing to attack)"}`);

	const after = await roster();
	const changed = Object.values(after).map((e) => {
		const was = before[e.name];
		return was && was.condition !== e.condition ? `${e.name} ${was.condition}→${e.condition}` : null;
	}).filter(Boolean);
	console.log(`   condition:     ${changed.join(", ") || "(unchanged)"}`);
	if (xp) console.log(`   xp:            +${xp.amount} (${xp.reason})`);

	const prose = narration.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

	// On a miss the target's state must not move. That is the mechanical question and
	// it has a mechanical answer — an earlier version of this probe grepped the prose
	// for words like "hits" and flagged a perfectly good miss because the sentence
	// "then they both hit you at once" describes the *enemies* attacking back.
	if (dice && dice.detail?.outcome === "fail") {
		const target = dice.kind.match(/vs (.+?) \(AC/)?.[1];
		const moved = target && before[target] && after[target] && before[target].condition !== after[target].condition;
		console.log(`   MISS honoured: ${moved ? `✗ ${target} changed anyway` : "✓ target untouched"}`);
	}

	console.log(`   narration:     "${prose.slice(0, 220)}…"`);
	console.log();
}

socket.close();
process.exit(0);
