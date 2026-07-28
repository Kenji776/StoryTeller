/**
 * Functional probe: can a player actually drink a potion?
 *
 * @description Before this path existed a consumable was inert — the UI offered no
 *   button and no socket event consumed one, so the four healing potions a single
 *   probed session produced were dead weight. This drives the real socket path
 *   against a running server and reports what a browser would have received.
 *
 *   Costs nothing: no model is called, because using an item is a mechanical act
 *   with a known outcome.
 *
 *     npm run dev            # in another terminal
 *     node server/test-integration/consumable-probe.mjs [--url http://localhost:3000]
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3000");

/**
 * @description Resolves with the next payload for an event, or rejects on timeout.
 * @param {object} socket - A socket.io client.
 * @param {string} event - The event to await.
 * @param {number} [ms=8000] - How long to wait.
 * @returns {Promise<object>} The payload.
 * @throws {Error} When the event does not arrive in time.
 */
function waitFor(socket, event, ms = 8000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
		socket.once(event, (payload) => {
			clearTimeout(timer);
			resolve(payload);
		});
	});
}

/**
 * @description Pauses, so the server's own async writes settle between steps.
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHEET = {
	name: "Sylvie Ashwren",
	class: "Rogue",
	race: "Halfling",
	alignment: "Neutral Good",
	background: "Wanderer",
	level: 1,
	description: "Quick hands, quicker exits.",
	// Wounded on purpose: healing to full would hide whether the amount was right.
	stats: { hp: 4, max_hp: 20, str: 8, dex: 16, con: 12, int: 12, wis: 12, cha: 14 },
	abilities: [],
	inventory: [
		{ name: "Healing Potion", count: 2, description: "Restores health when drunk.", attributes: { item_type: "consumable", healing: "2d4+2" } },
		{ name: "Antitoxin", count: 1, description: "Neutralises a poison.", attributes: { item_type: "consumable", cures: "poisoned" } },
		{ name: "Shortsword", count: 1, description: "Plain steel.", attributes: { item_type: "weapon", damage: "1d6", damage_type: "slashing" } },
	],
	weapon: { name: "Dagger", damage: "1d4", damageType: "piercing", range: "melee" },
	armor: { name: "Leather Armor", ac: 11, type: "light", note: "" },
};

const socket = io(URL, { transports: ["websocket"] });
const received = [];
for (const event of ["hp:update", "inventory:update", "conditions:update", "toast"]) {
	socket.on(event, (payload) => received.push({ event, payload }));
}

await waitFor(socket, "connect");

socket.emit("lobby:create", {});
const created = await waitFor(socket, "lobby:created");
const lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId})`);

socket.emit("player:sheet", { lobbyId, name: SHEET.name, sheet: SHEET });
await sleep(300);

// What the server believes the character is, before anything is used. A maximum
// that does not match the sheet is the whole reason the first run of this probe
// healed into a ceiling.
const state = await new Promise((resolve) => {
	socket.once("state:update", resolve);
	socket.emit("state:request", { lobbyId });
	setTimeout(() => resolve(null), 1500);
});
const stored = state?.players?.[SHEET.name];
console.log(`stored stats: ${stored ? JSON.stringify(stored.stats) : "(state:update did not arrive)"}`);

/**
 * @description Uses an item and prints every frame the server sent back for it.
 * @param {string} itemName - What to use.
 * @param {string} expectation - What the caller is checking, for the transcript.
 * @returns {Promise<Array<object>>} The frames received.
 */
async function use(itemName, expectation) {
	received.length = 0;
	socket.emit("item:use", { lobbyId, itemName });
	await sleep(400);

	console.log(`\n── item:use "${itemName}" — ${expectation}`);
	if (!received.length) console.log("   (no frames — nothing happened)");
	for (const { event, payload } of received) {
		if (event === "hp:update") console.log(`   hp:update          ${payload.player} → ${payload.hp} (${payload.delta > 0 ? "+" : ""}${payload.delta}) "${payload.reason}"`);
		else if (event === "inventory:update") console.log(`   inventory:update   ${payload.item} ${payload.change} → ${payload.newCount} left`);
		else if (event === "conditions:update") console.log(`   conditions:update  [${payload.conditions.join(", ") || "none"}]`);
		else console.log(`   toast (${payload.type})      ${payload.message}`);
	}
	return [...received];
}

const healed = await use("Healing Potion", "should heal 4–10 and leave 1 potion");
await use("Shortsword", "should refuse — a sword is not drinkable");
await use("Nonexistent Elixir", "should refuse — not carried");
await use("Antitoxin", "should clear nothing (not poisoned) and still be spent");

const hp = healed.find((f) => f.event === "hp:update")?.payload;
const inv = healed.find((f) => f.event === "inventory:update")?.payload;

console.log(`\n══ result ${"═".repeat(50)}`);
const healedCorrectly = hp && hp.delta >= 4 && hp.delta <= 10 && hp.hp === 4 + hp.delta;
const spentCorrectly = inv && inv.change === -1 && inv.newCount === 1;
console.log(`   healed in range and applied to HP : ${healedCorrectly ? "yes" : "NO"}`);
console.log(`   potion spent, one left            : ${spentCorrectly ? "yes" : "NO"}`);

socket.close();
process.exit(healedCorrectly && spentCorrectly ? 0 : 1);
