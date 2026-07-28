import { test } from "node:test";
import assert from "node:assert/strict";

import { createResolver, CredentialRequiredError } from "./resolve.js";
import { createSessionKeys } from "./sessionKeys.js";
import { normalizePolicyDocument } from "./policy.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const HOST_KEY = "test-token-DO-NOT-USE-host";
const SERVER_KEY = "test-token-DO-NOT-USE-server";

const LOBBY = "lobby-1";
const HOST_SID = "socket-host";
const T0 = Date.UTC(2026, 6, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** The provider descriptors the resolver is handed, standing in for the registries. */
const PROVIDERS = {
	chat: {
		openai: { id: "openai", label: "OpenAI", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: "https://api.openai.com/v1" },
		anthropic: { id: "anthropic", label: "Anthropic", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: "https://api.anthropic.com" },
		ollama: { id: "ollama", label: "Ollama", requiresApiKey: false, requiresBaseUrl: true, defaultBaseUrl: "http://127.0.0.1:11434" },
		gateway: { id: "gateway", label: "Custom gateway", requiresApiKey: false, requiresBaseUrl: true, defaultBaseUrl: null },
	},
	speech: {
		elevenlabs: { id: "elevenlabs", label: "ElevenLabs", requiresApiKey: true, requiresBaseUrl: false, defaultBaseUrl: null },
	},
};

/**
 * Runs a function that must throw, and hands back what it threw.
 *
 * @param {Function} fn - The function expected to throw.
 * @returns {Error} Whatever it threw.
 * @throws {assert.AssertionError} When the function returned without throwing.
 */
function captureThrow(fn) {
	try {
		fn();
	} catch (err) {
		return err;
	}
	assert.fail("expected the call to throw, but it returned normally");
}

/**
 * Builds a resolver over fake stores.
 *
 * @param {object} [options] - What the instance holds and offers.
 * @param {object} [options.policy] - A raw policy document.
 * @param {object} [options.vaultKeys] - Provider id → key the vault holds.
 * @param {Function} [options.now] - Clock returning epoch milliseconds.
 * @returns {object} The resolver, the session store, and the clock control.
 */
function makeResolver({ policy = {}, vaultKeys = {}, now = () => T0 } = {}) {
	const sessionKeys = createSessionKeys({ now, log: () => {}, onPurge: () => {} });
	const doc = normalizePolicyDocument(policy);
	const resolver = createResolver({
		vault: { read: (id) => vaultKeys[id] ?? null },
		getPolicy: () => doc,
		sessionKeys,
		providerFor: (capability, id) => PROVIDERS[capability]?.[id] ?? null,
	});
	return { resolver, sessionKeys };
}

/**
 * Supplies a host credential for the chat capability.
 *
 * @param {object} sessionKeys - The session store.
 * @param {object} [overrides] - Fields to replace on the put payload.
 * @returns {void}
 */
function supplyHost(sessionKeys, overrides = {}) {
	sessionKeys.put(LOBBY, {
		capability: "chat",
		config: { providerId: "anthropic", apiKey: HOST_KEY, model: "claude-sonnet-4-6", baseUrl: null },
		ownerSid: HOST_SID,
		consent: true,
		maxCalls: null,
		expiresAt: null,
		...overrides,
	});
}

// ── The host's key ───────────────────────────────────────────────────────────

test("a host credential is used in preference to the instance's own", () => {
	const { resolver, sessionKeys } = makeResolver({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});
	supplyHost(sessionKeys);

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });
	assert.equal(resolved.source, "host");
	assert.equal(resolved.config.apiKey, HOST_KEY);
});

test("resolving through the host's key spends one of their calls", () => {
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { anthropic: "byok" } } });
	supplyHost(sessionKeys, { maxCalls: 5 });

	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });
	assert.equal(sessionKeys.describe(LOBBY).chat.used, 1);
});

test("a host key for one provider is never sent to another", () => {
	const { resolver, sessionKeys } = makeResolver({
		policy: { chat: { openai: "shared" } },
		vaultKeys: { openai: SERVER_KEY },
	});
	supplyHost(sessionKeys); // an Anthropic key

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	assert.equal(resolved.source, "server");
	assert.equal(resolved.config.apiKey, SERVER_KEY);
});

test("the lobby's chosen model overrides the one stored with the host's key", () => {
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { anthropic: "byok" } } });
	supplyHost(sessionKeys);

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic", model: "claude-opus-4-6" });
	assert.equal(resolved.config.model, "claude-opus-4-6");
});

test("the model stored with the host's key is used when the lobby names none", () => {
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { anthropic: "byok" } } });
	supplyHost(sessionKeys);

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });
	assert.equal(resolved.config.model, "claude-sonnet-4-6");
});

test("an expired host key is reported as expired rather than falling back to the server's", () => {
	let clock = T0;
	const { resolver, sessionKeys } = makeResolver({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
		now: () => clock,
	});
	supplyHost(sessionKeys, { expiresAt: T0 + HOUR });
	clock = T0 + HOUR + 1;

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" }));
	assert.ok(err instanceof CredentialRequiredError);
	assert.equal(err.reason, "expired");
});

test("a host key past its call limit is reported as exhausted", () => {
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { anthropic: "byok" } } });
	supplyHost(sessionKeys, { maxCalls: 1 });
	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" }));
	assert.equal(err.reason, "exhausted");
});

test("a host key dropped when its owner left falls back to the policy", () => {
	const { resolver, sessionKeys } = makeResolver({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});
	supplyHost(sessionKeys);
	sessionKeys.dropSecretsBySocket(HOST_SID, "host-disconnected");

	assert.equal(resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" }).source, "server");
});

// ── The instance's own key ───────────────────────────────────────────────────

test("a shared provider resolves to the vault's key", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: "shared" } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	assert.equal(resolved.source, "server");
	assert.equal(resolved.config.apiKey, SERVER_KEY);
	assert.equal(resolved.config.baseUrl, "https://api.openai.com/v1");
});

test("a shared provider with no key in the vault is a misconfiguration, not a fallback", () => {
	const { resolver } = makeResolver({ policy: { chat: { openai: "shared" } } });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));
	assert.equal(err.reason, "no_server_key");
});

test("a model on the shared allowlist is served", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai", model: "gpt-4o-mini" });
	assert.equal(resolved.source, "server");
});

test("a model off the shared allowlist is refused", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const err = captureThrow(() =>
		resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai", model: "gpt-4o" }));
	assert.equal(err.reason, "model_not_shared");
});

test("an unnamed model is refused when the shared key is restricted to an allowlist", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));
	assert.equal(err.reason, "model_not_shared");
});

test("a lobby may spend the shared key up to the operator's cap", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: { policy: "shared", maxCallsPerLobby: 2 } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));
	assert.equal(err.reason, "shared_cap_reached");
});

test("the operator's cap is counted per lobby, not across the instance", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: { policy: "shared", maxCallsPerLobby: 1 } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	assert.equal(resolver.resolve({ lobbyId: "lobby-2", capability: "chat", providerId: "openai" }).source, "server");
});

test("a refused shared call does not count against the cap", () => {
	const { resolver, sessionKeys } = makeResolver({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai", model: "gpt-4o" }));
	assert.equal(sessionKeys.sharedUse(LOBBY, "chat", "openai"), 0);
});

// ── Local services ───────────────────────────────────────────────────────────

test("a local provider resolves with no credential at all", () => {
	const { resolver } = makeResolver({ policy: { chat: { ollama: "local" } } });

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "ollama", model: "llama3" });
	assert.equal(resolved.source, "local");
	assert.equal(resolved.config.apiKey, null);
	assert.equal(resolved.config.baseUrl, "http://127.0.0.1:11434");
});

test("an operator-set address beats the provider's default", () => {
	const { resolver } = makeResolver({
		policy: { chat: { ollama: { policy: "local", baseUrl: "http://192.168.1.20:11434" } } },
	});

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "ollama" });
	assert.equal(resolved.config.baseUrl, "http://192.168.1.20:11434");
});

test("a local provider with no address anywhere is refused rather than dialled blindly", () => {
	const { resolver } = makeResolver({ policy: { chat: { gateway: "local" } } });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "gateway" }));
	assert.equal(err.reason, "no_base_url");
});

test("a local provider costs nothing against any ledger", () => {
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { ollama: "local" } } });

	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "ollama" });
	assert.equal(sessionKeys.sharedUse(LOBBY, "chat", "ollama"), 0);
});

// ── Bring your own, and not offered ──────────────────────────────────────────

test("a bring-your-own provider with no host key asks for one", () => {
	const { resolver } = makeResolver({ policy: { chat: { openai: "byok" } } });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));
	assert.equal(err.reason, "byok");
	assert.equal(err.capability, "chat");
	assert.equal(err.providerId, "openai");
});

test("a provider switched off is refused even when the vault holds a key for it", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: "off" } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));
	assert.equal(err.reason, "off");
});

test("a provider with no policy at all is refused, because lookups fail closed", () => {
	const { resolver } = makeResolver({ vaultKeys: { openai: SERVER_KEY } });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));
	assert.equal(err.reason, "off");
});

test("an unknown provider is refused", () => {
	const { resolver } = makeResolver({ policy: { chat: { openai: "shared" } } });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "hal9000" }));
	assert.equal(err.reason, "unknown_provider");
});

test("capabilities are resolved independently of one another", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: "shared" }, speech: { elevenlabs: "byok" } },
		vaultKeys: { openai: SERVER_KEY, elevenlabs: SERVER_KEY },
	});

	assert.equal(resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }).source, "server");
	assert.equal(
		captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "speech", providerId: "elevenlabs" })).reason,
		"byok",
	);
});

// ── What the player is told ──────────────────────────────────────────────────

test("the bring-your-own message names the provider and what to do", () => {
	const { resolver } = makeResolver({ policy: { chat: { openai: "byok" } } });
	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }));

	assert.match(err.userMessage(), /OpenAI/);
	assert.match(err.userMessage(), /your own|Settings/i);
});

test("the expiry message tells the host their key has to be replaced", () => {
	let clock = T0;
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { anthropic: "byok" } }, now: () => clock });
	supplyHost(sessionKeys, { expiresAt: T0 + HOUR });
	clock = T0 + HOUR + 1;

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" }));
	assert.match(err.userMessage(), /expired/i);
	assert.match(err.userMessage(), /Anthropic/);
});

test("the exhausted message points at the limit the host themselves set", () => {
	const { resolver, sessionKeys } = makeResolver({ policy: { chat: { anthropic: "byok" } } });
	supplyHost(sessionKeys, { maxCalls: 1 });
	resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });

	const err = captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" }));
	assert.match(err.userMessage(), /limit/i);
});

test("no failure message ever carries key material", () => {
	let clock = T0;
	const { resolver, sessionKeys } = makeResolver({
		policy: { chat: { anthropic: "byok" }, speech: { elevenlabs: "off" } },
		vaultKeys: { anthropic: SERVER_KEY },
		now: () => clock,
	});
	supplyHost(sessionKeys, { expiresAt: T0 + HOUR });
	clock = T0 + HOUR + 1;

	const failures = [
		captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "anthropic" })),
		captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "speech", providerId: "elevenlabs" })),
		captureThrow(() => resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "hal9000" })),
	];

	for (const err of failures) {
		const text = `${err.message} ${err.userMessage()} ${JSON.stringify(err)}`;
		assert.ok(!text.includes(HOST_KEY), "a failure message carried the host's key");
		assert.ok(!text.includes(SERVER_KEY), "a failure message carried the instance's key");
	}
});

// ── Shape of what comes back ─────────────────────────────────────────────────

test("a resolved configuration carries exactly the four fields an adapter needs", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: "shared" } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const resolved = resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai", model: "gpt-4o" });
	assert.deepEqual(Object.keys(resolved.config).sort(), ["apiKey", "baseUrl", "model", "providerId"]);
});

test("the resolved provider label travels with the result for the UI", () => {
	const { resolver } = makeResolver({
		policy: { chat: { openai: "shared" } },
		vaultKeys: { openai: SERVER_KEY },
	});

	assert.equal(resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }).providerLabel, "OpenAI");
});
