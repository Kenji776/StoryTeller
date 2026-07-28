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

// ── Automatic skill rolls ────────────────────────────────────────────────────

/**
 * @description Builds a store whose socket maps to a character, as autoRollIfNeeded
 *   requires. The die is not injectable here, so tests assert on the parts that do
 *   not depend on the face rolled.
 * @param {object} [stats] - Ability scores merged over the defaults.
 * @returns {{store: object, lobbyId: string}} The host.
 */
function makeRollStore(stats = {}) {
	const { store, lobbyId } = makeStore([{ name: "Ayla", dex: 10 }]);
	Object.assign(store.index[lobbyId].players.Ayla.stats, { str: 16, dex: 10, con: 10, int: 8, wis: 18, cha: 10, ...stats });
	store.index[lobbyId].sockets = { s1: { playerName: "Ayla" } };
	store.playerBySid = (id, sid) => {
		const rec = store.index[id]?.sockets?.[sid];
		return rec ? { name: rec.playerName, sheet: store.index[id].players[rec.playerName] } : null;
	};
	return { store, lobbyId };
}

test("searching rolls against wisdom, the sense that notices things", () => {
	// Perception is a WIS check. It was mapped to INT, so a perceptive character
	// with a poor intellect rolled at their weakest stat.
	const { store, lobbyId } = makeRollStore();
	const payload = store.autoRollIfNeeded(lobbyId, "s1", "I search the room for anything unusual.");
	assert.equal(payload.detail.stat, "wis");
});

test("a wisdom-based search applies the wisdom modifier", () => {
	const { store, lobbyId } = makeRollStore({ wis: 18 });   // +4
	const payload = store.autoRollIfNeeded(lobbyId, "s1", "I look around carefully.");
	assert.equal(payload.detail.bonus, 4);
});

test("attacking still rolls against strength", () => {
	const { store, lobbyId } = makeRollStore();
	assert.equal(store.autoRollIfNeeded(lobbyId, "s1", "I attack the goblin.").detail.stat, "str");
});

test("sneaking still rolls against dexterity", () => {
	const { store, lobbyId } = makeRollStore();
	assert.equal(store.autoRollIfNeeded(lobbyId, "s1", "I sneak past the guard.").detail.stat, "dex");
});

test("the roll label reads as a single signed modifier", () => {
	// It rendered "int++0" for a zero modifier and "int+-1" for a negative one,
	// because a literal plus sat in front of the sign logic.
	const { store, lobbyId } = makeRollStore({ wis: 10 });   // +0
	assert.match(store.autoRollIfNeeded(lobbyId, "s1", "I search the room.").kind, /wis\+0/);
});

test("a negative modifier reads with one sign, not two", () => {
	const { store, lobbyId } = makeRollStore({ wis: 6 });    // -2
	const label = store.autoRollIfNeeded(lobbyId, "s1", "I search the room.").kind;
	assert.match(label, /wis-2/);
	assert.ok(!label.includes("+-"), `"${label}" must not contain "+-"`);
});

test("a positive modifier keeps its plus sign", () => {
	const { store, lobbyId } = makeRollStore({ wis: 18 });   // +4
	assert.match(store.autoRollIfNeeded(lobbyId, "s1", "I search the room.").kind, /wis\+4/);
});

test("an action needing no roll returns nothing", () => {
	const { store, lobbyId } = makeRollStore();
	assert.equal(store.autoRollIfNeeded(lobbyId, "s1", "I say hello to the innkeeper."), null);
});

test("the total is the die plus the modifier", () => {
	const { store, lobbyId } = makeRollStore({ wis: 18 });
	const p = store.autoRollIfNeeded(lobbyId, "s1", "I search the room.");
	assert.equal(p.value, p.detail.base + p.detail.bonus);
});

// ===== updateEnemies: reporting kills =====
//
// The store knew exactly when an enemy died and told nobody, so XP could only ever
// be awarded if the Dungeon Master volunteered it. Across a 30-turn playtest it
// never did and every character finished at zero XP. `updateEnemies` now reports
// the transition, once, so an award can be made deterministically.

/**
 * @description Adds an enemy roster to a store built by `makeStore`.
 * @param {object} store - The host.
 * @param {object} enemies - Enemy records keyed by name.
 * @returns {void}
 */
function withEnemies(store, enemies) {
	store.index.lob1.enemies = enemies;
}

test("an enemy dropped to zero HP is reported as newly dead", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, { Goblin: { name: "Goblin", hp: 7, max_hp: 7, cr: "1/4", status: "active" } });

	const dead = store.updateEnemies(lobbyId, [{ name: "Goblin", hp: 0 }]);

	assert.equal(dead.length, 1);
	assert.equal(dead[0].name, "Goblin");
	assert.equal(dead[0].cr, "1/4");
});

test("an enemy marked dead by status is reported even with HP left", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, { Goblin: { name: "Goblin", hp: 7, max_hp: 7, cr: "1/4", status: "active" } });

	const dead = store.updateEnemies(lobbyId, [{ name: "Goblin", status: "dead" }]);
	assert.deepEqual(dead.map((e) => e.name), ["Goblin"]);
});

test("the same corpse is never reported twice", () => {
	// The model re-sends enemy blocks after combat ends. Without a guard the party
	// would be paid again for the same kill on every subsequent turn.
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, { Goblin: { name: "Goblin", hp: 7, max_hp: 7, cr: "1/4", status: "active" } });

	assert.equal(store.updateEnemies(lobbyId, [{ name: "Goblin", hp: 0 }]).length, 1);
	assert.equal(store.updateEnemies(lobbyId, [{ name: "Goblin", hp: 0 }]).length, 0);
	assert.equal(store.updateEnemies(lobbyId, [{ name: "Goblin", status: "dead" }]).length, 0);
});

test("wounding an enemy without killing it reports nothing", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, { Goblin: { name: "Goblin", hp: 7, max_hp: 7, cr: "1/4", status: "active" } });

	assert.deepEqual(store.updateEnemies(lobbyId, [{ name: "Goblin", hp: 3 }]), []);
});

test("an enemy that flees is not reported as a kill", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, { Goblin: { name: "Goblin", hp: 7, max_hp: 7, cr: "1/4", status: "active" } });

	assert.deepEqual(store.updateEnemies(lobbyId, [{ name: "Goblin", status: "fled" }]), []);
});

test("several kills in one update are all reported", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, {
		Goblin: { name: "Goblin", hp: 7, max_hp: 7, cr: "1/4", status: "active" },
		Wolf:   { name: "Wolf",   hp: 5, max_hp: 5, cr: "1/4", status: "active" },
	});

	const dead = store.updateEnemies(lobbyId, [{ name: "Goblin", hp: 0 }, { name: "Wolf", hp: 0 }]);
	assert.deepEqual(dead.map((e) => e.name).sort(), ["Goblin", "Wolf"]);
});

test("a purged enemy re-sent as dead is not resurrected into a payday", () => {
	// updateEnemies deliberately skips unknown dead enemies; they must not be
	// reported as kills either, or the model could mint XP by naming corpses.
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, {});

	assert.deepEqual(store.updateEnemies(lobbyId, [{ name: "Ghost", hp: 0, cr: "5" }]), []);
});

test("a malformed update yields no kills rather than throwing", () => {
	const { store, lobbyId } = makeStore([{ name: "Ayla" }]);
	withEnemies(store, {});

	for (const bad of [null, undefined, "x", 7, {}]) {
		assert.deepEqual(store.updateEnemies(lobbyId, bad), [], JSON.stringify(bad));
	}
	assert.deepEqual(store.updateEnemies("nope", [{ name: "Goblin", hp: 0 }]), []);
});

// ── Which stat an attack rolls ───────────────────────────────────────────────
//
// The keyword chain tested /attack|strike|shoot|swing/ before /sneak|stealth|hide/
// and hardcoded str for the whole branch. So a Rogue's Sneak Attack matched the
// attack branch on the literal word "Attack" and rolled STR — her worst stat — while
// plain sneaking on the same character correctly used DEX. Every ranged attack rolled
// STR too.

/**
 * @description Builds a roll store for a character with a chosen weapon.
 * @param {object} stats - Ability scores.
 * @param {object|null} weapon - The equipped weapon.
 * @returns {{store: object, lobbyId: string}} The host.
 */
function makeArmedStore(stats, weapon) {
	const { store, lobbyId } = makeRollStore(stats);
	store.index[lobbyId].players.Ayla.weapon = weapon;
	return { store, lobbyId };
}

const ROGUE = { str: 10, dex: 16 };
const FINESSE = { name: "Shortsword", damage: "1d6", damageType: "piercing", range: "melee" };

test("a rogue's Sneak Attack rolls dexterity, not strength", () => {
	const { store, lobbyId } = makeArmedStore(ROGUE, FINESSE);
	const payload = store.autoRollIfNeeded(lobbyId, "s1", "I use Sneak Attack on the distracted guard.");
	assert.equal(payload.detail.stat, "dex");
	assert.equal(payload.detail.bonus, 3);
});

test("a sneak attack is still an attack, not a stealth check", () => {
	// Fixing the stat by reordering the chain would have turned it into a stealth
	// roll against the wrong DC. It is an attack made with dexterity.
	const { store, lobbyId } = makeArmedStore(ROGUE, FINESSE);
	assert.match(store.autoRollIfNeeded(lobbyId, "s1", "I use Sneak Attack on the guard.").kind, /ATTACK/i);
});

test("a ranged attack rolls dexterity whatever the character's strength", () => {
	const { store, lobbyId } = makeArmedStore({ str: 18, dex: 14 }, { name: "Longbow", range: "ranged" });
	const payload = store.autoRollIfNeeded(lobbyId, "s1", "I shoot the goblin.");
	assert.equal(payload.detail.stat, "dex");
});

test("shooting is a dexterity attack even with no weapon recorded", () => {
	const { store, lobbyId } = makeArmedStore({ str: 18, dex: 14 }, null);
	assert.equal(store.autoRollIfNeeded(lobbyId, "s1", "I fire an arrow at it.").detail.stat, "dex");
});

test("a finesse weapon uses whichever of strength or dexterity is better", () => {
	const strong = makeArmedStore({ str: 18, dex: 10 }, FINESSE);
	assert.equal(strong.store.autoRollIfNeeded(strong.lobbyId, "s1", "I attack the goblin.").detail.stat, "str");

	const quick = makeArmedStore({ str: 10, dex: 18 }, FINESSE);
	assert.equal(quick.store.autoRollIfNeeded(quick.lobbyId, "s1", "I attack the goblin.").detail.stat, "dex");
});

test("a heavy melee weapon still rolls strength", () => {
	const { store, lobbyId } = makeArmedStore({ str: 10, dex: 18 }, { name: "Greataxe", range: "melee" });
	assert.equal(store.autoRollIfNeeded(lobbyId, "s1", "I swing at the goblin.").detail.stat, "str");
});

test("an unarmed character attacking rolls strength", () => {
	const { store, lobbyId } = makeArmedStore({ str: 14, dex: 16 }, null);
	assert.equal(store.autoRollIfNeeded(lobbyId, "s1", "I attack the goblin with my fists.").detail.stat, "str");
});

test("plain sneaking is still a dexterity stealth check", () => {
	const { store, lobbyId } = makeArmedStore(ROGUE, FINESSE);
	const payload = store.autoRollIfNeeded(lobbyId, "s1", "I sneak past the guard.");
	assert.equal(payload.detail.stat, "dex");
	assert.match(payload.kind, /STEALTH/i);
});

test("the roll label names the stat actually used", () => {
	const { store, lobbyId } = makeArmedStore(ROGUE, FINESSE);
	assert.match(store.autoRollIfNeeded(lobbyId, "s1", "I use Sneak Attack.").kind, /dex\+3/);
});

test("lighting a fire is not an attack", () => {
	// "fire" is matched only when followed by something you fire, or by "at".
	// Matching it bare would have turned every campfire and fire bolt into an
	// attack roll against a target that does not exist.
	const { store, lobbyId } = makeArmedStore({ str: 12, dex: 12 }, null);
	for (const text of ["I light a fire in the hearth.", "I set fire to the rope."]) {
		const payload = store.autoRollIfNeeded(lobbyId, "s1", text);
		assert.ok(payload === null || payload.kind.toLowerCase().includes("attack") === false, `${text} -> ${payload?.kind}`);
	}
});

test("firing at a target is an attack", () => {
	const { store, lobbyId } = makeArmedStore({ str: 18, dex: 14 }, null);
	assert.match(store.autoRollIfNeeded(lobbyId, "s1", "I fire at the goblin.").kind, /ATTACK/i);
});
