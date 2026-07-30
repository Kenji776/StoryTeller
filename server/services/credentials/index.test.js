import { test } from "node:test";
import assert from "node:assert/strict";

import path from "path";

import { createCredentialSystem } from "./index.js";
import { CredentialRequiredError } from "./resolve.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const OPENAI_KEY = "test-token-DO-NOT-USE-openai";
const ELEVEN_KEY = "test-token-DO-NOT-USE-eleven";
const SECRET = "test-vault-secret-DO-NOT-USE";

const DATA_DIR = "/data";
// Built the way the system builds them: `path.join` uses the platform separator,
// and hardcoding "/" here would pass on Linux and fail on Windows for no real reason.
const VAULT_PATH = path.join(DATA_DIR, "credentials.enc");
const POLICY_PATH = path.join(DATA_DIR, "provider-policy.json");
const LOBBY = "lobby-1";

/**
 * Builds an in-memory stand-in for the filesystem the system persists through.
 *
 * @param {object} [seed] - Initial path→contents map.
 * @returns {object} An fs-shaped double exposing the seeded `files` map.
 */
function makeFs(seed = {}) {
	const files = { ...seed };
	return {
		files,
		existsSync: (p) => Object.hasOwn(files, p),
		readFileSync: (p) => {
			if (!Object.hasOwn(files, p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			return files[p];
		},
		writeFileSync: (p, data) => { files[p] = data; },
		mkdirSync: () => {},
	};
}

/**
 * Assembles a credential system over a fake filesystem.
 *
 * @param {object} [options] - Overrides.
 * @returns {object} The system and the filesystem behind it.
 */
function makeSystem({ fsImpl = makeFs(), secret = SECRET, env = {} } = {}) {
	const system = createCredentialSystem({
		fsImpl,
		dataDir: DATA_DIR,
		secret,
		env,
		log: () => {},
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});
	return { system, fsImpl };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

test("the system exposes the pieces the server needs to wire", () => {
	const { system } = makeSystem();

	for (const part of ["vault", "sessionKeys", "resolver"]) {
		assert.ok(system[part], `expected the system to expose ${part}`);
	}
	for (const fn of ["providersFor", "providerFor", "getPolicy", "setPolicy", "describe", "describeForPlayers"]) {
		assert.equal(typeof system[fn], "function", `expected ${fn} to be a function`);
	}
});

test("the vault and the policy document are written under the data directory", () => {
	const { system, fsImpl } = makeSystem();

	system.vault.set("openai", OPENAI_KEY);
	system.setPolicy({ chat: { openai: "shared" } });

	assert.ok(Object.hasOwn(fsImpl.files, VAULT_PATH), "the vault was not written where the server expects it");
	assert.ok(Object.hasOwn(fsImpl.files, POLICY_PATH), "the policy document was not written where the server expects it");
});

// ── Providers across the three registries ────────────────────────────────────

test("every capability reports the providers its own registry holds", () => {
	const { system } = makeSystem();

	assert.ok(system.providersFor("chat").some((p) => p.id === "openai"));
	assert.ok(system.providersFor("speech").some((p) => p.id === "elevenlabs"));
	assert.ok(system.providersFor("image").some((p) => p.id === "local-image"));
});

test("a provider resolves through the registry its capability belongs to", () => {
	const { system } = makeSystem();

	assert.equal(system.providerFor("chat", "anthropic").id, "anthropic");
	assert.equal(system.providerFor("speech", "local").id, "local");
	assert.equal(system.providerFor("image", "openai").id, "openai");
});

test("an unknown provider resolves to null rather than throwing", () => {
	const { system } = makeSystem();

	assert.equal(system.providerFor("chat", "hal9000"), null);
	assert.equal(system.providerFor("speech", "hal9000"), null);
	assert.equal(system.providerFor("image", "hal9000"), null);
});

test("an unknown capability resolves to null and lists nothing", () => {
	const { system } = makeSystem();

	assert.equal(system.providerFor("telepathy", "openai"), null);
	assert.deepEqual(system.providersFor("telepathy"), []);
});

test("providers carry the credential metadata the policy layer needs", () => {
	const { system } = makeSystem();

	const eleven = system.providersFor("speech").find((p) => p.id === "elevenlabs");
	assert.equal(eleven.requiresApiKey, true);
	assert.match(eleven.keyUrl, /elevenlabs\.io/);

	const localTts = system.providersFor("speech").find((p) => p.id === "local");
	assert.equal(localTts.isLocal, true);
	assert.equal(localTts.requiresApiKey, false);
});

test("Ollama is the chat provider marked local, and the hosted ones are not", () => {
	const { system } = makeSystem();
	const chat = system.providersFor("chat");

	assert.equal(chat.find((p) => p.id === "ollama").isLocal, true);
	assert.ok(!chat.find((p) => p.id === "openai").isLocal);
	assert.ok(!chat.find((p) => p.id === "openai-compatible")?.isLocal);
});

// ── First-run policy ─────────────────────────────────────────────────────────

test("with no policy file, a self-hosted provider defaults to local", () => {
	const { system } = makeSystem();
	assert.equal(system.getPolicy().chat.ollama.policy, "local");
});

test("with no policy file, a provider the vault has no key for defaults to bring-your-own", () => {
	const { system } = makeSystem();
	assert.equal(system.getPolicy().chat.anthropic.policy, "byok");
});

test("a stored policy document is loaded in preference to the defaults", () => {
	const fsImpl = makeFs({ [POLICY_PATH]: JSON.stringify({ chat: { anthropic: "off" } }) });
	const { system } = makeSystem({ fsImpl });

	assert.equal(system.getPolicy().chat.anthropic.policy, "off");
});

test("setting a policy validates it and persists it", () => {
	const { system, fsImpl } = makeSystem();

	system.setPolicy({ chat: { openai: { policy: "shared", maxCallsPerLobby: 25 } } });

	assert.equal(system.getPolicy().chat.openai.maxCallsPerLobby, 25);
	assert.ok(fsImpl.files[POLICY_PATH].includes("maxCallsPerLobby"));
});

test("an invalid policy is refused and nothing is written", () => {
	const { system, fsImpl } = makeSystem();

	assert.throws(() => system.setPolicy({ chat: { openai: { policy: "everyone" } } }), /everyone/);
	assert.equal(Object.hasOwn(fsImpl.files, POLICY_PATH), false);
});

test("a policy change takes effect on the next resolution without rebuilding anything", () => {
	const { system } = makeSystem();
	system.vault.set("openai", OPENAI_KEY);
	system.setPolicy({ chat: { openai: "off" } });

	assert.throws(() => system.resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }), CredentialRequiredError);

	system.setPolicy({ chat: { openai: "shared" } });
	assert.equal(system.resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" }).source, "server");
});

// ── Importing what is already in the environment ─────────────────────────────

test("keys already in the environment are imported into an empty vault", () => {
	const { system } = makeSystem({ env: { OPENAI_API_KEY: OPENAI_KEY, ELEVEN_API_KEY: ELEVEN_KEY } });

	assert.equal(system.vault.read("openai"), OPENAI_KEY);
	assert.equal(system.vault.read("elevenlabs"), ELEVEN_KEY);
});

test("an imported key defaults to shared, preserving what an existing install already does", () => {
	const { system } = makeSystem({ env: { OPENAI_API_KEY: OPENAI_KEY } });
	assert.equal(system.getPolicy().chat.openai.policy, "shared");
});

test("the legacy Claude variable is imported under the provider id the registry uses", () => {
	const { system } = makeSystem({ env: { CLAUDE_API_KEY: "test-token-DO-NOT-USE-claude" } });
	assert.equal(system.vault.read("anthropic"), "test-token-DO-NOT-USE-claude");
});

test("the environment never overwrites a key already in the vault", () => {
	const fsImpl = makeFs();
	makeSystem({ fsImpl }).system.vault.set("openai", OPENAI_KEY);

	const { system } = makeSystem({ fsImpl, env: { OPENAI_API_KEY: "test-token-DO-NOT-USE-stale" } });
	assert.equal(system.vault.read("openai"), OPENAI_KEY);
});

test("a blank environment variable is not imported as a key", () => {
	const { system } = makeSystem({ env: { OPENAI_API_KEY: "   " } });
	assert.equal(system.vault.read("openai"), null);
});

// ── Resolution end to end ────────────────────────────────────────────────────

test("a shared key in the vault serves a call", () => {
	const { system } = makeSystem();
	system.vault.set("openai", OPENAI_KEY);
	system.setPolicy({ chat: { openai: "shared" } });

	const resolved = system.resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	assert.equal(resolved.source, "server");
	assert.equal(resolved.config.apiKey, OPENAI_KEY);
});

test("a host's own key beats the instance's", () => {
	const { system } = makeSystem();
	system.vault.set("openai", OPENAI_KEY);
	system.setPolicy({ chat: { openai: "shared" } });
	system.sessionKeys.put(LOBBY, {
		capability: "chat",
		config: { providerId: "openai", apiKey: "test-token-DO-NOT-USE-host", model: "gpt-4o", baseUrl: null },
		ownerSid: "socket-host",
		consent: true,
	});

	const resolved = system.resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "openai" });
	assert.equal(resolved.source, "host");
});

test("a local chat provider resolves with an address and no key", () => {
	const { system } = makeSystem();

	const resolved = system.resolver.resolve({ lobbyId: LOBBY, capability: "chat", providerId: "ollama" });
	assert.equal(resolved.source, "local");
	assert.equal(resolved.config.apiKey, null);
	assert.match(resolved.config.baseUrl, /^http/);
});

// ── Describing the instance ──────────────────────────────────────────────────

test("the operator view lists every provider of every capability", () => {
	const { system } = makeSystem();
	const described = system.describe();

	assert.ok(described.chat.providers.length >= 5);
	assert.ok(described.speech.providers.length >= 2);
	assert.ok(described.image.providers.length >= 2);
});

test("the player view reflects live availability the server has probed", () => {
	const { system } = makeSystem();
	system.setPolicy({ chat: { ollama: "local" } });

	system.setAvailability("chat", { ollama: false });
	assert.equal(system.describeForPlayers().chat.anyUsableWithoutPlayerKey, false);

	system.setAvailability("chat", { ollama: true });
	assert.equal(system.describeForPlayers().chat.anyUsableWithoutPlayerKey, true);
});

test("neither description carries key material", () => {
	const { system } = makeSystem();
	system.vault.set("openai", OPENAI_KEY);
	system.setPolicy({ chat: { openai: "shared" } });

	for (const described of [system.describe(), system.describeForPlayers()]) {
		assert.ok(!JSON.stringify(described).includes(OPENAI_KEY));
	}
});

// ── Running without a vault secret ───────────────────────────────────────────

test("with no secret the system still assembles, holding keys only in memory", () => {
	const { system, fsImpl } = makeSystem({ secret: null });

	system.vault.set("openai", OPENAI_KEY);

	assert.equal(system.vault.persistent, false);
	assert.equal(system.vault.read("openai"), OPENAI_KEY);
	assert.equal(Object.hasOwn(fsImpl.files, VAULT_PATH), false);
});

test("the placeholders from .env.example are not imported as if they were keys", () => {
	// The exact reproduction of a fresh install: copy `.env.example`, boot, and the server announced
	// "Playable without a player key" while holding `Open_AI_API_KEY_HERE` as OpenAI's credential.
	// Every DM turn then failed on authentication, after being told the setup was fine.
	const { system } = makeSystem({
		env: {
			OPENAI_API_KEY: "Open_AI_API_KEY_HERE",
			CLAUDE_API_KEY: "Anthropic_API_KEY_HERE",
			ELEVEN_API_KEY: "ELEVEN_LABS_API_KEY_HERE",
		},
	});

	assert.equal(system.vault.has("openai"), false);
	assert.equal(system.vault.has("anthropic"), false);
	assert.equal(system.vault.has("elevenlabs"), false);
});

test("the other shapes a placeholder takes are refused too", () => {
	// People edit these by hand, and half-done edits look like this.
	for (const placeholder of [
		"your-api-key-here", "YOUR_KEY", "sk-xxxxxxxx", "changeme", "CHANGE_ME",
		"TODO", "<your key>", "xxx", "none", "replace-me",
	]) {
		const { system } = makeSystem({ env: { OPENAI_API_KEY: placeholder } });
		assert.equal(system.vault.has("openai"), false, `"${placeholder}" should not be treated as a key`);
	}
});

test("a real-looking key is still imported, because that is the point of the feature", () => {
	// The guard must not be so eager that it rejects genuine keys — an upgrade has to keep working.
	for (const real of [OPENAI_KEY, "sk-proj-aB3dEf7hIjKlMnOpQrStUvWxYz012345", "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ"]) {
		const { system } = makeSystem({ env: { OPENAI_API_KEY: real } });
		assert.equal(system.vault.read("openai"), real, `"${real.slice(0, 8)}…" is a plausible key and must import`);
	}
});

test("a refused placeholder leaves the provider on byok rather than shared", () => {
	// The consequence that matters: `shared` means "this server pays", and a server holding a
	// placeholder cannot pay for anything. It has to fall back to asking the player.
	const { system } = makeSystem({ env: { OPENAI_API_KEY: "Open_AI_API_KEY_HERE" } });
	assert.equal(system.getPolicy().chat.openai.policy, "byok");
});
