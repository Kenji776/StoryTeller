import { test } from "node:test";
import assert from "node:assert/strict";

import { createAiSetup } from "./aiSetup.js";
import { createCredentialSystem } from "../services/credentials/index.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const HOST_KEY = "test-token-DO-NOT-USE-host";
const SERVER_KEY = "test-token-DO-NOT-USE-server";
const SECRET = "test-vault-secret-DO-NOT-USE";

const LOBBY = "lobby-1";
const HOST_SID = "socket-host";
const OTHER_SID = "socket-player";

/**
 * @description Builds an in-memory filesystem double.
 * @returns {object} An fs-shaped double.
 */
function makeFs() {
	const files = {};
	return {
		files,
		existsSync: (p) => Object.hasOwn(files, p),
		readFileSync: (p) => { if (!Object.hasOwn(files, p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]; },
		writeFileSync: (p, d) => { files[p] = d; },
		appendFileSync: (p, d) => { files[p] = (files[p] ?? "") + d; },
		mkdirSync: () => {},
	};
}

/**
 * Assembles the AI setup surface over a real credential system.
 *
 * @param {object} [options] - Overrides.
 * @returns {object} The setup handlers and its collaborators.
 */
function makeSetup({ policy, vaultKeys = {}, hosts = { [LOBBY]: HOST_SID }, fetchImpl } = {}) {
	const credentials = createCredentialSystem({
		fsImpl: makeFs(), dataDir: "/data", secret: SECRET, env: {}, log: () => {},
		now: () => new Date("2026-07-28T12:00:00.000Z"),
	});
	for (const [id, key] of Object.entries(vaultKeys)) credentials.vault.set(id, key);
	if (policy) credentials.setPolicy(policy);

	const emitted = [];
	const setup = createAiSetup({
		credentials,
		isHost: (lobbyId, sid) => hosts[lobbyId] === sid,
		emitToLobby: (lobbyId, event, payload) => emitted.push({ lobbyId, event, payload }),
		fetchImpl,
		log: () => {},
	});
	return { setup, credentials, emitted };
}

/** A well-formed credential submission. */
const submission = (overrides = {}) => ({
	lobbyId: LOBBY, capability: "chat", providerId: "anthropic",
	apiKey: HOST_KEY, consent: true, ...overrides,
});

// ── What a player is told about the instance ─────────────────────────────────

test("the capability view is published for the settings window", () => {
	const { setup } = makeSetup({ policy: { chat: { openai: "shared" } }, vaultKeys: { openai: SERVER_KEY } });
	const view = setup.capabilities();

	assert.ok(view.chat.providers.length > 0);
	assert.equal(view.chat.anyUsableWithoutPlayerKey, true);
});

test("the published view carries no vault metadata or key material", () => {
	const { setup } = makeSetup({ policy: { chat: { openai: "shared" } }, vaultKeys: { openai: SERVER_KEY } });
	const serialised = JSON.stringify(setup.capabilities());

	assert.ok(!serialised.includes(SERVER_KEY));
	assert.ok(!serialised.includes("last4"));
});

test("readiness reports a lobby served by the instance as ready to start", () => {
	const { setup } = makeSetup({ policy: { chat: { openai: "shared" } }, vaultKeys: { openai: SERVER_KEY } });
	assert.equal(setup.readiness(LOBBY).ready, true);
});

test("readiness reports a bring-your-own lobby as blocked until a key arrives", () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	assert.equal(setup.readiness(LOBBY).ready, false);

	setup.setCredential(HOST_SID, submission());
	assert.equal(setup.readiness(LOBBY).ready, true);
});

// ── Supplying a credential ───────────────────────────────────────────────────

test("a host's key is accepted and satisfies the service", async () => {
	const { setup, credentials } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const result = await setup.setCredential(HOST_SID, submission());

	assert.equal(result.ok, true);
	assert.equal(credentials.sessionKeys.describe(LOBBY).chat.configured, true);
});

test("only the host may supply a credential for their lobby", async () => {
	const { setup, credentials } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const result = await setup.setCredential(OTHER_SID, submission());

	assert.equal(result.ok, false);
	assert.match(result.error, /host/i);
	assert.equal(credentials.sessionKeys.describe(LOBBY), null);
});

test("a credential without consent is refused, and the message says what is being agreed to", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const result = await setup.setCredential(HOST_SID, submission({ consent: false }));

	assert.equal(result.ok, false);
	assert.match(result.error, /every player|all players/i);
});

test("a blank key is refused with the offending field named", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const result = await setup.setCredential(HOST_SID, submission({ apiKey: "   " }));

	assert.equal(result.ok, false);
	assert.equal(result.field, "apiKey");
});

test("a provider the server does not offer is refused", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "off" } } });

	const result = await setup.setCredential(HOST_SID, submission());

	assert.equal(result.ok, false);
	assert.match(result.error, /not offered|not available/i);
});

test("an unknown provider is refused", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });
	const result = await setup.setCredential(HOST_SID, submission({ providerId: "hal9000" }));

	assert.equal(result.ok, false);
});

test("the host's call limit and expiry are carried through", async () => {
	const { setup, credentials } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	await setup.setCredential(HOST_SID, submission({
		maxCalls: 50,
		expiresAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
	}));

	const held = credentials.sessionKeys.describe(LOBBY).chat;
	assert.equal(held.maxCalls, 50);
	assert.equal(held.expiresAt, "2026-08-01T00:00:00.000Z");
});

test("an expiry already in the past is refused rather than stored", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const result = await setup.setCredential(HOST_SID, submission({ expiresAt: "2020-01-01T00:00:00.000Z" }));
	assert.equal(result.ok, false);
	assert.match(result.error, /future|expir/i);
});

test("no response to a submission echoes the key back", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const ok = await setup.setCredential(HOST_SID, submission());
	const bad = await setup.setCredential(HOST_SID, submission({ consent: false }));

	for (const result of [ok, bad]) {
		assert.ok(!JSON.stringify(result).includes(HOST_KEY), "a response echoed the key back");
	}
});

test("supplying a credential tells the lobby its readiness changed", async () => {
	const { setup, emitted } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	await setup.setCredential(HOST_SID, submission());

	const update = emitted.find((e) => e.event === "ai:state");
	assert.ok(update, "no ai:state was emitted");
	assert.equal(update.payload.ready, true);
});

test("a broadcast state never carries key material", async () => {
	const { setup, emitted } = makeSetup({ policy: { chat: { anthropic: "byok" } } });
	await setup.setCredential(HOST_SID, submission());

	assert.ok(!JSON.stringify(emitted).includes(HOST_KEY));
});

// ── Clearing ─────────────────────────────────────────────────────────────────

test("a host can withdraw a credential they supplied", async () => {
	const { setup, credentials } = makeSetup({ policy: { chat: { anthropic: "byok" } } });
	await setup.setCredential(HOST_SID, submission());

	const result = setup.clearCredential(HOST_SID, { lobbyId: LOBBY, capability: "chat" });

	assert.equal(result.ok, true);
	assert.equal(credentials.sessionKeys.describe(LOBBY).chat.configured, false);
});

test("only the host may withdraw a credential", () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });
	assert.equal(setup.clearCredential(OTHER_SID, { lobbyId: LOBBY, capability: "chat" }).ok, false);
});

// ── Listing models with the supplied credential ──────────────────────────────

test("models are listed using the credential already supplied", async () => {
	const fetchImpl = async () => ({
		ok: true, status: 200,
		text: async () => JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-6" }] }),
	});
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } }, fetchImpl });
	await setup.setCredential(HOST_SID, submission());

	const result = await setup.listModels(HOST_SID, { lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });

	assert.equal(result.ok, true);
	assert.ok(result.models.length >= 1);
});

test("listing models does not spend the host's call budget", async () => {
	const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "m" }] }) });
	const { setup, credentials } = makeSetup({ policy: { chat: { anthropic: "byok" } }, fetchImpl });
	await setup.setCredential(HOST_SID, submission({ maxCalls: 2 }));

	await setup.listModels(HOST_SID, { lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });

	assert.equal(credentials.sessionKeys.describe(LOBBY).chat.used, 0, "browsing models consumed a game turn's budget");
});

test("listing models with no credential available reports why", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });

	const result = await setup.listModels(HOST_SID, { lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });
	assert.equal(result.ok, false);
});

test("only the host may list models, since it uses their credential", async () => {
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } } });
	const result = await setup.listModels(OTHER_SID, { lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });

	assert.equal(result.ok, false);
	assert.match(result.error, /host/i);
});

test("a provider that rejects the key reports the failure without echoing it", async () => {
	const fetchImpl = async () => ({
		ok: false, status: 401,
		text: async () => JSON.stringify({ error: { message: `bad key ${HOST_KEY}` } }),
	});
	const { setup } = makeSetup({ policy: { chat: { anthropic: "byok" } }, fetchImpl });
	await setup.setCredential(HOST_SID, submission());

	const result = await setup.listModels(HOST_SID, { lobbyId: LOBBY, capability: "chat", providerId: "anthropic" });

	assert.equal(result.ok, false);
	assert.ok(!JSON.stringify(result).includes(HOST_KEY));
});

// ── The shared key's model allowlist reaches the player ──────────────────────

test("a shared key restricted to certain models offers only those", async () => {
	const { setup } = makeSetup({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		vaultKeys: { openai: SERVER_KEY },
	});

	const result = await setup.listModels(HOST_SID, { lobbyId: LOBBY, capability: "chat", providerId: "openai" });

	assert.equal(result.ok, true);
	assert.deepEqual(result.models.map((m) => m.id), ["gpt-4o-mini"]);
});

test("the allowlist is applied without any request to the provider", async () => {
	let called = false;
	const fetchImpl = async () => { called = true; return { ok: true, status: 200, text: async () => "{}" }; };
	const { setup } = makeSetup({
		policy: { chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } },
		vaultKeys: { openai: SERVER_KEY },
		fetchImpl,
	});

	await setup.listModels(HOST_SID, { lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	assert.equal(called, false, "the allowlist is already the answer; asking the provider wastes a call");
});
