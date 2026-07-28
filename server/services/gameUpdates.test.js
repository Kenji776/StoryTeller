import { test } from "node:test";
import assert from "node:assert/strict";

import { broadcastHPUpdates, broadcastGoldUpdates, configureUpdates } from "./gameUpdates.js";
import { createIncidentLog } from "./incidents.js";
import { progressionMethods } from "./lobby/lobbyProgression.js";

/**
 * Builds the collaborators the broadcast helpers need.
 *
 * @description `io` and `store` are doubles; the incident log is real, because the
 *   behaviour under test is that a dropped update actually reaches it.
 * @param {object} [opts] - Overrides.
 * @returns {object} The doubles plus assertion handles.
 */
function makeDeps(opts = {}) {
	const emitted = [];
	const io = { to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };

	const lobby = {
		lobbyId: "lob1",
		players: { Ayla: { name: "Ayla", stats: { hp: 20, max_hp: 20 }, gold: 10 } },
		initiative: ["Ayla"],
		turnIndex: 0,
		...opts.lobby,
	};

	const store = {
		index: { lob1: lobby },
		persist() {},
		findPlayerKey: (id, name) => (lobby.players[name] ? name : null),
		// Delegated to the real implementations rather than reimplemented as `+=`.
		// A hand-written double drifts from the code it stands in for: this one lacked
		// the max_hp ceiling, so it would have gone on passing after the ceiling was
		// added and hidden any regression in it.
		applyHPChange: (...args) => progressionMethods.applyHPChange.call(store, ...args),
		applyGoldChange: (...args) => progressionMethods.applyGoldChange.call(store, ...args),
		markPlayerDead() {},
		removeFromTurnOrder() {},
		turnInfo: () => ({ current: "Ayla", order: ["Ayla"], round: 1 }),
	};

	return { io, store, emitted, lobby };
}

test("an update naming a real character is applied and broadcast", () => {
	const { io, store, emitted } = makeDeps();
	configureUpdates({ incidents: null });
	broadcastHPUpdates(io, store, "lob1", [{ player: "Ayla", delta: -5 }]);
	assert.ok(emitted.some((e) => e.event === "hp:update"));
});

test("an update naming a character who does not exist raises an incident", () => {
	// The failure this closes: the DM narrates that someone took damage, the name
	// matches nobody, the update vanishes, and the only trace is a console warning
	// on the server. The player watches their HP not change and never learns why.
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store } = makeDeps();

	broadcastHPUpdates(io, store, "lob1", [{ player: "Thoradin", delta: -9 }]);

	const raised = incidents.list("lob1");
	assert.equal(raised.length, 1);
	assert.equal(raised[0].kind, "update_dropped");
});

test("a dropped update is recorded as an error, not a warning", () => {
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store } = makeDeps();
	broadcastHPUpdates(io, store, "lob1", [{ player: "Thoradin", delta: -9 }]);
	assert.equal(incidents.list("lob1")[0].severity, "error");
});

test("the incident names both the missing character and the ones that exist", () => {
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store } = makeDeps();

	broadcastHPUpdates(io, store, "lob1", [{ player: "Thoradin", delta: -9 }]);
	const { detail, message } = incidents.list("lob1")[0];

	assert.match(message, /Thoradin/);
	assert.equal(detail.named, "Thoradin");
	assert.deepEqual(detail.known, ["Ayla"], "an admin needs the real names to spot the mismatch");
});

test("the incident says which update was lost", () => {
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store } = makeDeps();
	broadcastGoldUpdates(io, store, "lob1", [{ player: "Ghost", delta: 50 }]);
	assert.equal(incidents.list("lob1")[0].detail.event, "gold:update");
});

test("the incident carries a suggested fix an admin can act on", () => {
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store } = makeDeps();
	broadcastHPUpdates(io, store, "lob1", [{ player: "Ghost", delta: -3 }]);
	assert.ok(incidents.list("lob1")[0].suggestedFix);
});

test("a dropped update does not stop the valid updates beside it", () => {
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store, emitted } = makeDeps();

	broadcastHPUpdates(io, store, "lob1", [
		{ player: "Ghost", delta: -3 },
		{ player: "Ayla", delta: -4 },
	]);

	assert.ok(emitted.some((e) => e.event === "hp:update" && e.payload.player === "Ayla"));
	assert.equal(incidents.list("lob1").length, 1);
});

test("updates still work when no incident log has been configured", () => {
	// configureUpdates is called once at startup; a unit importing the module in
	// isolation must not crash for want of it.
	configureUpdates({ incidents: null });
	const { io, store, emitted } = makeDeps();
	assert.doesNotThrow(() => broadcastHPUpdates(io, store, "lob1", [{ player: "Ghost", delta: -1 }]));
	assert.equal(emitted.length, 0);
});

// ── Ability grants and losses ────────────────────────────────────────────────

/**
 * @description Extends the shared doubles with the ability-related store methods.
 * @param {object} [opts] - Overrides forwarded to makeDeps.
 * @returns {object} The doubles.
 */
function makeAbilityDeps(opts = {}) {
	const deps = makeDeps(opts);
	const players = deps.lobby.players;
	deps.store.addAbility = (id, name, ability) => {
		const key = players[name] ? name : null;
		if (!key || !ability) return;
		players[key].abilities = Array.isArray(players[key].abilities) ? players[key].abilities : [];
		if (!players[key].abilities.some((a) => a.name === ability.name)) players[key].abilities.push(ability);
	};
	deps.store.removeAbility = (id, name, abilityName) => {
		const key = players[name] ? name : null;
		if (!key || !Array.isArray(players[key].abilities)) return false;
		const before = players[key].abilities.length;
		players[key].abilities = players[key].abilities.filter((a) => a.name !== abilityName);
		return players[key].abilities.length < before;
	};
	return deps;
}

test("the DM can grant an ability, which was previously advertised and then discarded", async () => {
	// lobbyPrompts tells the DM it may return updates.abilities with change_type
	// add/remove. No dispatch path read the field, so every granted ability was lost.
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	configureUpdates({ incidents: null });
	const { io, store, lobby, emitted } = makeAbilityDeps();

	broadcastAbilityUpdates(io, store, "lob1", [
		{ player: "Ayla", change_type: "add", name: "Shield Bash", description: "Slam with your shield." },
	]);

	assert.ok(lobby.players.Ayla.abilities.some((a) => a.name === "Shield Bash"));
	assert.ok(emitted.some((e) => e.event === "abilities:update"));
});

test("a granted ability keeps its description, so the player knows what it does", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	const { io, store, lobby } = makeAbilityDeps();
	broadcastAbilityUpdates(io, store, "lob1", [
		{ player: "Ayla", change_type: "add", name: "Shield Bash", description: "Slam with your shield." },
	]);
	assert.equal(lobby.players.Ayla.abilities.find((a) => a.name === "Shield Bash").description, "Slam with your shield.");
});

test("the DM can take an ability away", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	const { io, store, lobby } = makeAbilityDeps();
	lobby.players.Ayla.abilities = [{ name: "Cursed Gift", description: "It whispers." }];
	broadcastAbilityUpdates(io, store, "lob1", [{ player: "Ayla", change_type: "remove", name: "Cursed Gift" }]);
	assert.deepEqual(lobby.players.Ayla.abilities, []);
});

test("granting the same ability twice does not duplicate it", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	const { io, store, lobby } = makeAbilityDeps();
	const grant = { player: "Ayla", change_type: "add", name: "Shield Bash", description: "d" };
	broadcastAbilityUpdates(io, store, "lob1", [grant]);
	broadcastAbilityUpdates(io, store, "lob1", [grant]);
	assert.equal(lobby.players.Ayla.abilities.filter((a) => a.name === "Shield Bash").length, 1);
});

test("the schema says attributes but the real data says details, so both are accepted", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	const { io, store, lobby } = makeAbilityDeps();
	broadcastAbilityUpdates(io, store, "lob1", [
		{ player: "Ayla", change_type: "add", name: "A", attributes: { uses: 2 } },
		{ player: "Ayla", change_type: "add", name: "B", details: { uses: 3 } },
	]);
	const byName = Object.fromEntries(lobby.players.Ayla.abilities.map((a) => [a.name, a.details]));
	assert.deepEqual(byName.A, { uses: 2 });
	assert.deepEqual(byName.B, { uses: 3 });
});

test("an ability grant naming an unknown character raises an incident", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	const incidents = createIncidentLog();
	configureUpdates({ incidents });
	const { io, store } = makeAbilityDeps();
	broadcastAbilityUpdates(io, store, "lob1", [{ player: "Ghost", change_type: "add", name: "X" }]);
	assert.equal(incidents.list("lob1")[0].detail.event, "abilities:update");
});

test("malformed ability entries are skipped without stopping the valid ones", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	configureUpdates({ incidents: null });
	const { io, store, lobby } = makeAbilityDeps();
	broadcastAbilityUpdates(io, store, "lob1", [
		null,
		{ player: "Ayla" },
		{ player: "Ayla", change_type: "add", name: "Real" },
	]);
	assert.deepEqual(lobby.players.Ayla.abilities.map((a) => a.name), ["Real"]);
});

test("a non-array abilities field is ignored rather than throwing", async () => {
	const { broadcastAbilityUpdates } = await import("./gameUpdates.js");
	const { io, store } = makeAbilityDeps();
	assert.doesNotThrow(() => broadcastAbilityUpdates(io, store, "lob1", "not a list"));
});

test("a gold change carries the reason the DM gave for it", async () => {
	// Without a reason the admin feed labelled every story-driven gold change
	// "Manual change" — stating the opposite of what happened, since a manual change
	// is exactly what it was not.
	configureUpdates({ incidents: null });
	const { io, store, emitted } = makeDeps();
	broadcastGoldUpdates(io, store, "lob1", [{ player: "Ayla", delta: 5, reason: "found in a buried box" }]);
	const gold = emitted.find((e) => e.event === "gold:update");
	assert.equal(gold.payload.reason, "found in a buried box");
});

test("a gold change with no stated reason sends an empty one, not a misleading default", () => {
	configureUpdates({ incidents: null });
	const { io, store, emitted } = makeDeps();
	broadcastGoldUpdates(io, store, "lob1", [{ player: "Ayla", delta: 5 }]);
	assert.equal(emitted.find((e) => e.event === "gold:update").payload.reason, "");
});
