/**
 * battle-sim — a fight, and nothing else.
 *
 * @description `playtest.mjs` plays a *game*: a village, a rumour, a walk to the barrow, and
 *   eventually some combat. That is the right shape for testing the whole thing and the wrong shape
 *   for testing a fight, because the fight arrives twenty minutes and thirty model calls in, and
 *   half the runs never got there at all.
 *
 *   This drops straight into combat. One lobby, characters placed, enemies staged on turn one, and
 *   the map printed after every action so a round can be read as it happens. No tavern.
 *
 *     npm run dev
 *     node server/test-integration/battle-sim.mjs                 # four drilled characters, tactical
 *     node server/test-integration/battle-sim.mjs --tactical off   # the same fight without a map
 *     node server/test-integration/battle-sim.mjs --enemies 5 --rounds 20
 *
 *   `--tactical off` is the comparison that matters: the same party, the same opposition, one with
 *   positions and one with the round-robin the game shipped with.
 */

import { io } from "socket.io-client";
import { decideAction } from "./personas.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");
const PROVIDER = arg("provider", "anthropic");
const MODEL = arg("model", "claude-sonnet-5");
const DIFFICULTY = arg("difficulty", "standard");
const TACTICAL = arg("tactical", "on") !== "off";
const ENEMY_COUNT = Number(arg("enemies", 3));
const MAX_ACTIONS = Number(arg("rounds", 12));
const TURN_MS = Number(arg("turnms", 26000));
const QUIET = argv.includes("--quiet");

/** The drilled party from `playtest.mjs`, built to the level-1 rules. */
const CHAIN_MAIL = { name: "Chain Mail", ac: 16, type: "heavy", note: "" };
const GREATSWORD = { name: "Greatsword", damage: "2d6", damageType: "slashing", range: "melee" };
const WARHAMMER = { name: "Warhammer", damage: "1d8", damageType: "bludgeoning", range: "melee" };

const CAST = [
	{ name: "Dorn Hammerfall", cls: "Fighter", race: "Dwarf", weapon: GREATSWORD, armor: CHAIN_MAIL,
		stats: { str: 18, dex: 8, con: 8, int: 8, wis: 8, cha: 8 } },
	{ name: "Kestra Vane", cls: "Fighter", race: "Human", weapon: GREATSWORD, armor: CHAIN_MAIL,
		stats: { str: 18, dex: 8, con: 8, int: 8, wis: 8, cha: 8 } },
	{ name: "Sister Almath", cls: "Cleric", race: "Human", weapon: WARHAMMER, armor: CHAIN_MAIL,
		stats: { wis: 18, dex: 8, con: 8, int: 8, str: 8, cha: 8 },
		spells: ["Guiding Bolt", "Sacred Flame", "Cure Wounds"] },
	{ name: "Brother Oduin", cls: "Cleric", race: "Dwarf", weapon: WARHAMMER, armor: CHAIN_MAIL,
		stats: { wis: 18, dex: 8, con: 8, int: 8, str: 8, cha: 8 },
		spells: ["Cure Wounds", "Sacred Flame", "Guiding Bolt"] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @description Resolves with the next payload for an event.
 * @param {object} socket - A socket.io client.
 * @param {string} event - The event to await.
 * @param {number} [ms=90000] - How long to wait.
 * @returns {Promise<object>} The payload.
 * @throws {Error} On timeout.
 */
function waitFor(socket, event, ms = 90000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
		socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
	});
}

/**
 * @description Builds a sheet in the shape the client sends. Ten hit points, which is what the
 *   builder actually gives a level-1 character.
 * @param {object} spec - A `CAST` entry.
 * @returns {object} The sheet.
 */
function sheetFor(spec) {
	return {
		name: spec.name, class: spec.cls, race: spec.race, level: 1,
		alignment: "Neutral Good", background: "Soldier", deity: "", gender: "",
		age: "30", height: "5'10\"", weight: "170lb", voice_id: null,
		description: `${spec.name}, a ${spec.race} ${spec.cls}.`,
		stats: { hp: 10, max_hp: 10, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...spec.stats },
		abilities: [], spells: spec.spells ?? [],
		inventory: [{ name: "Healing Potion", count: 1, description: "Restores health.", attributes: { healing: "2d4" } }],
		weapon: spec.weapon, armor: spec.armor,
	};
}

const GLYPH = { wall: "#", pillar: "o", low_wall: "=", rubble: "~", water: "≈", pit: "X" };

/**
 * @description Draws the battlefield, so a round can be read rather than inferred from a transcript.
 * @param {object} map - The map from `state:update`.
 * @param {object} party - Character sheets, for hit points beside the initials.
 * @returns {void}
 */
function drawMap(map, party) {
	if (!map) return console.log("   (no battle map)");
	const initials = new Map();
	for (const [name, token] of Object.entries(map.tokens)) {
		// Two characters, so a nine-wide arena still fits a terminal and "Sister Almath" and
		// "Skeleton" do not both render as S.
		const stripped = name.replace(/^(Sister|Brother)\s+/, "");
		let tag = (stripped.match(/\b\w/g) ?? ["?"]).join("").slice(0, 2).toUpperCase();
		while ([...initials.values()].includes(tag)) tag = tag[0] + String(initials.size);
		initials.set(name, tag);
	}

	const at = new Map(Object.entries(map.tokens).map(([n, t]) => [`${t.cell[0]},${t.cell[1]}`, { n, t }]));
	const scenery = new Map();
	for (const feature of map.features) {
		for (const cell of feature.cells) scenery.set(`${cell[0]},${cell[1]}`, GLYPH[feature.kind] ?? "?");
	}

	let header = "     ";
	for (let x = 0; x < map.width; x++) header += String.fromCharCode(65 + x) + "  ";
	console.log(header);
	for (let y = 0; y < map.height; y++) {
		let row = String(y + 1).padStart(3) + "  ";
		for (let x = 0; x < map.width; x++) {
			const who = at.get(`${x},${y}`);
			row += who ? initials.get(who.n).padEnd(3) : (scenery.get(`${x},${y}`) ?? ".") + "  ";
		}
		console.log(row);
	}
	const roster = Object.entries(map.tokens).map(([name, token]) => {
		const hp = party[name]?.stats ? `${party[name].stats.hp}/${party[name].stats.max_hp}` : "—";
		return `${initials.get(name)}=${name}${party[name] ? ` (${hp})` : ""}`;
	});
	console.log("     " + roster.join("  "));
}

// ── Run ─────────────────────────────────────────────────────────────────────

const host = io(URL, { transports: ["websocket"] });
await waitFor(host, "connect", 15000);
host.emit("lobby:create", {});
const created = await waitFor(host, "lobby:created");
const lobbyId = created.lobbyId;

console.log(`battle-sim — lobby ${created.code} (${lobbyId})`);
console.log(`tactical ${TACTICAL ? "ON" : "OFF"} | ${CAST.length} characters vs ${ENEMY_COUNT} | difficulty ${DIFFICULTY} | ${MAX_ACTIONS} actions\n`);

// One socket per character, because the server identifies an actor by their connection.
const seats = [];
for (const spec of CAST) {
	const socket = spec === CAST[0] ? host : io(URL, { transports: ["websocket"] });
	if (socket !== host) {
		await waitFor(socket, "connect", 15000);
		socket.emit("lobby:join", { code: created.code });
		await waitFor(socket, "lobby:joined");
	}
	socket.emit("player:sheet", { lobbyId, name: spec.name, sheet: sheetFor(spec) });
	await sleep(250);
	seats.push({ spec, socket, story: [], state: null });
}

host.emit("lobby:settings", {
	lobbyId, timerEnabled: false, difficulty: DIFFICULTY, brutalityLevel: 5,
	illustrationMode: "off", lootGenerosity: "fair", abilitySlotsBase: 3,
	llmProvider: PROVIDER, llmModel: MODEL, tacticalCombat: TACTICAL,
});
await sleep(400);

for (const seat of seats) {
	seat.socket.on("state:update", (state) => {
		seat.state = state;
		// Derived rather than read from a field: the server emits `turn:update` only on a *change*,
		// never for the opening turn, so a harness that waited for the event would stall on turn one.
		if (Array.isArray(state?.initiative)) {
			seat.currentTurn = state.initiative[state.turnIndex] ?? null;
		}
	});
	seat.socket.on("turn:update", (payload) => { seat.currentTurn = payload?.current ?? null; });
	// The server computes this and sends it to whoever is on the clock. Passing it through verbatim
	// is the whole point: the agent is handed answers rather than a geometry problem.
	seat.socket.on("tactical:menu", ({ menu }) => { seat.menu = menu; });
	seat.socket.on("narration", ({ content }) => {
		const text = String(content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		if (text) seat.story.push(text);
	});
	seat.socket.emit("player:ready", { lobbyId, ready: true });
	await sleep(150);
}

host.emit("game:start", { lobbyId });
await waitFor(host, "narration");
await sleep(1200);

/**
 * @description Waits until somebody holds the turn, and returns their seat. Two earlier probes in
 *   this project submitted out of initiative, had every action refused, and reported an empty roster
 *   that read exactly like a dead feature — so this is the thing to get right before anything else.
 * @param {number} [ms=90000] - How long to wait.
 * @returns {Promise<object|null>} The seat on the clock, or `null` if nobody ever was.
 */
async function seatOnTheClock(ms = 90000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const current = seats.find((seat) => seat.currentTurn)?.currentTurn ?? null;
		const seat = seats.find((s) => s.spec.name === current);
		if (seat) return seat;
		await sleep(500);
	}
	return null;
}

// Straight to the fight. This is the whole point of the harness: no rumour, no walk.
console.log("staging the fight…\n");
const staging = await seatOnTheClock();
if (!staging) {
	console.log("nobody ever held the turn — is the game actually running?");
	process.exit(1);
}
staging.socket.emit("action:submit", {
	lobbyId,
	text: `[admin_command] ${ENEMY_COUNT} skeletal warriors attack the party right now, in this room. `
		+ "Put every one of them in the enemies array with AC 13, 13 hit points, CR 1/2. "
		+ "Describe only the ambush, in two sentences.",
});
await sleep(TURN_MS);

let actions = 0;
let downed = 0;
let sawEnemies = false;
while (actions < MAX_ACTIONS) {
	const state = seats.find((s) => s.state)?.state;
	const current = seats.find((seat) => seat.currentTurn)?.currentTurn ?? null;
	const seat = seats.find((s) => s.spec.name === current) ?? null;
	if (!seat) { await sleep(2500); continue; }

	const living = Object.values(state.players ?? {}).filter((p) => !p.dead).length;
	const enemiesLeft = (state.enemies ?? []).filter((e) => e.condition !== "Dead").length;
	if (enemiesLeft) sawEnemies = true;
	// Only a field that had enemies on it can be cleared. Without this the loop declared victory on
	// its first pass, before the staging turn had even been narrated.
	if (sawEnemies && !enemiesLeft) { console.log("\n✅ the field is clear"); break; }
	if (!sawEnemies) { await sleep(3000); continue; }
	if (!living) { console.log("\n💀 the party is down"); break; }

	let sentence;
	try {
		sentence = await decideAction({
			player: { name: seat.spec.name, spec: seat.spec },
			story: seat.story, state: seat.state, chat: [],
			apiKey: process.env.OPENAI_API_KEY, drilled: true, log: () => {},
			tactical: TACTICAL ? seat.menu ?? null : null,
		});
	} catch { sentence = "I attack the nearest enemy with my weapon."; }

	// The map already told the agent which cell to move to; take the first one it names.
	const named = /\b([A-Z])(\d{1,2})\b/.exec(sentence ?? "");
	const move = TACTICAL && named ? named[0] : null;

	actions++;
	console.log(`── action ${actions}/${MAX_ACTIONS} — ${seat.spec.name}`);
	console.log(`   > ${sentence}${move ? `   [move ${move}]` : ""}`);
	seat.socket.emit("action:submit", { lobbyId, text: sentence, move });
	await sleep(TURN_MS);

	const after = seats.find((s) => s.state)?.state;
	if (!QUIET) drawMap(after?.map, after?.players ?? {});
	const hurt = Object.values(after?.players ?? {}).map((p) => `${p.name.split(" ")[0]} ${p.stats?.hp}/${p.stats?.max_hp}`);
	const foes = (after?.enemies ?? []).map((e) => `${e.name} ${e.condition}`);
	console.log(`   party: ${hurt.join(", ")}`);
	console.log(`   foes:  ${foes.join(", ") || "none"}\n`);
	downed = Object.values(after?.players ?? {}).filter((p) => p.dead).length;
}

const final = seats.find((s) => s.state)?.state;
console.log("══ result " + "═".repeat(58));
console.log(`   tactical:        ${TACTICAL ? "on" : "off"}`);
console.log(`   actions taken:   ${actions}`);
console.log(`   characters down: ${downed} of ${CAST.length}`);
console.log(`   enemies left:    ${(final?.enemies ?? []).filter((e) => e.condition !== "Dead").length}`);
for (const p of Object.values(final?.players ?? {})) {
	console.log(`   ${p.name.padEnd(18)} ${p.stats?.hp}/${p.stats?.max_hp} hp, xp ${p.xp ?? 0}`);
}

for (const seat of seats) seat.socket.close();
process.exit(0);
