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


// ===== setLLMSettings: the pair has to be one the server can honour =====

test("a provider alias is normalised to the id the registry knows", () => {
	// The model catalogue offers a provider called "claude"; the registry only knows "anthropic".
	// Stored verbatim, that pair cannot be resolved and the narrator fails mid-game with a message
	// about a model nobody chose. The alias existed in `llm/defaults.js` for environment variables
	// and had never been applied on the path an operator actually uses.
	const store = makeStore({ llmProvider: "openai", llmModel: "gpt-4o" });
	const result = store.setLLMSettings("lob1", "claude", "claude-sonnet-5");
	assert.equal(result.ok, true);
	assert.equal(lobbyOf(store).llmProvider, "anthropic");
	assert.equal(lobbyOf(store).llmModel, "claude-sonnet-5");
});

test("an unknown provider is refused and the lobby keeps working", () => {
	// Refused rather than stored. A provider nobody can resolve breaks every turn from then on, and
	// the failure surfaces as a confusing model error rather than as the bad selection it was.
	const store = makeStore({ llmProvider: "anthropic", llmModel: "claude-sonnet-5" });
	const result = store.setLLMSettings("lob1", "definitely-not-a-provider", "some-model");
	assert.equal(result.ok, false);
	assert.match(result.reason, /provider/i);
	assert.equal(lobbyOf(store).llmProvider, "anthropic", "the working setting stands");
	assert.equal(lobbyOf(store).llmModel, "claude-sonnet-5");
});

test("a model belonging to another provider is refused", () => {
	// The exact failure that started this: a lobby left holding provider "openai" and model
	// "claude-sonnet-4-6", so OpenAI was asked for a Claude model and said it had never heard of it.
	const store = makeStore({ llmProvider: "openai", llmModel: "gpt-4o" });
	const result = store.setLLMSettings("lob1", "openai", "claude-sonnet-4-6");
	assert.equal(result.ok, false);
	assert.match(result.reason, /claude-sonnet-4-6/);
	assert.equal(lobbyOf(store).llmModel, "gpt-4o", "unchanged");
});

test("a gpt model under anthropic is refused too, not just the reverse", () => {
	const store = makeStore({ llmProvider: "anthropic", llmModel: "claude-sonnet-5" });
	assert.equal(store.setLLMSettings("lob1", "anthropic", "gpt-4o").ok, false);
});

test("a coherent pair is accepted", () => {
	const store = makeStore({ llmProvider: "openai", llmModel: "gpt-4o" });
	assert.equal(store.setLLMSettings("lob1", "anthropic", "claude-opus-5").ok, true);
	assert.equal(store.setLLMSettings("lob1", "openai", "gpt-5-chat-latest").ok, true);
});

test("a model whose provider cannot be guessed is accepted, because guessing wrong is worse", () => {
	// Local and self-hosted models are named anything at all — `llama3`, `mixtral`, a path. Refusing
	// what is merely unfamiliar would lock an operator out of every provider except the two whose
	// naming this code happens to recognise.
	const store = makeStore({ llmProvider: "ollama", llmModel: "llama3" });
	assert.equal(store.setLLMSettings("lob1", "ollama", "some-local-build:latest").ok, true);
	assert.equal(lobbyOf(store).llmModel, "some-local-build:latest");
});

test("changing only the model leaves the provider alone", () => {
	const store = makeStore({ llmProvider: "anthropic", llmModel: "claude-sonnet-5" });
	assert.equal(store.setLLMSettings("lob1", null, "claude-opus-5").ok, true);
	assert.equal(lobbyOf(store).llmProvider, "anthropic");
	assert.equal(lobbyOf(store).llmModel, "claude-opus-5");
});

test("changing only the model still checks it against the provider in force", () => {
	// The commonest way to arrive at a broken pair: pick a model, never touch the provider.
	const store = makeStore({ llmProvider: "openai", llmModel: "gpt-4o" });
	const result = store.setLLMSettings("lob1", null, "claude-sonnet-5");
	assert.equal(result.ok, false);
	assert.equal(lobbyOf(store).llmModel, "gpt-4o");
});

test("an unknown lobby is refused rather than throwing", () => {
	assert.equal(makeStore().setLLMSettings("nope", "openai", "gpt-4o").ok, false);
});

test("a model id carrying markup is refused rather than stored", () => {
	// Regression. The lobby options panel renders the model in force into every player's screen
	// through `innerHTML`, and the picker offers a free-text field for local models whose names
	// cannot be enumerated. A host could therefore store markup here and have it run in the browser
	// of everyone who joins. A model id has a shape, and `<` is not in it.
	const store = makeStore({ llmProvider: "ollama", llmModel: "llama3" });
	const result = store.setLLMSettings("lob1", "ollama", `<img src=x onerror="alert(1)">`);

	assert.equal(result.ok, false);
	assert.match(result.reason, /model/i);
	assert.equal(lobbyOf(store).llmModel, "llama3", "the working setting stands");
});

test("a model id with a space is refused, because no provider names one that way", () => {
	const store = makeStore({ llmProvider: "ollama", llmModel: "llama3" });
	assert.equal(store.setLLMSettings("lob1", "ollama", "llama3 and then some").ok, false);
});

test("an absurdly long model id is refused", () => {
	const store = makeStore({ llmProvider: "ollama", llmModel: "llama3" });
	assert.equal(store.setLLMSettings("lob1", "ollama", "a".repeat(500)).ok, false);
});

test("the shapes real providers actually use are all accepted", () => {
	// The guard above must not become a second way to lock an operator out of their own models.
	// Every one of these names a real model on some provider.
	// Paired with their own provider, so this measures the shape rule and not the coherence rule
	// two tests above — which correctly refuses gpt-4o on Ollama and would mask what this checks.
	const store = makeStore({ llmProvider: "ollama", llmModel: "llama3" });
	for (const [provider, model] of [
		["openai", "gpt-4o"],
		["anthropic", "claude-opus-5"],
		["google", "gemini-2.0-flash-thinking-exp-01-21"],
		["ollama", "llama3:8b"],
		["ollama", "qwen2.5-coder:32b"],
		["ollama", "my_local_build.v2"],
		["openai-compatible", "meta-llama/Llama-3-70b-instruct"],
		["openai-compatible", "accounts/fireworks/models/mixtral"],
	]) {
		const result = store.setLLMSettings("lob1", provider, model);
		assert.equal(result.ok, true, `${provider}/${model} should be accepted: ${result.reason ?? ""}`);
	}
});
