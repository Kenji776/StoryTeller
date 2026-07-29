/**
 * Tests for character sheet storage.
 *
 * @description `upsertPlayer` initialised `max_hp` from *current* hp on a
 *   character's first save, discarding whatever maximum the sheet supplied. For a
 *   freshly built character the two are equal and nothing shows. For a wounded one —
 *   an imported sheet, a character carried between sessions — the maximum was
 *   permanently reduced to whatever the current total happened to be, and healing
 *   could never lift them past it. A live probe drank a potion that rolled 8 and
 *   watched a 4/20 rogue stay at 4.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { playerMethods } from "./lobbyPlayers.js";

/**
 * Builds a minimal LobbyStore stand-in for the player methods.
 *
 * @description `playerMethods` is mixed into `LobbyStore.prototype`, so binding it to
 *   a `this` exposing `index` and `persist` exercises the real method with no store,
 *   disk or socket (`TDD-8`).
 * @returns {object} The store double.
 */
function makeStore() {
	const store = Object.create(playerMethods);
	store.index = {
		lob1: { lobbyId: "lob1", phase: "lobby", players: {}, sockets: { sid1: { playerName: null } }, hostSid: "sid1" },
	};
	store.persist = () => {};
	return store;
}

/**
 * @description Builds a sheet in the shape the client submits.
 * @param {object} [stats] - Stats to use.
 * @returns {object} A sheet.
 */
function sheet(stats) {
	return { name: "Sylvie", class: "Rogue", race: "Halfling", level: 1, stats, abilities: [], inventory: [] };
}

const statsOf = (store) => store.index.lob1.players.Sylvie.stats;

// ── The defect ───────────────────────────────────────────────────────────────

test("a sheet that states its own max_hp keeps it when the character is wounded", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 4, max_hp: 20, dex: 16 }));

	assert.equal(statsOf(store).max_hp, 20);
	assert.equal(statsOf(store).hp, 4);
});

// ── What must not regress ────────────────────────────────────────────────────

test("a stored max_hp still wins over a re-submitted sheet", () => {
	// This is why the preservation exists: a client must not be able to raise its
	// own maximum by editing the sheet mid-game.
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 12, max_hp: 12, dex: 16 }));
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 12, max_hp: 999, dex: 16 }));

	assert.equal(statsOf(store).max_hp, 12);
});

test("a sheet with no max_hp still initialises it from current hp", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ hp: 9, dex: 16 }));

	assert.equal(statsOf(store).max_hp, 9);
});

test("a sheet with neither hp nor max_hp falls back to ten", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Sylvie", sheet({ dex: 16 }));

	assert.equal(statsOf(store).max_hp, 10);
});

// ── Spell picks ──────────────────────────────────────────────────────────────

test("a caster's spell picks are stored on the sheet", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", level: 1, stats: { hp: 8, max_hp: 8 },
		spells: ["Fire Bolt", "Magic Missile", "Shield"],
	});
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt", "Magic Missile", "Shield"]);
});

test("picks are stored as names, so the catalogue stays the one source of mechanics", () => {
	// Persisting the whole spell object would freeze a copy of its damage into every
	// lobby file, and a catalogue correction would never reach the characters.
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", stats: { hp: 8 },
		spells: [{ name: "Fire Bolt", damage: "99d99" }],
	});
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("a spell off the class list is dropped rather than stored", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", stats: { hp: 8 },
		spells: ["Fire Bolt", "Cure Wounds"],
	});
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("a spell above the lobby's starting level is dropped", () => {
	// The game master sets the ceiling; a client may not raise it.
	const store = makeStore();
	store.index.lob1.startingLevel = 1;
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", stats: { hp: 8 },
		spells: ["Fire Bolt", "Scorching Ray"],
	});
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("a higher starting level admits the higher-level pick", () => {
	const store = makeStore();
	store.index.lob1.startingLevel = 3;
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", stats: { hp: 8 },
		spells: ["Fire Bolt", "Scorching Ray"],
	});
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt", "Scorching Ray"]);
});

test("more picks than the allowance are refused, leaving the previous list intact", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 }, spells: ["Fire Bolt"] });
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", stats: { hp: 8 },
		spells: ["Fire Bolt", "Magic Missile", "Shield", "Sleep"],
	});
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("a non-caster cannot store spells", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Bron", {
		class: "Fighter", stats: { hp: 12 }, spells: ["Fire Bolt"],
	});
	assert.deepEqual(store.index.lob1.players.Bron.spells, []);
});

test("switching class clears spells that no longer apply", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 }, spells: ["Fire Bolt"] });
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Cleric", stats: { hp: 8 }, spells: ["Fire Bolt"] });
	assert.deepEqual(store.index.lob1.players.Elara.spells, []);
});

test("a sheet that omits spells does not wipe a stored list", () => {
	// The builder is not the only thing that saves a sheet; a mid-game re-save for a
	// name change must not disarm the caster, the way max_hp and abilities are guarded.
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 }, spells: ["Fire Bolt"] });
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 } });
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("a deliberately emptied list is respected", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 }, spells: ["Fire Bolt"] });
	store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 }, spells: [] });
	assert.deepEqual(store.index.lob1.players.Elara.spells, []);
});

test("a malformed spells field does not throw or corrupt the sheet", () => {
	const store = makeStore();
	for (const value of ["Fire Bolt", 42, {}, [null, 7]]) {
		store.upsertPlayer("lob1", "sid1", "Elara", { class: "Wizard", stats: { hp: 8 }, spells: value });
		assert.ok(Array.isArray(store.index.lob1.players.Elara.spells), `${JSON.stringify(value)} left a non-array`);
	}
});
