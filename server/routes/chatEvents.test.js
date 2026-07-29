/**
 * Tests for the chat socket events.
 *
 * @description `chat:join` writes the sender's display name straight into
 *   `sockets[sid].playerName`. That is harmless for someone who is playing — it is their
 *   character's name — but an observer holds no character, and giving them a `playerName`
 *   forges one.
 *
 *   The consequence is not cosmetic. `playerBySid` returns `{name, sheet}` by looking the
 *   name up in `players`, so a forged name yields a **truthy actor with an undefined
 *   sheet** — and `action:submit`'s only guard is `if (!actor) return`. A watcher who
 *   opened the chat window could reach the turn pipeline holding nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerChatEvents } from "./chatEvents.js";
import { LobbyStore } from "../services/lobbyStore.js";

/**
 * @description A socket double that records emissions and lets a test fire a handler.
 * @param {string} id - The socket id.
 * @returns {object} The double, with `fire(event, payload)` and `sent`.
 */
function fakeSocket(id) {
	const handlers = {};
	const sent = [];
	return {
		id,
		sent,
		rooms: [],
		on(event, fn) { handlers[event] = fn; },
		emit(event, payload) { sent.push({ event, payload }); },
		join(name) { this.rooms.push(name); },
		fire(event, payload) { return handlers[event]?.(payload); },
	};
}

/**
 * @description Wires the chat events against a real store and a socket double.
 * @param {object} [opts] - Options.
 * @param {boolean} [opts.observer] - Whether the joining socket is watching.
 * @returns {{socket: object, store: object, lobbyId: string, broadcasts: object[]}} The rig.
 */
function rig({ observer = false } = {}) {
	const store = new LobbyStore();
	const { lobbyId } = store.createLobby("host");
	const socket = fakeSocket("watcher");
	const broadcasts = [];
	const io = { to: () => ({ emit: (event, payload) => broadcasts.push({ event, payload }) }) };

	store.addConnection(lobbyId, "watcher", { observer });
	registerChatEvents(socket, { io, store, room: (id) => id, log: () => {}, sendState: () => {} });
	return { socket, store, lobbyId, broadcasts };
}

test("a player joining chat is identified by the name they send", () => {
	// The existing behaviour, pinned so the fix below does not quietly break it.
	const { socket, store, lobbyId } = rig();
	socket.fire("chat:join", { lobbyId, name: "Ayla" });
	assert.equal(store.index[lobbyId].sockets.watcher.playerName, "Ayla");
});

test("an observer joining chat is not given a character name", () => {
	// The defect: this forged a player identity for someone holding no sheet.
	const { socket, store, lobbyId } = rig({ observer: true });
	socket.fire("chat:join", { lobbyId, name: "Kenji" });
	assert.equal(store.index[lobbyId].sockets.watcher.playerName, null);
});

test("an observer who joined chat still resolves to no actor", () => {
	// The assertion that actually matters. `action:submit` guards on `if (!actor)`, so a
	// truthy actor with an undefined sheet would have reached the turn pipeline.
	const { socket, store, lobbyId } = rig({ observer: true });
	socket.fire("chat:join", { lobbyId, name: "Kenji" });
	assert.equal(store.playerBySid(lobbyId, "watcher"), null);
});

test("an observer still receives the chat history and the user list", () => {
	// Being excluded from playing must not exclude them from watching.
	const { socket, store, lobbyId, broadcasts } = rig({ observer: true });
	socket.fire("chat:join", { lobbyId, name: "Kenji" });
	assert.ok(socket.sent.some((m) => m.event === "chat:history"));
	assert.ok(broadcasts.some((m) => m.event === "chat:users"));
	assert.ok(socket.rooms.includes(lobbyId), "they must be in the room to hear anything");
});

test("an observer can speak, and the room hears it", () => {
	const { socket, store, lobbyId, broadcasts } = rig({ observer: true });
	socket.fire("chat:join", { lobbyId, name: "Kenji" });
	socket.fire("chat:message", { lobbyId, name: "Kenji", text: "try the left door" });

	const said = broadcasts.filter((m) => m.event === "chat:message");
	assert.equal(said.length, 1);
	assert.equal(said[0].payload.text, "try the left door");
	assert.equal(said[0].payload.name, "Kenji");
	assert.ok(store.getChat(lobbyId, 10).some((m) => m.text === "try the left door"),
		"and it is persisted, so a late joiner sees it");
});

test("an observer's rename does not become a character name either", () => {
	const { socket, store, lobbyId } = rig({ observer: true });
	socket.fire("chat:join", { lobbyId, name: "Kenji" });
	socket.fire("chat:updateName", { lobbyId, oldName: "Kenji", newName: "Kenji (watching)", clientId: "c1" });
	assert.equal(store.index[lobbyId].sockets.watcher.playerName, null);
});
