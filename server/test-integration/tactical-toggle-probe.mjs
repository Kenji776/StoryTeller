/**
 * Checks the battle map's switch end to end, and that the window it opens is actually served.
 *
 * For most of the tactical feature's life the server accepted `tacticalCombat` and no page sent it, so
 * everything below the setting was unreachable from a browser. `client/settingsWiring.test.js` catches
 * that statically. This checks the other half: that setting it changes the lobby, that the change comes
 * back on `state:update` so a reopened options window shows the truth, and that switching it off does
 * not leave an arena behind.
 *
 * Usage: node server/test-integration/tactical-toggle-probe.mjs [--url http://localhost:3013]
 */

import { io } from "socket.io-client";

const args = process.argv.slice(2);
const urlAt = args.indexOf("--url");
const BASE = urlAt >= 0 ? args[urlAt + 1] : "http://localhost:3013";

const failures = [];

/**
 * @description Records a failed expectation rather than throwing, so one run reports everything wrong.
 * @param {boolean} condition - What must hold.
 * @param {string} message - What it means when it does not.
 * @returns {void}
 */
function expect(condition, message) {
	if (!condition) failures.push(message);
}

/**
 * @description Waits for one named event.
 * @param {object} socket - A connected socket.
 * @param {string} event - The event name.
 * @param {number} [ms] - How long to wait.
 * @returns {Promise<object>} The payload.
 * @throws {Error} When it does not arrive.
 */
function once(socket, event, ms = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
		socket.once(event, (payload) => {
			clearTimeout(timer);
			resolve(payload);
		});
	});
}

/**
 * @description Sends a settings change and waits for the state that reflects it.
 * @param {object} socket - The host's socket.
 * @param {string} lobbyId - The lobby.
 * @param {object} settings - What to change.
 * @returns {Promise<object>} The lobby state that came back.
 * @throws {Error} When no state arrives.
 */
async function change(socket, lobbyId, settings) {
	const next = once(socket, "state:update");
	socket.emit("lobby:settings", { lobbyId, ...settings });
	return next;
}

// ── The window the feature opens has to exist ────────────────────────────────

const page = await fetch(`${BASE}/components/battlemap.html`);
expect(page.ok, `GET /components/battlemap.html → ${page.status}; the pop-out would open on nothing`);
const html = page.ok ? await page.text() : "";

// The opener draws into this document by id. A rename on either side leaves a blank window.
for (const id of ["tacticalMapSection", "tacticalMapCanvas", "tacticalMapHint", "battlemapIdle"]) {
	expect(html.includes(`id="${id}"`), `battlemap.html is missing #${id}, which the renderer draws into`);
}
expect(!/\bio\s*\(/.test(html), "battlemap.html opens its own socket — it is meant to be drawn into by its opener");

const bridge = await (await fetch(`${BASE}/index.html`)).text();
expect(bridge.includes("mapWindowIntent"), "index.html does not put mapWindowIntent on window — the pop-out can never open");
expect(bridge.includes("popOutBattleMap"), "index.html has no way to ask for the window by hand, so a blocked popup is final");

// ── The switch ───────────────────────────────────────────────────────────────

const socket = io(BASE, { transports: ["websocket"] });
await once(socket, "connect");
socket.emit("lobby:create", {});
const created = await once(socket, "lobby:created");
socket.emit("lobby:join", { code: created.code });
await once(socket, "lobby:joined");

const fresh = await once(socket, "state:update");
console.log(`lobby ${created.lobbyId}`);
expect(fresh.tacticalCombat === false,
	`a new lobby reports tacticalCombat=${fresh.tacticalCombat}; the feature must be off unless asked for`);

const on = await change(socket, created.lobbyId, { tacticalCombat: true });
expect(on.tacticalCombat === true, "switching it on did not come back on state:update, so a reopened panel would show it off");

const off = await change(socket, created.lobbyId, { tacticalCombat: false });
expect(off.tacticalCombat === false, "switching it off did not come back");
expect(!off.map, "switching it off left an arena behind, which would be persisted forever");

// A browser will happily send the string. The server accepts it; this proves it rather than assuming.
const viaString = await change(socket, created.lobbyId, { tacticalCombat: "true" });
expect(viaString.tacticalCombat === true, 'the string "true" was not accepted, though a form may well send one');

const viaOff = await change(socket, created.lobbyId, { tacticalCombat: "off" });
expect(viaOff.tacticalCombat === false, 'the string "off" switched the feature ON — every string is truthy');

console.log(`\ntoggle: fresh=${fresh.tacticalCombat} → on=${on.tacticalCombat} → off=${off.tacticalCombat}`
	+ ` → "true"=${viaString.tacticalCombat} → "off"=${viaOff.tacticalCombat}`);

socket.disconnect();

if (failures.length) {
	console.log(`\n${failures.length} problem(s):`);
	for (const failure of failures) console.log(`  ✗ ${failure}`);
	process.exit(1);
}
console.log("\n✓ the switch works from both ends and the window it opens is served");
