import { test } from "node:test";
import assert from "node:assert/strict";

import { combatMethods } from "./lobbyCombat.js";

/**
 * Builds a minimal store exposing the combat mixin over a single lobby.
 *
 * @description The mixin is written against `this.index` and `this.persist`, so a
 *   plain object carrying those is a sufficient host — no filesystem, no real
 *   LobbyStore, no I/O (`TDD-8`). `persist` is counted rather than performed so
 *   tests can assert that mutations are durable without touching disk.
 * @param {Array<{name: string, dex?: number, dead?: boolean}>} roster - Party members.
 * @returns {{store: object, lobbyId: string, persists: function(): number}} The host.
 */
function makeStore(roster) {
	let persistCount = 0;
	const players = {};
	const sockets = {};
	roster.forEach((p, i) => {
		players[p.name] = {
			name: p.name,
			stats: { dex: p.dex ?? 10, hp: 10, max_hp: 10 },
			dead: !!p.dead,
		};
		sockets[`sock-${i}`] = { playerName: p.name };
	});

	const store = {
		index: { lob1: { lobbyId: "lob1", phase: "waiting", players, sockets, initiative: [], turnIndex: 0 } },
		persist() { persistCount++; },
		// Supplied by the players mixin in production; the combat methods collaborate
		// with it, so the host must provide an equivalent for exact-name lookup.
		findPlayerKey(lobbyId, name) {
			return this.index[lobbyId]?.players?.[name] ? name : null;
		},
		...combatMethods,
	};
	return { store, lobbyId: "lob1", persists: () => persistCount };
}

/**
 * A deterministic d20 that walks a fixed script.
 *
 * @description Initiative is the one place randomness genuinely drives ordering, so
 *   the die is injected rather than stubbed globally. Values cycle if the script runs
 *   short, which keeps tests robust when a roster grows.
 * @param {number[]} values - The sequence of faces to return.
 * @returns {function(): number} The scripted die.
 */
function scriptedD20(values) {
	let i = 0;
	return () => values[i++ % values.length];
}

// ── rollInitiative ───────────────────────────────────────────────────────────

test("rollInitiative orders the party by rolled total, highest first", () => {
	const { store, lobbyId } = makeStore([
		{ name: "Ayla", dex: 10 },   // roll 5  + 0 = 5
		{ name: "Brom", dex: 10 },   // roll 18 + 0 = 18
		{ name: "Cass", dex: 10 },   // roll 11 + 0 = 11
	]);
	store.rollInitiative(lobbyId, scriptedD20([5, 18, 11]));
	assert.deepEqual(store.index[lobbyId].initiative, ["Brom", "Cass", "Ayla"]);
});

test("rollInitiative adds the dexterity modifier to the die", () => {
	const { store, lobbyId } = makeStore([
		{ name: "Ayla", dex: 18 },   // roll 10 + 4 = 14
		{ name: "Brom", dex: 10 },   // roll 12 + 0 = 12
	]);
	store.rollInitiative(lobbyId, scriptedD20([10, 12]));
	assert.deepEqual(store.index[lobbyId].initiative, ["Ayla", "Brom"]);
});

test("rollInitiative records each player's total so later joins can be compared to it", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla", dex: 14 }]);
	store.rollInitiative(lobbyId, scriptedD20([9]));
	assert.equal(store.index[lobbyId].players.Ayla.initiativeTotal, 11); // 9 + 2
});

test("rollInitiative returns a breakdown suitable for announcing to the table", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla", dex: 14 }, { name: "Brom", dex: 8 }]);
	const result = store.rollInitiative(lobbyId, scriptedD20([9, 15]));
	assert.deepEqual(result, [
		{ name: "Brom", roll: 15, dexMod: -1, total: 14 },
		{ name: "Ayla", roll: 9, dexMod: 2, total: 11 },
	]);
});

test("rollInitiative breaks a tied total by dexterity modifier", () => {
	const { store, lobbyId } = makeStore([
		{ name: "Ayla", dex: 10 },   // roll 12 + 0 = 12
		{ name: "Brom", dex: 14 },   // roll 10 + 2 = 12
	]);
	store.rollInitiative(lobbyId, scriptedD20([12, 10]));
	assert.deepEqual(store.index[lobbyId].initiative, ["Brom", "Ayla"]);
});

test("rollInitiative breaks a fully tied result by name, so the order is never arbitrary", () => {
	const { store, lobbyId } = makeStore([{ name: "Zara", dex: 10 }, { name: "Ayla", dex: 10 }]);
	store.rollInitiative(lobbyId, scriptedD20([10, 10]));
	assert.deepEqual(store.index[lobbyId].initiative, ["Ayla", "Zara"]);
});

test("rollInitiative starts the table at the top of the order on round one", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([10, 5]));
	assert.equal(store.index[lobbyId].turnIndex, 0);
	assert.equal(store.index[lobbyId].round, 1);
});

test("rollInitiative excludes dead players from the order", () => {
	const { store, lobbyId } = makeStore([
		{ name: "Ayla" },
		{ name: "Ghost", dead: true },
		{ name: "Brom" },
	]);
	store.rollInitiative(lobbyId, scriptedD20([10, 20]));
	assert.ok(!store.index[lobbyId].initiative.includes("Ghost"));
	assert.deepEqual(store.index[lobbyId].initiative, ["Brom", "Ayla"]);
});

test("rollInitiative does not spend a die on a dead player", () => {
	// Only the living roll, so the script maps one-to-one onto the survivors. If a
	// corpse consumed a die, every subsequent player would receive the wrong roll.
	const { store, lobbyId } = makeStore([
		{ name: "Ayla" },
		{ name: "Ghost", dead: true },
		{ name: "Brom" },
	]);
	const rolls = store.rollInitiative(lobbyId, scriptedD20([10, 20]));
	assert.deepEqual(
		rolls.map((r) => [r.name, r.roll]).sort(),
		[["Ayla", 10], ["Brom", 20]],
	);
});

test("rollInitiative persists the result", () => {
	const { store, lobbyId, persists } = makeStore([{ name: "Ayla" }]);
	const before = persists();
	store.rollInitiative(lobbyId, scriptedD20([10]));
	assert.ok(persists() > before);
});

test("rollInitiative on an unknown lobby is a harmless no-op", () => {
	const { store } = makeStore([{ name: "Ayla" }]);
	assert.doesNotThrow(() => store.rollInitiative("nope", scriptedD20([10])));
});

// ── insertIntoInitiative: the rejoin path ────────────────────────────────────

test("a late arrival is placed by their rolled total, not at the front", () => {
	const { store, lobbyId } = makeStore([
		{ name: "Ayla", dex: 10 },
		{ name: "Brom", dex: 10 },
		{ name: "Cass", dex: 10 },
	]);
	store.rollInitiative(lobbyId, scriptedD20([18, 12, 4])); // Ayla 18, Brom 12, Cass 4
	store.index[lobbyId].players.Dane = { name: "Dane", stats: { dex: 10 }, dead: false };
	store.insertIntoInitiative(lobbyId, "Dane", scriptedD20([8]));  // 8 sits between Brom and Cass
	assert.deepEqual(store.index[lobbyId].initiative, ["Ayla", "Brom", "Dane", "Cass"]);
});

test("a rejoining player does not displace the existing order_regression", () => {
	// The live defect: rejoin compared raw DEX against a list that was never
	// DEX-sorted, so an average-DEX player was spliced in at index 0 and jumped
	// ahead of the whole party.
	const { store, lobbyId } = makeStore([
		{ name: "Brannor", dex: 11 },
		{ name: "Sylvie", dex: 16 },
		{ name: "Orrin", dex: 12 },
	]);
	store.rollInitiative(lobbyId, scriptedD20([19, 14, 3])); // Brannor 19, Sylvie 17, Orrin 4
	const before = [...store.index[lobbyId].initiative];
	store.removeFromTurnOrder(lobbyId, "Orrin");
	// Deliberately a *different* die than the original. A rejoin must restore the
	// seat the player already rolled for, not roll again — otherwise dropping and
	// reconnecting is a way to re-roll a bad initiative.
	store.insertIntoInitiative(lobbyId, "Orrin", scriptedD20([20]));
	assert.deepEqual(store.index[lobbyId].initiative, before, "rejoining must restore the same order");
	assert.notEqual(store.index[lobbyId].initiative[0], "Orrin");
});

test("a returning player keeps their original initiative instead of re-rolling", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla", dex: 10 }, { name: "Brom", dex: 10 }]);
	store.rollInitiative(lobbyId, scriptedD20([4, 18]));   // Brom 18, Ayla 4
	const aylaTotal = store.index[lobbyId].players.Ayla.initiativeTotal;
	store.removeFromTurnOrder(lobbyId, "Ayla");
	const restored = store.insertIntoInitiative(lobbyId, "Ayla", scriptedD20([20]));
	assert.equal(restored, aylaTotal, "the stored total is reused, not re-rolled");
	assert.deepEqual(store.index[lobbyId].initiative, ["Brom", "Ayla"]);
});

test("a genuinely new arrival rolls, because they have no seat yet", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla", dex: 10 }, { name: "Brom", dex: 10 }]);
	store.rollInitiative(lobbyId, scriptedD20([4, 18]));
	store.index[lobbyId].players.Dane = { name: "Dane", stats: { dex: 10 }, dead: false };
	const total = store.insertIntoInitiative(lobbyId, "Dane", scriptedD20([20]));
	assert.equal(total, 20);
	assert.equal(store.index[lobbyId].initiative[0], "Dane");
});

test("insertIntoInitiative returns the seat total it settled on", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla", dex: 14 }]);
	store.rollInitiative(lobbyId, scriptedD20([10]));            // Ayla = 10 + 2 = 12
	const returned = store.insertIntoInitiative(lobbyId, "Ayla", scriptedD20([7]));
	assert.equal(returned, 12, "an existing player's seat is returned, not a fresh roll");
	assert.equal(returned, store.index[lobbyId].players.Ayla.initiativeTotal);
});

test("insertIntoInitiative never duplicates a player already in the order", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([10, 5]));
	store.insertIntoInitiative(lobbyId, "Ayla", scriptedD20([20]));
	assert.equal(store.index[lobbyId].initiative.filter((n) => n === "Ayla").length, 1);
});

test("insertIntoInitiative places the highest roll at the front", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([10, 5]));
	store.index[lobbyId].players.Dane = { name: "Dane", stats: { dex: 10 }, dead: false };
	store.insertIntoInitiative(lobbyId, "Dane", scriptedD20([20]));
	assert.equal(store.index[lobbyId].initiative[0], "Dane");
});

test("insertIntoInitiative places the lowest roll at the back", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([10, 5]));
	store.index[lobbyId].players.Dane = { name: "Dane", stats: { dex: 10 }, dead: false };
	store.insertIntoInitiative(lobbyId, "Dane", scriptedD20([1]));
	assert.equal(store.index[lobbyId].initiative.at(-1), "Dane");
});

test("insertIntoInitiative ignores a player the lobby has never heard of", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	store.rollInitiative(lobbyId, scriptedD20([10]));
	store.insertIntoInitiative(lobbyId, "Nobody", scriptedD20([20]));
	assert.deepEqual(store.index[lobbyId].initiative, ["Ayla"]);
});

// ── Rounds ───────────────────────────────────────────────────────────────────

test("nextTurn advances through the order without changing the round", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }, { name: "Cass" }]);
	store.rollInitiative(lobbyId, scriptedD20([20, 15, 10]));
	const r = store.nextTurn(lobbyId);
	assert.equal(r.current, "Brom");
	assert.equal(r.round, 1);
	assert.equal(r.roundAdvanced, false);
});

test("a new round begins when the order wraps back to the top", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([20, 10]));
	store.nextTurn(lobbyId);              // -> Brom
	const r = store.nextTurn(lobbyId);    // wraps -> Ayla, round 2
	assert.equal(r.current, "Ayla");
	assert.equal(r.round, 2);
	assert.equal(r.roundAdvanced, true);
});

test("the round counter keeps climbing across several full cycles", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([20, 10]));
	for (let i = 0; i < 6; i++) store.nextTurn(lobbyId);
	assert.equal(store.index[lobbyId].round, 4);
});

test("a solo survivor still advances the round on every turn", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	store.rollInitiative(lobbyId, scriptedD20([10]));
	const r = store.nextTurn(lobbyId);
	assert.equal(r.current, "Ayla");
	assert.equal(r.roundAdvanced, true);
	assert.equal(r.round, 2);
});

test("nextTurn skips the dead and still reports the round", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }, { name: "Cass" }]);
	store.rollInitiative(lobbyId, scriptedD20([20, 15, 10]));
	store.index[lobbyId].players.Brom.dead = true;
	const r = store.nextTurn(lobbyId);
	assert.equal(r.current, "Cass");
});

test("nextTurn on an empty order reports no current player rather than throwing", () => {
	const { store, lobbyId } = makeStore([]);
	store.rollInitiative(lobbyId, scriptedD20([10]));
	const r = store.nextTurn(lobbyId);
	assert.equal(r.current, null);
});

test("advancing the turn clears the previous player's rejected attempts", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([20, 10]));
	store.index[lobbyId].turnAttempts = { player: "Ayla", count: 2 };
	store.nextTurn(lobbyId);
	assert.equal(store.index[lobbyId].turnAttempts, null, "strikes must not follow the turn to the next player");
});

test("turnInfo reports the round alongside the order", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }, { name: "Brom" }]);
	store.rollInitiative(lobbyId, scriptedD20([20, 10]));
	assert.equal(store.turnInfo(lobbyId).round, 1);
});
