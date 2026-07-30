import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that the battle map has a socket channel to itself.
 *
 * Two unrelated features grew a map. `services/mapService.js` is the older one — a list of characters
 * and a terrain type, drawn by `components/map.html`, whose button in `index.html` is commented out.
 * `services/tactical/` is the grid: width, height, and a token table.
 *
 * They both emitted `map:update`, into the same room, because `room` is the identity function. The
 * browser fed whatever arrived to `tacticalMapView.setMap`, which requires `width`/`height`/`tokens`
 * and treats anything else as no map at all — so the legacy payload set the arena to null. `updateMap`
 * runs on every DM reply, from three call sites, and fires *after* the tactical emit.
 *
 * `publicState` also carries `map`, so the next `state:update` put the arena back: the visible symptom
 * was a battlefield that blinked out once a turn rather than one that vanished. The quieter cost was
 * worse. Clearing the map changes its signature, and a changed signature discards the square the
 * player had clicked — which is the exact loss `signatureOf` was written to prevent, arriving through
 * a door it was not watching.
 *
 * Nothing caught it because the simulation harness reads the socket directly and never asked a page
 * to draw.
 *
 * This reads the source as text. The defect was not inside any function — it was in two files
 * agreeing on a string, which is exactly what no unit test of either one could see.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @description Reads a file under `server/` or `client/`.
 * @param {string} relative - Path from the repository root.
 * @returns {string} Its text.
 * @throws {Error} When the file is missing, which is itself a wiring failure worth failing on.
 */
function source(relative) {
	return readFileSync(join(ROOT, "..", relative), "utf8");
}

/**
 * @description Collects the event names a file emits, however the room is addressed.
 * @param {string} text - The file's text.
 * @returns {Set<string>} Event names passed to `.emit("…")`.
 */
function emitted(text) {
	const names = new Set();
	for (const [, name] of text.matchAll(/\.emit\(\s*"([^"]+)"/g)) names.add(name);
	return names;
}

/**
 * @description Collects the event names a file subscribes to.
 * @param {string} text - The file's text.
 * @returns {Set<string>} Event names passed to `.on("…")`.
 */
function listened(text) {
	const names = new Set();
	for (const [, name] of text.matchAll(/socket\.on\(\s*"([^"]+)"/g)) names.add(name);
	return names;
}

/** The event carrying the tactical arena. One name, asserted from both ends. */
const ARENA_EVENT = "tactical:map";

test("the arena is emitted on its own event, not the legacy map's", () => {
	const server = source("server/server.js");

	assert.ok(emitted(server).has(ARENA_EVENT),
		`server.js never emits "${ARENA_EVENT}" — the arena has no channel of its own`);

	// The tactical emits are the ones passing `s.map`, which is where `ensureArena` puts the grid.
	const arenaEmits = [...server.matchAll(/\.emit\(\s*"([^"]+)"\s*,\s*(s\.map|null)\b/g)].map((m) => m[1]);
	const wrong = [...new Set(arenaEmits.filter((name) => name !== ARENA_EVENT))];
	assert.deepEqual(wrong, [],
		`the arena is emitted on ${wrong.join(", ")} as well, which the legacy map service also uses`);
});

test("the legacy map service keeps map:update, and the arena stays off it", () => {
	// Not a rename of the old feature. It still has consumers — `/api/map/:lobbyId` and
	// `components/map.html` — and deciding its fate is a separate question from this collision.
	const legacy = source("server/services/mapService.js");

	assert.ok(emitted(legacy).has("map:update"), "the legacy map service stopped emitting map:update");
	assert.ok(!emitted(legacy).has(ARENA_EVENT),
		`the legacy map service emits "${ARENA_EVENT}", which would put its payload back on the arena's channel`);
});

test("the browser listens for the arena on the same event the server sends it on", () => {
	const client = source("client/sockets.js");
	const heard = listened(client);

	assert.ok(heard.has(ARENA_EVENT), `sockets.js does not listen for "${ARENA_EVENT}"`);

	// The tactical handler is the one that calls setMap. If it is still bound to map:update it will
	// keep receiving the legacy payload and keep nulling the arena.
	const setMapHandlers = [...client.matchAll(/socket\.on\(\s*"([^"]+)"[\s\S]{0,400}?tacticalMapView\.setMap\(/g)]
		.map((m) => m[1]);
	assert.deepEqual([...new Set(setMapHandlers)], [ARENA_EVENT],
		"setMap is reached from an event other than the arena's own");
});
