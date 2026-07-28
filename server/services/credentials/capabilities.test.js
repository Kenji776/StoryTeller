import { test } from "node:test";
import assert from "node:assert/strict";

import { publicCapabilities, adminCapabilities } from "./capabilities.js";
import { normalizePolicyDocument, CAPABILITIES } from "./policy.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const SERVER_KEY = "test-token-DO-NOT-USE-server";

/** Descriptors as the registries expose them. */
const REGISTRY = {
	chat: [
		{ id: "openai", label: "OpenAI", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
		{ id: "anthropic", label: "Anthropic", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: "https://api.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys" },
		{ id: "ollama", label: "Ollama", requiresApiKey: false, requiresBaseUrl: true, defaultBaseUrl: "http://127.0.0.1:11434", keyUrl: null },
	],
	speech: [
		{ id: "elevenlabs", label: "ElevenLabs", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: null, keyUrl: "https://elevenlabs.io/app/settings/api-keys" },
		{ id: "local", label: "Local speech server", requiresApiKey: false, requiresBaseUrl: true, defaultBaseUrl: null, keyUrl: null },
	],
	image: [
		{ id: "openai", label: "OpenAI", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys" },
	],
};

/**
 * Builds a vault double holding the given providers' keys.
 *
 * @param {string[]} [configured] - Provider ids the vault has keys for.
 * @returns {object} A vault-shaped double.
 */
function makeVault(configured = []) {
	const held = new Set(configured);
	return {
		has: (id) => held.has(id),
		read: (id) => (held.has(id) ? SERVER_KEY : null),
		describe: () => Object.fromEntries([...held].map((id) => [
			id,
			{ configured: true, last4: SERVER_KEY.slice(-4), addedAt: "2026-07-27T12:00:00.000Z", status: "ok", lastValidated: "2026-07-27T12:00:00.000Z" },
		])),
	};
}

/**
 * Assembles the arguments both view builders take.
 *
 * @param {object} [options] - What the instance offers and holds.
 * @returns {object} The argument bundle.
 */
function view({ policy = {}, configured = [], availability = {}, providers = REGISTRY } = {}) {
	return { providers, policy: normalizePolicyDocument(policy), vault: makeVault(configured), availability };
}

/**
 * @description Finds one provider in a built capability view.
 * @param {object} built - The view.
 * @param {string} capability - The capability to look in.
 * @param {string} id - The provider id.
 * @returns {object|undefined} The entry.
 */
function find(built, capability, id) {
	return built[capability].providers.find((p) => p.id === id);
}

// ── What a player is shown ───────────────────────────────────────────────────

test("a shared provider with a key in the vault is ready and needs nothing from the player", () => {
	const built = publicCapabilities(view({ policy: { chat: { openai: "shared" } }, configured: ["openai"] }));
	const openai = find(built, "chat", "openai");

	assert.equal(openai.ready, true);
	assert.equal(openai.needsPlayerKey, false);
});

test("a shared provider whose key is missing is listed but not ready", () => {
	const built = publicCapabilities(view({ policy: { chat: { openai: "shared" } } }));

	assert.equal(find(built, "chat", "openai").ready, false);
});

test("a bring-your-own provider asks for the player's key and is not ready by itself", () => {
	const built = publicCapabilities(view({ policy: { chat: { anthropic: "byok" } } }));
	const anthropic = find(built, "chat", "anthropic");

	assert.equal(anthropic.needsPlayerKey, true);
	assert.equal(anthropic.ready, false);
});

test("a reachable local provider is ready and needs no key", () => {
	const built = publicCapabilities(view({
		policy: { chat: { ollama: "local" } },
		availability: { chat: { ollama: true } },
	}));
	const ollama = find(built, "chat", "ollama");

	assert.equal(ollama.ready, true);
	assert.equal(ollama.needsPlayerKey, false);
	assert.equal(ollama.reachable, true);
});

test("a local provider known to be unreachable is offered but not ready", () => {
	const built = publicCapabilities(view({
		policy: { chat: { ollama: "local" } },
		availability: { chat: { ollama: false } },
	}));
	const ollama = find(built, "chat", "ollama");

	assert.equal(ollama.reachable, false);
	assert.equal(ollama.ready, false);
});

test("a local provider not yet probed is treated as ready rather than written off", () => {
	const built = publicCapabilities(view({ policy: { chat: { ollama: "local" } } }));
	const ollama = find(built, "chat", "ollama");

	assert.equal(ollama.reachable, null);
	assert.equal(ollama.ready, true, "an unprobed provider must not be reported as broken");
});

test("a provider switched off is not shown to players at all", () => {
	const built = publicCapabilities(view({
		policy: { chat: { openai: "off", anthropic: "byok" } },
		configured: ["openai"],
	}));

	assert.equal(find(built, "chat", "openai"), undefined);
	assert.ok(find(built, "chat", "anthropic"));
});

test("a provider with no policy at all is not shown, because lookups fail closed", () => {
	const built = publicCapabilities(view({ configured: ["openai"] }));
	assert.deepEqual(built.chat.providers, []);
});

// ── The flag that drives the bring-your-own warning ──────────────────────────

test("a capability is usable without a player key when the server shares a working one", () => {
	const built = publicCapabilities(view({ policy: { chat: { openai: "shared" } }, configured: ["openai"] }));
	assert.equal(built.chat.anyUsableWithoutPlayerKey, true);
});

test("a capability offering only bring-your-own is not usable without a player key", () => {
	const built = publicCapabilities(view({ policy: { chat: { openai: "byok", anthropic: "byok" } } }));
	assert.equal(built.chat.anyUsableWithoutPlayerKey, false);
});

test("a shared provider with no key does not count as usable", () => {
	const built = publicCapabilities(view({ policy: { chat: { openai: "shared" } } }));
	assert.equal(built.chat.anyUsableWithoutPlayerKey, false);
});

test("an unreachable local provider does not count as usable", () => {
	const built = publicCapabilities(view({
		policy: { chat: { ollama: "local" } },
		availability: { chat: { ollama: false } },
	}));
	assert.equal(built.chat.anyUsableWithoutPlayerKey, false);
});

test("capabilities report usability independently of one another", () => {
	const built = publicCapabilities(view({
		policy: { chat: { openai: "shared" }, speech: { elevenlabs: "byok" } },
		configured: ["openai"],
	}));

	assert.equal(built.chat.anyUsableWithoutPlayerKey, true);
	assert.equal(built.speech.anyUsableWithoutPlayerKey, false);
});

// ── What a player needs in order to act ──────────────────────────────────────

test("the shared-model restriction is surfaced so a player knows what they may pick", () => {
	const built = publicCapabilities(view({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		configured: ["openai"],
	}));

	assert.deepEqual(find(built, "chat", "openai").sharedModels, ["gpt-4o-mini"]);
});

test("where to obtain a key travels with a bring-your-own provider", () => {
	const built = publicCapabilities(view({ policy: { chat: { anthropic: "byok" } } }));
	assert.match(find(built, "chat", "anthropic").keyUrl, /anthropic\.com/);
});

test("whether a provider needs an address of its own is surfaced", () => {
	const built = publicCapabilities(view({ policy: { chat: { ollama: "local" } } }));
	assert.equal(find(built, "chat", "ollama").requiresBaseUrl, true);
});

// ── Shape ────────────────────────────────────────────────────────────────────

test("providers are listed in the order the registry gives them", () => {
	const built = publicCapabilities(view({ policy: { chat: { ollama: "byok", openai: "byok", anthropic: "byok" } } }));
	assert.deepEqual(built.chat.providers.map((p) => p.id), ["openai", "anthropic", "ollama"]);
});

test("every capability is present even when the registry offers none", () => {
	const built = publicCapabilities(view({ providers: {} }));
	assert.deepEqual(Object.keys(built).sort(), [...CAPABILITIES].sort());
	assert.deepEqual(built.chat.providers, []);
	assert.equal(built.chat.anyUsableWithoutPlayerKey, false);
});

test("a policy naming a provider the registry does not have is ignored", () => {
	const built = publicCapabilities(view({ policy: { chat: { hal9000: "shared" } } }));
	assert.deepEqual(built.chat.providers.map((p) => p.id), []);
});

// ── What an operator is shown ────────────────────────────────────────────────

test("the admin view lists providers that are switched off, because that is the control", () => {
	const built = adminCapabilities(view({ policy: { chat: { openai: "off" } } }));
	assert.equal(find(built, "chat", "openai").policy, "off");
});

test("the admin view lists a provider with no policy yet, so one can be given", () => {
	const built = adminCapabilities(view({}));
	assert.deepEqual(built.chat.providers.map((p) => p.id), ["openai", "anthropic", "ollama"]);
	assert.equal(find(built, "chat", "openai").policy, "off");
});

test("the admin view reports which keys the vault holds, and how they last tested", () => {
	const built = adminCapabilities(view({ policy: { chat: { openai: "shared" } }, configured: ["openai"] }));
	const key = find(built, "chat", "openai").key;

	assert.equal(key.configured, true);
	assert.equal(key.last4, SERVER_KEY.slice(-4));
	assert.equal(key.status, "ok");
});

test("the admin view reports an absent key without inventing metadata", () => {
	const built = adminCapabilities(view({ policy: { chat: { openai: "shared" } } }));
	assert.deepEqual(find(built, "chat", "openai").key, { configured: false, last4: null, status: null, lastValidated: null });
});

test("the admin view carries the knobs an operator sets", () => {
	const built = adminCapabilities(view({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"], maxCallsPerLobby: 40 } } },
		configured: ["openai"],
	}));
	const openai = find(built, "chat", "openai");

	assert.deepEqual(openai.sharedModels, ["gpt-4o-mini"]);
	assert.equal(openai.maxCallsPerLobby, 40);
});

test("the admin view shows both the operator's address and the provider's default", () => {
	const built = adminCapabilities(view({
		policy: { chat: { ollama: { policy: "local", baseUrl: "http://192.168.1.20:11434" } } },
	}));
	const ollama = find(built, "chat", "ollama");

	assert.equal(ollama.baseUrl, "http://192.168.1.20:11434");
	assert.equal(ollama.defaultBaseUrl, "http://127.0.0.1:11434");
});

// ── Security properties ──────────────────────────────────────────────────────

test("the player-facing view carries no vault metadata whatsoever", () => {
	const built = publicCapabilities(view({ policy: { chat: { openai: "shared" } }, configured: ["openai"] }));
	const openai = find(built, "chat", "openai");

	assert.equal(openai.key, undefined);
	assert.equal(openai.last4, undefined);
	assert.equal(openai.status, undefined);
});

test("neither view carries key material anywhere in its output", () => {
	const args = view({
		policy: { chat: { openai: "shared", ollama: "local" }, speech: { elevenlabs: "shared" } },
		configured: ["openai", "elevenlabs"],
	});

	for (const built of [publicCapabilities(args), adminCapabilities(args)]) {
		assert.ok(!JSON.stringify(built).includes(SERVER_KEY), "a capability view carried the server's key");
	}
});
