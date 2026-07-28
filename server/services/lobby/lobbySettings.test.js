import { test } from "node:test";
import assert from "node:assert/strict";

import { settingsMethods } from "./lobbySettings.js";

/**
 * Builds a minimal LobbyStore stand-in carrying one lobby.
 *
 * @description `settingsMethods` is a plain object mixed into `LobbyStore.prototype`,
 *   so binding it to a `this` exposing `index` and `persist` exercises the real
 *   methods without a store, a disk, or a socket (`TDD-8`).
 * @param {object} [lobby] - Fields to seed the lobby with.
 * @returns {object} The store double; `persisted` records every persist call.
 */
function makeStore(lobby = {}) {
	const store = Object.create(settingsMethods);
	store.index = { lob1: { lobbyId: "lob1", ...lobby } };
	store.persisted = [];
	store.persist = (id) => store.persisted.push(id);
	return store;
}

const lobbyOf = (store) => store.index.lob1;

// ===== setTTSProvider / getTTSProvider =====

test("setTTSProvider records a provider the registry knows", () => {
	const store = makeStore();
	store.setTTSProvider("lob1", "local");
	assert.equal(store.getTTSProvider("lob1"), "local");
});

test("setTTSProvider accepts either shipped provider", () => {
	const store = makeStore();
	store.setTTSProvider("lob1", "elevenlabs");
	assert.equal(store.getTTSProvider("lob1"), "elevenlabs");
});

test("setTTSProvider persists the change", () => {
	const store = makeStore();
	store.setTTSProvider("lob1", "local");
	assert.deepEqual(store.persisted, ["lob1"]);
});

test("setTTSProvider ignores an unknown provider rather than coercing it", () => {
	// The neighbouring setters coerce junk to a default. Doing that here would let a
	// malformed message silently move a lobby off the engine its host chose, so an
	// unrecognised id leaves the existing selection alone instead.
	const store = makeStore({ ttsProvider: "elevenlabs" });
	store.setTTSProvider("lob1", "festival");
	assert.equal(store.getTTSProvider("lob1"), "elevenlabs");
});

test("setTTSProvider ignores junk types", () => {
	const store = makeStore({ ttsProvider: "local" });
	for (const junk of [42, {}, [], true]) store.setTTSProvider("lob1", junk);
	assert.equal(store.getTTSProvider("lob1"), "local");
});

test("setTTSProvider clears the selection when given null", () => {
	const store = makeStore({ ttsProvider: "local" });
	store.setTTSProvider("lob1", null);
	assert.equal(store.getTTSProvider("lob1"), null);
});

test("setTTSProvider is a no-op for a lobby that does not exist", () => {
	const store = makeStore();
	assert.doesNotThrow(() => store.setTTSProvider("nope", "local"));
	assert.deepEqual(store.persisted, [], "a missing lobby must not trigger a write");
});

test("getTTSProvider returns null when nothing was ever chosen", () => {
	assert.equal(makeStore().getTTSProvider("lob1"), null);
});

test("getTTSProvider returns null for a lobby that does not exist", () => {
	assert.equal(makeStore().getTTSProvider("nope"), null);
});

// ===== per-provider voice memory =====

test("setNarratorVoice sets the active voice as before", () => {
	const store = makeStore({ ttsProvider: "local" });
	store.setNarratorVoice("lob1", "House", "House");
	assert.equal(store.getNarratorVoice("lob1"), "House");
	assert.equal(lobbyOf(store).narratorVoiceName, "House");
});

test("setNarratorVoice files the voice under the active provider", () => {
	const store = makeStore({ ttsProvider: "local" });
	store.setNarratorVoice("lob1", "House", "House");
	assert.deepEqual(lobbyOf(store).narratorVoices.local, { id: "House", name: "House" });
});

test("switching provider restores the voice last used with it", () => {
	// An ElevenLabs voice id means nothing to the local server and vice versa, so a
	// host who switches back must not have to re-pick.
	const store = makeStore({ ttsProvider: "elevenlabs" });
	store.setNarratorVoice("lob1", "eleven-george", "George");
	store.setTTSProvider("lob1", "local");
	store.setNarratorVoice("lob1", "Keiko", "Keiko");

	store.setTTSProvider("lob1", "elevenlabs");
	assert.equal(store.getNarratorVoice("lob1"), "eleven-george");
	assert.equal(lobbyOf(store).narratorVoiceName, "George");

	store.setTTSProvider("lob1", "local");
	assert.equal(store.getNarratorVoice("lob1"), "Keiko");
});

test("switching to a provider never used before leaves no active voice", () => {
	const store = makeStore({ ttsProvider: "elevenlabs" });
	store.setNarratorVoice("lob1", "eleven-george", "George");
	store.setTTSProvider("lob1", "local");
	assert.equal(store.getNarratorVoice("lob1"), null, "an ElevenLabs id would be rejected by the local server");
	assert.equal(lobbyOf(store).narratorVoiceName, null);
});

test("a legacy lobby's stored voice is attributed to ElevenLabs", () => {
	// Lobbies persisted before this change have an ElevenLabs id in narratorVoiceId
	// and no ttsProvider at all.
	const store = makeStore({ narratorVoiceId: "dAcds2QMcvmv86jQMC3Y", narratorVoiceName: "Legacy" });
	store.setTTSProvider("lob1", "local");
	assert.equal(store.getNarratorVoice("lob1"), null);
	store.setTTSProvider("lob1", "elevenlabs");
	assert.equal(store.getNarratorVoice("lob1"), "dAcds2QMcvmv86jQMC3Y", "the legacy voice must survive a round trip");
	assert.equal(lobbyOf(store).narratorVoiceName, "Legacy");
});

test("re-selecting the current provider does not disturb the active voice", () => {
	const store = makeStore({ ttsProvider: "local" });
	store.setNarratorVoice("lob1", "Keiko", "Keiko");
	store.setTTSProvider("lob1", "local");
	assert.equal(store.getNarratorVoice("lob1"), "Keiko");
});

test("clearing the narrator voice clears it for that provider only", () => {
	const store = makeStore({ ttsProvider: "elevenlabs" });
	store.setNarratorVoice("lob1", "eleven-george", "George");
	store.setTTSProvider("lob1", "local");
	store.setNarratorVoice("lob1", "Keiko", "Keiko");
	store.setNarratorVoice("lob1", null, null);

	assert.equal(store.getNarratorVoice("lob1"), null);
	store.setTTSProvider("lob1", "elevenlabs");
	assert.equal(store.getNarratorVoice("lob1"), "eleven-george", "clearing the local voice must not clear the other one");
});

test("setNarratorVoice is a no-op for a lobby that does not exist", () => {
	const store = makeStore();
	assert.doesNotThrow(() => store.setNarratorVoice("nope", "House", "House"));
	assert.deepEqual(store.persisted, []);
});

