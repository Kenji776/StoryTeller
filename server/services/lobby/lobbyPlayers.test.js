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

// ── Learning a spell on level-up ─────────────────────────────────────────────

/**
 * @description A caster at a given level with a chosen spell list.
 * @param {object} store - The store double.
 * @param {number} level - The character level.
 * @param {string[]} spells - Spells already known.
 * @returns {object} The stored player record.
 */
function caster(store, level, spells) {
	store.upsertPlayer("lob1", "sid1", "Elara", {
		class: "Wizard", level, stats: { hp: 8, max_hp: 8 }, spells,
	});
	const player = store.index.lob1.players.Elara;
	player.level = level;   // upsert clamps level from the sheet; set it directly
	return player;
}

test("a caster learns a spell they picked", () => {
	const store = makeStore();
	store.index.lob1.startingLevel = 3;
	caster(store, 3, ["Fire Bolt"]);
	const result = store.learnSpell("lob1", "Elara", "Magic Missile");
	assert.equal(result.ok, true);
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt", "Magic Missile"]);
});

test("the pick may be a lower-level spell, not only the newest tier", () => {
	// The operator's rule: "from that level or lower".
	const store = makeStore();
	store.index.lob1.startingLevel = 3;
	caster(store, 3, ["Scorching Ray"]);
	assert.equal(store.learnSpell("lob1", "Elara", "Fire Bolt").ok, true);
	assert.ok(store.index.lob1.players.Elara.spells.includes("Fire Bolt"));
});

test("a spell above the character's level is refused", () => {
	const store = makeStore();
	caster(store, 1, ["Fire Bolt"]);
	const result = store.learnSpell("lob1", "Elara", "Scorching Ray");
	assert.equal(result.ok, false);
	assert.ok(result.reason);
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("a spell off the class list is refused", () => {
	const store = makeStore();
	caster(store, 3, ["Fire Bolt"]);
	const result = store.learnSpell("lob1", "Elara", "Cure Wounds");
	assert.equal(result.ok, false);
	assert.match(result.reason, /class/i);
});

test("a spell already known is refused rather than duplicated", () => {
	const store = makeStore();
	caster(store, 3, ["Fire Bolt"]);
	const result = store.learnSpell("lob1", "Elara", "Fire Bolt");
	assert.equal(result.ok, false);
	assert.match(result.reason, /already/i);
	assert.deepEqual(store.index.lob1.players.Elara.spells, ["Fire Bolt"]);
});

test("the level-up pick is not capped by the lobby's starting level", () => {
	// The starting level bounds character *creation*. A caster who levels past it must
	// keep gaining reach, or the pick would freeze at whatever the campaign began on.
	const store = makeStore();
	store.index.lob1.startingLevel = 1;
	caster(store, 3, ["Fire Bolt"]);
	assert.equal(store.learnSpell("lob1", "Elara", "Scorching Ray").ok, true);
});

test("a non-caster cannot learn a spell", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Bron", { class: "Fighter", stats: { hp: 12 } });
	const result = store.learnSpell("lob1", "Bron", "Fire Bolt");
	assert.equal(result.ok, false);
});

test("learning refuses junk rather than throwing", () => {
	const store = makeStore();
	caster(store, 3, ["Fire Bolt"]);
	for (const name of [null, undefined, "", 42, {}]) {
		assert.equal(store.learnSpell("lob1", "Elara", name).ok, false, JSON.stringify(name));
	}
	assert.equal(store.learnSpell("lob1", "Nobody", "Fire Bolt").ok, false);
	assert.equal(store.learnSpell("nolobby", "Elara", "Fire Bolt").ok, false);
});

test("the choices offered are what remains available at that level", () => {
	const store = makeStore();
	caster(store, 3, ["Fire Bolt"]);
	const choices = store.spellChoices("lob1", "Elara").map((s) => s.name);
	assert.ok(choices.length > 0);
	assert.ok(!choices.includes("Fire Bolt"), "already known");
	assert.ok(choices.includes("Scorching Ray"), "level 2, reachable at character level 3");
});

test("choices for a non-caster or a missing character are empty", () => {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Bron", { class: "Fighter", stats: { hp: 12 } });
	assert.deepEqual(store.spellChoices("lob1", "Bron"), []);
	assert.deepEqual(store.spellChoices("lob1", "Nobody"), []);
	assert.deepEqual(store.spellChoices("nolobby", "Elara"), []);
});

// ── Observers ────────────────────────────────────────────────────────────────

/**
 * @description A store with a host who has saved a character, plus room for more sockets.
 * @returns {object} The store double.
 */
function makeTable() {
	const store = makeStore();
	store.upsertPlayer("lob1", "sid1", "Ayla", { class: "Fighter", stats: { hp: 10, max_hp: 10 } });
	store.setReady("lob1", "sid1", true);
	return store;
}

test("a socket is not an observer unless it says so", () => {
	const store = makeTable();
	assert.equal(store.isObserver("lob1", "sid1"), false);
});

test("a connection can be opened as an observer", () => {
	const store = makeTable();
	store.addConnection("lob1", "sid2", { observer: true });
	assert.equal(store.isObserver("lob1", "sid2"), true);
});

test("an observer does not hold up the start of the game", () => {
	// The defect this exists to prevent: `allReady` required *every* socket to have a
	// character and be ready, so one watcher would have blocked the start forever.
	const store = makeTable();
	assert.equal(store.allReady("lob1"), true, "one ready player should be enough on their own");
	store.addConnection("lob1", "sid2", { observer: true });
	assert.equal(store.allReady("lob1"), true, "an observer must not block it");
});

test("a player still building their character does hold up the start", () => {
	// The distinction that matters, and the reason an explicit flag beats "has no
	// character": someone mid-build has no character *yet* and must still block, or the
	// host starts the game out from under them.
	const store = makeTable();
	store.addConnection("lob1", "sid2");
	assert.equal(store.allReady("lob1"), false);
});

test("a lobby of nothing but observers is never ready", () => {
	// Somebody has to actually play.
	const store = makeStore();
	store.addConnection("lob1", "sid2", { observer: true });
	store.addConnection("lob1", "sid3", { observer: true });
	assert.equal(store.allReady("lob1"), false);
});

test("an unready player still blocks even beside an observer", () => {
	const store = makeTable();
	store.upsertPlayer("lob1", "sid2", "Bron", { class: "Rogue", stats: { hp: 9, max_hp: 9 } });
	store.addConnection("lob1", "sid3", { observer: true });
	assert.equal(store.allReady("lob1"), false, "Bron has not readied");
	store.setReady("lob1", "sid2", true);
	assert.equal(store.allReady("lob1"), true);
});

test("observers are counted so the table can be told who is watching", () => {
	const store = makeTable();
	assert.equal(store.observerCount("lob1"), 0);
	store.addConnection("lob1", "sid2", { observer: true });
	store.addConnection("lob1", "sid3", { observer: true });
	store.addConnection("lob1", "sid4");
	assert.equal(store.observerCount("lob1"), 2);
});

test("an observer holds no character, so playerBySid finds nothing", () => {
	// Everything that resolves a socket to an actor goes through here, which is what
	// keeps an observer out of turns, rolls and the inactivity kick.
	const store = makeTable();
	store.addConnection("lob1", "sid2", { observer: true });
	assert.equal(store.playerBySid("lob1", "sid2"), null);
});

test("observer state survives a reconnect of the same socket id", () => {
	const store = makeTable();
	store.addConnection("lob1", "sid2", { observer: true });
	store.addConnection("lob1", "sid2");
	assert.equal(store.isObserver("lob1", "sid2"), true, "an existing record is not silently demoted");
});

test("asking about an unknown socket or lobby is false, not a throw", () => {
	const store = makeTable();
	assert.equal(store.isObserver("lob1", "nosuch"), false);
	assert.equal(store.isObserver("nolobby", "sid1"), false);
	assert.equal(store.observerCount("nolobby"), 0);
});

// ── Readiness is about characters, not sockets ───────────────────────────────

test("a second socket for the same character does not have to ready up too", () => {
	// The chat window is a separate connection that calls `chat:join` with the player's
	// name. Requiring *every socket* to be ready meant opening chat before the start
	// blocked the start — for real players as much as for watchers.
	const store = makeTable();
	store.addConnection("lob1", "sid1-chat");
	store.index.lob1.sockets["sid1-chat"].playerName = "Ayla";
	assert.equal(store.allReady("lob1"), true);
});

test("a socket naming somebody who is not a character is ignored", () => {
	// An observer's chat window arrives as a socket with a display handle and no
	// character. It is not a player, so it neither blocks the start nor satisfies it.
	const store = makeTable();
	store.addConnection("lob1", "watcher-chat");
	store.index.lob1.sockets["watcher-chat"].playerName = "Anon#8638";
	assert.equal(store.allReady("lob1"), true);
});

test("a lobby of only display handles is never ready", () => {
	const store = makeStore();
	store.addConnection("lob1", "chat-only");
	store.index.lob1.sockets["chat-only"].playerName = "Anon#1";
	assert.equal(store.allReady("lob1"), false);
});

test("a character is ready when any of their sockets is", () => {
	const store = makeTable();
	store.upsertPlayer("lob1", "sid2", "Bron", { class: "Rogue", stats: { hp: 9, max_hp: 9 } });
	store.addConnection("lob1", "sid2-chat");
	store.index.lob1.sockets["sid2-chat"].playerName = "Bron";
	assert.equal(store.allReady("lob1"), false, "Bron has not readied on any socket");
	store.setReady("lob1", "sid2", true);
	assert.equal(store.allReady("lob1"), true, "readying on one socket is enough");
});

test("a player still building their character blocks the start, as before", () => {
	// Unchanged behaviour, re-pinned: a nameless non-observer socket is somebody in the
	// builder, and the host must not start without them.
	const store = makeTable();
	store.addConnection("lob1", "sid2");
	assert.equal(store.allReady("lob1"), false);
});
