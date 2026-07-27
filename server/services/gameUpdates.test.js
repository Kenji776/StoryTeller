import { test } from "node:test";
import assert from "node:assert/strict";

import { broadcastHPUpdates, broadcastGoldUpdates, configureUpdates } from "./gameUpdates.js";
import { createIncidentLog } from "./incidents.js";

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
		applyHPChange: (id, key, delta) => { lobby.players[key].stats.hp += delta; return lobby.players[key].stats.hp; },
		applyGoldChange: (id, key, delta) => { lobby.players[key].gold += delta; return lobby.players[key].gold; },
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
