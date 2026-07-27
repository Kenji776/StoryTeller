import { test } from "node:test";
import assert from "node:assert/strict";

import { createRepairs, REPAIRS } from "./adminRepairs.js";

/**
 * Builds the repair surface over a fake lobby.
 *
 * @description Every collaborator is injected, so repairs are unit-testable without
 *   sockets. The lobby mirrors the persisted shape, including the fields repairs are
 *   meant to correct (`dead`, `initiative`, `uiLock`).
 * @param {object} [opts] - Overrides merged into the player record.
 * @returns {object} The repair surface plus assertion handles.
 */
function makeRepairs(opts = {}) {
	const emits = [];
	const lobby = {
		lobbyId: "lob1",
		phase: "running",
		initiative: ["Ayla", "Brom"],
		turnIndex: 0,
		round: 2,
		players: {
			Ayla: { name: "Ayla", level: 3, dead: false, stats: { hp: 12, max_hp: 24, dex: 12 }, spellSlotsUsed: 2, conditions: [], ...opts.ayla },
			Brom: { name: "Brom", level: 3, dead: false, stats: { hp: 20, max_hp: 20, dex: 10 }, spellSlotsUsed: 0, conditions: [] },
		},
		sockets: {},
	};

	const store = {
		index: { lob1: lobby },
		persist() {},
		turnInfo: () => ({ current: lobby.initiative[lobby.turnIndex] ?? null, order: lobby.initiative, round: lobby.round }),
		publicState: () => ({ lobbyId: "lob1", phase: lobby.phase }),
		insertIntoInitiative: (id, name) => { if (!lobby.initiative.includes(name)) lobby.initiative.push(name); return 10; },
		removeFromTurnOrder: (id, name) => { lobby.initiative = lobby.initiative.filter((n) => n !== name); },
	};

	const repairs = createRepairs({
		store,
		log: () => {},
		emitToLobby: (lobbyId, event, payload) => emits.push({ lobbyId, event, payload }),
		broadcastPartyState: () => emits.push({ event: "party:update" }),
	});

	return { repairs, lobby, emits, run: (type, payload) => repairs.apply("lob1", type, payload) };
}

// ── Revive ───────────────────────────────────────────────────────────────────

test("revive clears the dead flag", () => {
	const h = makeRepairs({ ayla: { dead: true, stats: { hp: 0, max_hp: 24 } } });
	h.run(REPAIRS.REVIVE, { player: "Ayla" });
	assert.equal(h.lobby.players.Ayla.dead, false);
});

test("revive restores hit points, because a living character at zero is still down", () => {
	const h = makeRepairs({ ayla: { dead: true, stats: { hp: 0, max_hp: 24 } } });
	h.run(REPAIRS.REVIVE, { player: "Ayla", hp: 5 });
	assert.equal(h.lobby.players.Ayla.stats.hp, 5);
});

test("revive defaults to one hit point when none is given", () => {
	const h = makeRepairs({ ayla: { dead: true, stats: { hp: 0, max_hp: 24 } } });
	h.run(REPAIRS.REVIVE, { player: "Ayla" });
	assert.equal(h.lobby.players.Ayla.stats.hp, 1);
});

test("revive puts the character back in the turn order", () => {
	const h = makeRepairs({ ayla: { dead: true } });
	h.lobby.initiative = ["Brom"];
	h.run(REPAIRS.REVIVE, { player: "Ayla" });
	assert.ok(h.lobby.initiative.includes("Ayla"));
});

test("revive reports what it did", () => {
	const h = makeRepairs({ ayla: { dead: true } });
	assert.equal(h.run(REPAIRS.REVIVE, { player: "Ayla" }).ok, true);
});

// ── Setting values directly ──────────────────────────────────────────────────

test("hit points can be set to an exact value, not only nudged by a delta", () => {
	// The existing admin panel only offers deltas, so correcting a wrong number
	// means computing the difference by hand.
	const h = makeRepairs();
	h.run(REPAIRS.SET_HP, { player: "Ayla", hp: 17 });
	assert.equal(h.lobby.players.Ayla.stats.hp, 17);
});

test("setting hit points above the maximum is clamped", () => {
	const h = makeRepairs();
	h.run(REPAIRS.SET_HP, { player: "Ayla", hp: 999 });
	assert.equal(h.lobby.players.Ayla.stats.hp, 24);
});

test("setting hit points below zero is clamped", () => {
	const h = makeRepairs();
	h.run(REPAIRS.SET_HP, { player: "Ayla", hp: -5 });
	assert.equal(h.lobby.players.Ayla.stats.hp, 0);
});

test("spent ability uses can be reset, which nothing else can do outside a long rest", () => {
	const h = makeRepairs();
	h.run(REPAIRS.SET_SLOTS, { player: "Ayla", used: 0 });
	assert.equal(h.lobby.players.Ayla.spellSlotsUsed, 0);
});

test("spent ability uses cannot exceed the character's level", () => {
	const h = makeRepairs();
	h.run(REPAIRS.SET_SLOTS, { player: "Ayla", used: 99 });
	assert.equal(h.lobby.players.Ayla.spellSlotsUsed, 3);
});

test("conditions can be replaced outright", () => {
	const h = makeRepairs({ ayla: { conditions: ["poisoned", "prone"] } });
	h.run(REPAIRS.SET_CONDITIONS, { player: "Ayla", conditions: ["blessed"] });
	assert.deepEqual(h.lobby.players.Ayla.conditions, ["blessed"]);
});

test("conditions can be cleared entirely", () => {
	const h = makeRepairs({ ayla: { conditions: ["poisoned"] } });
	h.run(REPAIRS.SET_CONDITIONS, { player: "Ayla", conditions: [] });
	assert.deepEqual(h.lobby.players.Ayla.conditions, []);
});

// ── Turn order ───────────────────────────────────────────────────────────────

test("the active turn can be handed to a named player", () => {
	const h = makeRepairs();
	h.run(REPAIRS.SET_TURN, { player: "Brom" });
	assert.equal(h.lobby.initiative[h.lobby.turnIndex], "Brom");
});

test("handing the turn to someone outside the order is refused", () => {
	const h = makeRepairs();
	const res = h.run(REPAIRS.SET_TURN, { player: "Nobody" });
	assert.equal(res.ok, false);
});

test("the turn order can be rebuilt from the living players", () => {
	// The recovery when the order has been corrupted -- emptied, duplicated, or
	// holding someone who left.
	const h = makeRepairs();
	h.lobby.initiative = ["Ayla", "Ayla", "Ghost"];
	h.run(REPAIRS.REBUILD_ORDER, {});
	assert.deepEqual([...h.lobby.initiative].sort(), ["Ayla", "Brom"]);
});

test("rebuilding the order excludes the dead", () => {
	const h = makeRepairs({ ayla: { dead: true } });
	h.lobby.initiative = [];
	h.run(REPAIRS.REBUILD_ORDER, {});
	assert.deepEqual(h.lobby.initiative, ["Brom"]);
});

test("rebuilding resets the turn index into range", () => {
	const h = makeRepairs();
	h.lobby.turnIndex = 99;
	h.run(REPAIRS.REBUILD_ORDER, {});
	assert.ok(h.lobby.turnIndex < h.lobby.initiative.length);
});

// ── Unsticking the interface ─────────────────────────────────────────────────

test("a stuck action overlay can be released for everyone", () => {
	const h = makeRepairs();
	h.run(REPAIRS.UNLOCK_UI, {});
	assert.ok(h.emits.some((e) => e.event === "ui:unlock"));
});

test("a forced resync pushes fresh state to the whole lobby", () => {
	const h = makeRepairs();
	h.run(REPAIRS.FORCE_RESYNC, {});
	assert.ok(h.emits.some((e) => e.event === "state:update"));
});

// ── Guards ───────────────────────────────────────────────────────────────────

test("an unknown repair type is refused rather than ignored", () => {
	const h = makeRepairs();
	const res = h.run("nonsense:repair", {});
	assert.equal(res.ok, false);
	assert.match(res.reason, /unknown/i);
});

test("a repair naming a player who does not exist is refused", () => {
	const h = makeRepairs();
	assert.equal(h.run(REPAIRS.SET_HP, { player: "Nobody", hp: 5 }).ok, false);
});

test("a repair on an unknown lobby is refused without throwing", () => {
	const h = makeRepairs();
	assert.doesNotThrow(() => h.repairs.apply("nope", REPAIRS.UNLOCK_UI, {}));
	assert.equal(h.repairs.apply("nope", REPAIRS.UNLOCK_UI, {}).ok, false);
});

test("every repair broadcasts the corrected state, so players see the fix at once", () => {
	const h = makeRepairs();
	h.run(REPAIRS.SET_HP, { player: "Ayla", hp: 10 });
	assert.ok(h.emits.some((e) => e.event === "state:update"), "a repair nobody can see is not a repair");
});

test("the catalogue lists every repair with a label for the admin interface", () => {
	const h = makeRepairs();
	const listed = h.repairs.catalogue();
	assert.equal(listed.length, Object.keys(REPAIRS).length);
	for (const entry of listed) {
		assert.ok(entry.type && entry.label, `${JSON.stringify(entry)} needs a type and a label`);
	}
});
