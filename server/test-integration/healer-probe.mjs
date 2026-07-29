/**
 * Functional probe: does a levelled spell heal, and does it cost a slot?
 *
 * @description Three full playtests failed to answer this. The casters in them only ever
 *   threw cantrips, so `spellSlotsUsed` stayed at zero throughout and the levelled path —
 *   the one that actually spends something — was never exercised. Loot went the same way:
 *   every party died before clearing an encounter, so the roll never fired.
 *
 *   This drives both directly, in minutes rather than the better part of an hour. One
 *   player, so turn order is trivial — two earlier probes measured nothing because they
 *   submitted out of initiative and had every action refused.
 *
 *   The cleric starts wounded on purpose: healing to a full bar hides whether the amount
 *   was right, and hides a heal that overshoots the maximum.
 *
 *   Costs one DM call per turn.
 *
 *     npm run dev
 *     node server/test-integration/healer-probe.mjs
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
	name: "Ovid Marrow",
	class: "Cleric",
	race: "Human",
	alignment: "Neutral Good",
	background: "Acolyte",
	level: 3,
	description: "A grave-warden's apprentice with ink-stained fingers.",
	// Badly wounded, with a wide gap to the maximum, so a heal has room to be measured
	// and an overshoot would be visible rather than clipped into the ceiling.
	stats: { hp: 5, max_hp: 24, str: 10, dex: 12, con: 12, int: 8, wis: 17, cha: 10 },
	abilities: [],
	inventory: [],
	spells: ["Cure Wounds", "Sacred Flame", "Guiding Bolt"],
	weapon: { name: "Mace", damage: "1d6", damageType: "bludgeoning", range: "melee" },
	armor: { name: "Chain Shirt", ac: 13, type: "medium", note: "" },
};

const socket = io(URL, { transports: ["websocket"] });
const frames = [];
for (const event of ["hp:update", "spellslots:update", "xp:update", "inventory:update", "gold:update", "narration", "toast"]) {
	socket.on(event, (payload) => frames.push({ event, payload }));
}

await waitFor(socket, "connect", 15000);

socket.emit("lobby:create", {});
const created = await waitFor(socket, "lobby:created");
const lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId})`);

socket.emit("player:sheet", { lobbyId, name: SHEET.name, sheet: SHEET });
await sleep(400);
socket.emit("lobby:settings", {
	lobbyId, timerEnabled: false, difficulty: "standard", brutalityLevel: 3,
	illustrationMode: "off", lootGenerosity: "generous", llmProvider: PROVIDER, llmModel: MODEL,
});
await sleep(400);
socket.emit("player:ready", { lobbyId, ready: true });
await sleep(300);

socket.emit("game:start", { lobbyId });
await waitFor(socket, "narration");
await sleep(1500);

/**
 * @description Reads what the server currently believes about the cleric and the field.
 * @returns {Promise<{me: object|null, enemies: Array<object>}>} The stored sheet and roster.
 */
async function look() {
	const state = await new Promise((resolve) => {
		socket.once("state:update", resolve);
		socket.emit("state:request", { lobbyId });
		setTimeout(() => resolve(null), 3000);
	});
	return { me: state?.players?.[SHEET.name] ?? null, enemies: state?.enemies ?? [] };
}

/**
 * @description Takes one turn and prints every mechanical frame it produced.
 * @param {string} text - The action to submit.
 * @param {string} expectation - What this turn is checking, for the transcript.
 * @returns {Promise<Array<object>>} The frames received during the turn.
 */
async function act(text, expectation) {
	frames.length = 0;
	console.log(`\n── ${expectation}`);
	console.log(`   > ${text}`);
	socket.emit("action:submit", { lobbyId, text });
	await sleep(TURN_MS);

	for (const { event, payload } of frames) {
		if (event === "hp:update") console.log(`   hp:update          ${payload.player} ${payload.delta >= 0 ? "+" : ""}${payload.delta} → ${payload.hp}  "${payload.reason || ""}"`);
		else if (event === "spellslots:update") console.log(`   spellslots:update  used ${payload.spellSlotsUsed} of ${payload.maxSlots}`);
		else if (event === "xp:update") console.log(`   xp:update          ${payload.player} +${payload.amount}  "${payload.reason}"`);
		else if (event === "inventory:update") console.log(`   inventory:update   ${payload.item} ${payload.change} → ${payload.newCount}`);
		else if (event === "gold:update") console.log(`   gold:update        ${payload.player} ${payload.delta >= 0 ? "+" : ""}${payload.delta} → ${payload.gold}`);
		else if (event === "toast") console.log(`   toast (${payload.type})       ${payload.message}`);
	}
	if (!frames.some((f) => f.event !== "narration")) console.log("   (no mechanical frames — nothing resolved)");
	return [...frames];
}

const before = await look();
console.log(`stored: hp ${before.me?.stats?.hp}/${before.me?.stats?.max_hp}, spells [${(before.me?.spells ?? []).join(", ")}], slots used ${before.me?.spellSlotsUsed ?? 0}`);

// ── 1. The levelled spell, which is the whole point ────────────────────────────
const healed = await act("I cast Cure Wounds on myself.", "a levelled spell should heal and spend one slot");
const afterHeal = await look();

// ── 2. A cantrip, which must not touch the pool ────────────────────────────────
await act("I cast Sacred Flame at the nearest threat.", "a cantrip should cost nothing");
const afterCantrip = await look();

// ── 3. Something to kill, then the body searched ───────────────────────────────
// Forced rather than waited for: an earlier probe spent two DM calls in an empty
// corridor because the story had not reached a fight, and measured nothing.
console.log("\n── staging something weak enough to actually die");
await act("[admin_command] A single half-starved barrow rat attacks right now. Put it in the enemies array with AC 5, 2 hit points, CR 1/8.",
	"staging the encounter");
const staged = await look();
console.log(`   staged: ${staged.enemies.map((e) => `${e.name} [${e.condition}]`).join(", ") || "(none — the command was ignored)"}`);

const killed = await act("I cast Guiding Bolt at the barrow rat.", "a kill should pay XP");
const looted = await act("I search the barrow rat and the ground around it for anything useful.", "clearing the field should roll loot");

const end = await look();

// ── What it all showed ─────────────────────────────────────────────────────────
const healFrame = healed.find((f) => f.event === "hp:update")?.payload;
const slotFrame = healed.find((f) => f.event === "spellslots:update")?.payload;
const slotsAfterHeal = afterHeal.me?.spellSlotsUsed ?? 0;
const slotsAfterCantrip = afterCantrip.me?.spellSlotsUsed ?? 0;

const checks = [
	["Cure Wounds restored hit points", !!healFrame && healFrame.delta > 0],
	["the heal did not exceed the maximum", (afterHeal.me?.stats?.hp ?? 0) <= (afterHeal.me?.stats?.max_hp ?? 0)],
	["a slot was spent for it", slotsAfterHeal === 1],
	["the client was told about the slot", !!slotFrame],
	["the cantrip spent no slot", slotsAfterCantrip === slotsAfterHeal],
	["the kill paid XP", killed.some((f) => f.event === "xp:update")],
	["loot was awarded", looted.some((f) => f.event === "inventory:update" || f.event === "gold:update")],
];

console.log(`\n══ result ${"═".repeat(58)}`);
for (const [label, ok] of checks) console.log(`   ${ok ? "yes" : "NO "}  ${label}`);
console.log(`\n   final: hp ${end.me?.stats?.hp}/${end.me?.stats?.max_hp}, slots used ${end.me?.spellSlotsUsed ?? 0}, `
	+ `xp ${end.me?.xp ?? 0}, gold ${end.me?.gold ?? 0}, items ${(end.me?.inventory ?? []).length}`);

socket.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
