/**
 * Functional probe: do a caster's chosen spells survive the round trip, and does the
 * server refuse the ones it should?
 *
 * @description The picker runs in a browser and the rules run on the server, so the
 *   only thing that proves they agree is a real save. This drives the actual socket
 *   path against a running server and prints what was stored — including for the
 *   cases a client is not supposed to be able to produce, since a browser is not a
 *   trusted source and `upsertPlayer` is the boundary that says so.
 *
 *   Costs nothing: no model is called.
 *
 *     npm run dev            # in another terminal
 *     node server/test-integration/spell-picker-probe.mjs [--url http://localhost:3013]
 */

import { io } from "socket.io-client";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg("url", "http://localhost:3013");

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

const socket = io(URL, { transports: ["websocket"] });
await waitFor(socket, "connect");

socket.emit("lobby:create", {});
const created = await waitFor(socket, "lobby:created");
const lobbyId = created.lobbyId;
console.log(`lobby ${created.code} (${lobbyId})\n`);

/**
 * @description Saves a sheet and reports the spell list the server kept.
 * @param {string} label - What this case is checking.
 * @param {object} sheet - Sheet fields to save over the baseline.
 * @returns {Promise<string[]>} The stored spell names.
 */
async function save(label, sheet) {
	const full = {
		name: "Elara Voss",
		race: "Elf",
		level: 1,
		stats: { hp: 8, max_hp: 8, str: 8, dex: 14, con: 12, int: 17, wis: 11, cha: 10 },
		abilities: [],
		inventory: [],
		...sheet,
	};
	socket.emit("player:sheet", { lobbyId, name: full.name, sheet: full });
	await sleep(250);

	const state = await new Promise((resolve) => {
		socket.once("state:update", resolve);
		socket.emit("state:request", { lobbyId });
		setTimeout(() => resolve(null), 1500);
	});
	const stored = state?.players?.[full.name]?.spells;
	console.log(`${label}\n   sent  : ${JSON.stringify(sheet.spells)}\n   stored: ${JSON.stringify(stored)}\n`);
	return stored;
}

// The ordinary case a picker produces.
await save("A wizard's three picks", {
	class: "Wizard",
	spells: ["Fire Bolt", "Magic Missile", "Shield"],
});

// The game master set level 1, so a level-2 spell is out of reach whatever the client
// submits. This is the rule the operator asked for, checked from outside.
await save("A level-2 spell at starting level 1 — must be dropped", {
	class: "Wizard",
	spells: ["Fire Bolt", "Scorching Ray"],
});

// Not on the class list.
await save("A cleric spell on a wizard sheet — must be dropped", {
	class: "Wizard",
	spells: ["Fire Bolt", "Cure Wounds"],
});

// Over the allowance: refused outright, leaving whatever was there.
await save("Four picks where three are allowed — must be refused", {
	class: "Wizard",
	spells: ["Fire Bolt", "Magic Missile", "Shield", "Sleep"],
});

// Invented outright.
await save("A spell that does not exist — must be dropped", {
	class: "Wizard",
	spells: ["Fire Bolt", "Wish"],
});

// Switching class must not leave a wizard casting Fire Bolt.
await save("Switching to Cleric — the wizard list must not carry over", {
	class: "Cleric",
	spells: ["Fire Bolt", "Sacred Flame"],
});

// A non-caster cannot hold spells at all.
await save("A fighter submitting spells — must store none", {
	class: "Fighter",
	spells: ["Fire Bolt"],
});

socket.close();
console.log("done");
