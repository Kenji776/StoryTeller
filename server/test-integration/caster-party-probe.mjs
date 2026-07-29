/**
 * Functional probe: does a party of casters actually get to cast?
 *
 * @description Three casters — a Wizard, a Cleric and a Warlock — take real turns
 *   through `server.js` over real sockets, each naming a spell from their own chosen
 *   list. It answers what the unit tests cannot:
 *
 *   - is a named spell allowed, rather than rejected as an unknown ability with a strike?
 *   - does each class cast on its *own* ability, not intelligence?
 *   - does the roll go against the target's real armour class, or the save against a DC?
 *   - is a cantrip free while a levelled spell spends an activation?
 *   - does the DM narrate the resolved outcome rather than inventing its own?
 *
 *   Costs one DM call per turn plus one for the opening scene.
 *
 *     npm run dev
 *     node server/test-integration/caster-party-probe.mjs [--rounds 2]
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");
const ROUNDS = Number(arg("rounds", 2));
const PROVIDER = arg("provider", "anthropic");
const MODEL = arg("model", "claude-sonnet-4-6");
const DIFFICULTY = arg("difficulty", "standard");

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

/**
 * The party. Each caster's spells are a legal pick for their class at level 3, and each
 * deliberately mixes a cantrip with a levelled spell so the activation cost shows.
 * Their casting stats differ so a hardcoded `int` would be visible immediately.
 */
const PARTY = [
	{
		sheet: {
			name: "Elara Voss", class: "Wizard", race: "Elf", alignment: "Neutral Good",
			background: "Sage", level: 3,
			description: "Ink-stained fingers and a burnt cuff.",
			stats: { hp: 18, max_hp: 18, str: 8, dex: 14, con: 12, int: 17, wis: 11, cha: 10 },
			abilities: [], inventory: [],
			spells: ["Fire Bolt", "Magic Missile", "Burning Hands"],
			weapon: { name: "Quarterstaff", damage: "1d6", damageType: "bludgeoning", range: "melee" },
			armor: null,
		},
		// A cantrip, then a levelled spell, then a save spell.
		turns: [
			"I cast fire bolt at the nearest hobgoblin.",
			"I cast magic missile at the hobgoblin.",
			"I cast burning hands at the hobgoblin.",
		],
	},
	{
		sheet: {
			name: "Ovid Marrow", class: "Cleric", race: "Human", alignment: "Lawful Good",
			background: "Acolyte", level: 3,
			description: "A cracked holy symbol worn smooth.",
			// INT 8 and WIS 18 on purpose: casting on `int` would be a -1 instead of +4.
			stats: { hp: 24, max_hp: 24, str: 12, dex: 10, con: 14, int: 8, wis: 18, cha: 12 },
			abilities: [], inventory: [],
			spells: ["Sacred Flame", "Guiding Bolt", "Cure Wounds"],
			weapon: { name: "Mace", damage: "1d6", damageType: "bludgeoning", range: "melee" },
			armor: { name: "Chain Shirt", ac: 13, type: "medium", note: "" },
		},
		turns: [
			"I cast sacred flame at the hobgoblin.",
			"I cast guiding bolt at the hobgoblin.",
			"I cast sacred flame at the hobgoblin.",
		],
	},
	{
		sheet: {
			name: "Kessa Dun", class: "Warlock", race: "Tiefling", alignment: "Chaotic Neutral",
			background: "Charlatan", level: 3,
			description: "Horns filed short, eyes like banked coals.",
			// CHA 17: a warlock cast on `int` would roll a -1.
			stats: { hp: 20, max_hp: 20, str: 10, dex: 13, con: 13, int: 9, wis: 11, cha: 17 },
			abilities: [], inventory: [],
			spells: ["Eldritch Blast", "Arms of Hadar", "Witch Bolt"],
			weapon: { name: "Dagger", damage: "1d4", damageType: "piercing", range: "melee" },
			armor: { name: "Leather Armor", ac: 11, type: "light", note: "" },
		},
		turns: [
			"I cast eldritch blast at the hobgoblin.",
			"I cast witch bolt at the hobgoblin.",
			"I cast eldritch blast at the hobgoblin.",
		],
	},
];

const sockets = [];
const frames = [];

for (const member of PARTY) {
	const socket = io(URL, { transports: ["websocket"] });
	await waitFor(socket, "connect", 15000);
	for (const event of ["dice:result", "xp:update", "hp:update", "toast"]) {
		socket.on(event, (payload) => frames.push({ event, payload, who: member.sheet.name }));
	}
	sockets.push(socket);
	member.socket = socket;
}

const [host] = sockets;
host.emit("lobby:create", {});
const created = await waitFor(host, "lobby:created");
const lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId}) — ${DIFFICULTY}, ${PROVIDER}/${MODEL}\n`);

// Everyone joins, saves their sheet, and readies.
for (const member of PARTY) {
	if (member.socket !== host) {
		member.socket.emit("lobby:join", { code: created.code });
		await sleep(400);
	}
	member.socket.emit("player:sheet", { lobbyId, name: member.sheet.name, sheet: member.sheet });
	await sleep(300);
}

host.emit("lobby:settings", {
	lobbyId, timerEnabled: false, difficulty: DIFFICULTY, brutalityLevel: 5,
	illustrationMode: "off", lootGenerosity: "fair", startingLevel: 3,
	llmProvider: PROVIDER, llmModel: MODEL,
});
await sleep(400);

// Re-save after the starting level lands, so the level-3 ceiling applies to the picks.
for (const member of PARTY) {
	member.socket.emit("player:sheet", { lobbyId, name: member.sheet.name, sheet: member.sheet });
	await sleep(200);
	member.socket.emit("player:ready", { lobbyId, ready: true });
	await sleep(150);
}

/**
 * @description Reads the lobby state.
 * @returns {Promise<object|null>} The public state.
 */
async function state() {
	return new Promise((resolve) => {
		host.once("state:update", resolve);
		host.emit("state:request", { lobbyId });
		setTimeout(() => resolve(null), 3000);
	});
}

const before = await state();
console.log("── What the server thinks each caster knows ──");
for (const member of PARTY) {
	const p = before?.players?.find?.((x) => x.name === member.sheet.name)
		?? before?.players?.[member.sheet.name];
	console.log(`   ${member.sheet.name.padEnd(13)} ${String(member.sheet.class).padEnd(8)} `
		+ `spells: ${JSON.stringify(p?.spells ?? "(not published)")}`);
}

console.log("\nstarting the game…");
host.emit("game:start", { lobbyId });
await waitFor(host, "narration");
await sleep(1500);

/**
 * @description Whose turn it currently is.
 *
 *   The first run of this probe ignored turn order entirely: it cycled the party in
 *   sheet order and submitted regardless, so most turns were refused for acting out of
 *   turn — including the `[admin_command]` that stages the fight. That run therefore
 *   measured an empty enemy roster and no spell resolution at all.
 * @returns {Promise<string|null>} The acting character's name.
 */
async function currentPlayer() {
	const snapshot = await state();
	if (!snapshot || !Array.isArray(snapshot.initiative)) return null;
	return snapshot.initiative[snapshot.turnIndex ?? 0] ?? null;
}

/**
 * @description The party member whose turn it is.
 * @returns {Promise<object|null>} The member, or null when nobody is up.
 */
async function activeMember() {
	const name = await currentPlayer();
	return PARTY.find((m) => m.sheet.name === name) ?? null;
}

// Forced rather than waited for, exactly as combat-probe does: an earlier run spent DM
// calls in an empty corridor because the story had not reached a fight. Sent by whoever
// is actually up, since acting out of turn is refused.
console.log("staging a fight…");
const stager = (await activeMember()) ?? PARTY[0];
stager.socket.emit("action:submit", {
	lobbyId,
	text: "[admin_command] Three hobgoblin raiders attack the party right now. Introduce them "
		+ "with full stat blocks in the enemies array. AC 16, 22 hit points each, CR 1/2.",
});
await waitFor(stager.socket, "narration");
await sleep(1500);

const staged = await state();
console.log(`   roster: ${(staged?.enemies ?? []).map((e) => e.name).join(", ") || "(still empty)"}`);

/**
 * @description Takes one turn for a caster and reports every frame it produced.
 * @param {object} member - The party member.
 * @param {string} text - The action.
 * @returns {Promise<void>} Resolves once the turn has settled.
 */
async function takeTurn(member, text) {
	frames.length = 0;
	console.log(`── ${member.sheet.name} (${member.sheet.class}): "${text}"`);
	member.socket.emit("action:submit", { lobbyId, text });

	try {
		await waitFor(member.socket, "narration", 90000);
	} catch {
		console.log("   (no narration — the turn did not complete)");
	}
	await sleep(1200);

	const dice = frames.filter((f) => f.event === "dice:result").map((f) => f.payload);
	const toasts = frames.filter((f) => f.event === "toast").map((f) => f.payload);

	if (!dice.length) console.log("   ⚠ no dice:result — nothing was resolved");
	for (const d of dice) {
		console.log(`   🎲 ${d.kind} → ${d.value} `
			+ `[stat=${d.detail?.stat} base=${d.detail?.base} bonus=${d.detail?.bonus} `
			+ `outcome=${d.detail?.outcome}]`);
	}
	for (const t of toasts) console.log(`   💬 ${t.type}: ${t.message}`);
}

// Follow the initiative order the server rolled, not the order the party was written in.
const taken = new Map(PARTY.map((m) => [m.sheet.name, 0]));
for (let round = 0; round < ROUNDS; round++) {
	console.log(`
═══ round ${round + 1} ═══`);
	for (let i = 0; i < PARTY.length; i++) {
		const member = await activeMember();
		if (!member) {
			console.log("   (nobody is up — the order has stalled)");
			break;
		}
		const n = taken.get(member.sheet.name) ?? 0;
		taken.set(member.sheet.name, n + 1);
		await takeTurn(member, member.turns[n % member.turns.length]);
	}
}

const after = await state();
console.log("\n── Activations spent (cantrips should cost nothing) ──");
for (const member of PARTY) {
	const p = after?.players?.find?.((x) => x.name === member.sheet.name)
		?? after?.players?.[member.sheet.name];
	console.log(`   ${member.sheet.name.padEnd(13)} spellSlotsUsed=${p?.spellSlotsUsed ?? "?"}`);
}

for (const socket of sockets) socket.close();
console.log("\ndone");
