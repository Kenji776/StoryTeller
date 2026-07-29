import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";

import { createLLMGateway, AI_UNAVAILABLE_PREFIX } from "./llmGateway.js";
import { createCredentialSystem } from "./credentials/index.js";
import { isLLMFailure } from "./llmFailure.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const SERVER_KEY = "test-token-DO-NOT-USE-server";
const HOST_KEY = "test-token-DO-NOT-USE-host";
const SECRET = "test-vault-secret-DO-NOT-USE";

const DATA_DIR = "/data";
const LOG_DIR = "/logs";
const LOBBY = "lobby-1";
const MESSAGES = [{ role: "system", content: "You are the DM." }, { role: "user", content: "I open the door." }];

/**
 * @description Builds an in-memory filesystem double.
 * @param {object} [seed] - Initial path→contents map.
 * @returns {object} An fs-shaped double.
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
		appendFileSync: (p, data) => { files[p] = (files[p] ?? "") + data; },
		mkdirSync: () => {},
	};
}

/**
 * @description Builds a fetch double answering a chat completion.
 * @param {object} [options] - How the fake provider should answer.
 * @returns {Function} A fetch-shaped function carrying a `calls` array.
 */
function makeFetch({ status = 200, body, throws } = {}) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
		if (throws) throw throws;
		const answer = body ?? { content: [{ type: "text", text: "The door creaks open." }], model: "claude-sonnet-4-6" };
		return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(answer) };
	};
	impl.calls = calls;
	return impl;
}

/**
 * Assembles a gateway over a real credential system and fake I/O.
 *
 * @param {object} [options] - Overrides.
 * @returns {object} The gateway, the credential system, and the failures reported.
 */
function makeGateway({ fetchImpl = makeFetch(), policy, vaultKeys = {} } = {}) {
	const fsImpl = makeFs();
	const credentials = createCredentialSystem({
		fsImpl, dataDir: DATA_DIR, secret: SECRET, env: {}, log: () => {},
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});
	for (const [id, key] of Object.entries(vaultKeys)) credentials.vault.set(id, key);
	if (policy) credentials.setPolicy(policy);

	const failures = [];
	const gateway = createLLMGateway({
		credentials,
		fsImpl,
		logDir: LOG_DIR,
		fetchImpl,
		log: () => {},
		now: () => new Date("2026-07-27T12:00:00.000Z"),
		onFailure: (detail) => failures.push(detail),
	});
	return { gateway, credentials, failures, fsImpl, fetchImpl };
}

// ── The happy path, on the existing contract ─────────────────────────────────

test("a reply comes back as a plain string, as every call site already expects", async () => {
	const { gateway } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });
	assert.equal(typeof reply, "string");
	assert.equal(reply, "The door creaks open.");
});

test("the instance's shared key is what reaches the provider", async () => {
	const { gateway, fetchImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });
	assert.equal(fetchImpl.calls[0].init.headers["x-api-key"], SERVER_KEY);
});

test("a host's own key is preferred over the instance's", async () => {
	const { gateway, credentials, fetchImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});
	credentials.sessionKeys.put(LOBBY, {
		capability: "chat",
		config: { providerId: "anthropic", apiKey: HOST_KEY, model: "claude-sonnet-4-6", baseUrl: null },
		ownerSid: "socket-host",
		consent: true,
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });
	assert.equal(fetchImpl.calls[0].init.headers["x-api-key"], HOST_KEY);
});

test("the lobby's chosen model is the one requested", async () => {
	const { gateway, fetchImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-opus-4-6", lobbyId: LOBBY });
	assert.equal(fetchImpl.calls[0].payload.model, "claude-opus-4-6");
});

test("the legacy provider id for Anthropic still resolves", async () => {
	const { gateway, fetchImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	// Lobbies persisted before the registry existed carry llmProvider: "claude".
	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "claude", model: "claude-sonnet-4-6", lobbyId: LOBBY });

	assert.equal(isLLMFailure(reply), false, `a lobby stored as "claude" could not resolve: ${reply}`);
	assert.equal(fetchImpl.calls.length, 1);
});

// ── Failure is a string the existing guard recognises ────────────────────────

test("a provider with no credential answers with a recognised failure rather than throwing", async () => {
	const { gateway } = makeGateway({ policy: { chat: { anthropic: "byok" } } });

	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });

	assert.ok(reply.startsWith(AI_UNAVAILABLE_PREFIX));
	assert.equal(isLLMFailure(reply), true, "the failure guard did not recognise the gateway's sentinel");
});

test("the failure text tells the host what to do about it", async () => {
	const { gateway } = makeGateway({ policy: { chat: { anthropic: "byok" } } });
	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });

	assert.match(reply, /Anthropic/);
	assert.match(reply, /key/i);
});

test("a rejected key answers with a failure rather than throwing", async () => {
	const { gateway } = makeGateway({
		fetchImpl: makeFetch({ status: 401, body: { error: { message: "invalid key" } } }),
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });
	assert.equal(isLLMFailure(reply), true);
});

test("an unreachable provider answers with a failure rather than throwing", async () => {
	const { gateway } = makeGateway({
		fetchImpl: makeFetch({ throws: new Error("ECONNREFUSED") }),
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	assert.equal(isLLMFailure(await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY })), true);
});

test("an unknown provider answers with a failure rather than throwing", async () => {
	const { gateway } = makeGateway();
	assert.equal(isLLMFailure(await gateway.getLLMResponse(MESSAGES, { provider: "hal9000", lobbyId: LOBBY })), true);
});

test("no failure string carries key material", async () => {
	const { gateway } = makeGateway({
		fetchImpl: makeFetch({ status: 401, body: { error: { message: `bad key ${SERVER_KEY}` } } }),
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY });
	assert.ok(!reply.includes(SERVER_KEY), "a failure string echoed the key back");
});

// ── Failures are reported structurally, not only as a string ─────────────────

test("a missing credential is reported to the host-facing listener", async () => {
	const { gateway, failures } = makeGateway({ policy: { chat: { anthropic: "byok" } } });

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY });

	assert.equal(failures.length, 1);
	assert.equal(failures[0].lobbyId, LOBBY);
	assert.equal(failures[0].capability, "chat");
	assert.equal(failures[0].reason, "byok");
	assert.match(failures[0].message, /Anthropic/);
});

test("a provider failure is reported with its kind, so retry can be decided", async () => {
	const { gateway, failures } = makeGateway({
		fetchImpl: makeFetch({ status: 429, body: { error: { message: "slow down" } } }),
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });

	assert.equal(failures[0].kind, "rate_limit");
	assert.equal(failures[0].retryable, true);
});

test("a successful call reports no failure", async () => {
	const { gateway, failures } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });
	assert.deepEqual(failures, []);
});

// ── The call journal ─────────────────────────────────────────────────────────

test("every call is journalled under the lobby it belongs to", async () => {
	const { gateway, fsImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });

	const written = fsImpl.files[path.join(LOG_DIR, `llm-${LOBBY}.jsonl`)];
	assert.ok(written, "no journal entry was written");
	const entry = JSON.parse(written.trim());
	assert.equal(entry.lobbyId, LOBBY);
	assert.equal(entry.provider, "anthropic");
	assert.equal(entry.model, "claude-sonnet-4-6");
});

test("the journal records whose credential paid", async () => {
	const { gateway, fsImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY });

	const entry = JSON.parse(fsImpl.files[path.join(LOG_DIR, `llm-${LOBBY}.jsonl`)].trim());
	assert.equal(entry.source, "server");
});

test("the journal never contains key material", async () => {
	const { gateway, credentials, fsImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});
	credentials.sessionKeys.put(LOBBY, {
		capability: "chat",
		config: { providerId: "anthropic", apiKey: HOST_KEY, model: "claude-sonnet-4-6", baseUrl: null },
		ownerSid: "socket-host",
		consent: true,
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY });

	const journal = Object.entries(fsImpl.files).filter(([p]) => p.includes("llm-")).map(([, v]) => v).join("");
	assert.ok(!journal.includes(HOST_KEY), "the journal carried the host's key");
	assert.ok(!journal.includes(SERVER_KEY), "the journal carried the instance's key");
});

test("a failed call is journalled too, with its error", async () => {
	const { gateway, fsImpl } = makeGateway({
		fetchImpl: makeFetch({ status: 500, body: { error: { message: "boom" } } }),
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY });

	const entry = JSON.parse(fsImpl.files[path.join(LOG_DIR, `llm-${LOBBY}.jsonl`)].trim());
	assert.ok(entry.error, "a failed call left no error in the journal");
});

test("a journal write failure never takes down the call", async () => {
	const { gateway, fsImpl } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});
	fsImpl.appendFileSync = () => { throw new Error("EACCES"); };

	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", model: "claude-sonnet-4-6", lobbyId: LOBBY });
	assert.equal(reply, "The door creaks open.");
});

// ── Images ──────────────────────────────────────────────────────────────────

test("an image is generated through the configured provider", async () => {
	const fetchImpl = makeFetch({ body: { images: ["iVBORw0KGgo="], seed: 7, model: "krea2" } });
	const { gateway } = makeGateway({
		fetchImpl,
		policy: { image: { "local-image": { policy: "local", baseUrl: "http://192.168.1.50:8189" } } },
		// Self-hosted, but still token-gated: the operator holds it, not the player.
		vaultKeys: { "local-image": SERVER_KEY },
	});

	const result = await gateway.generateImage({ prompt: "a dwarf", lobbyId: LOBBY });
	assert.equal(result.b64, "iVBORw0KGgo=");
	assert.equal(result.model, "krea2");
});

test("image generation with no configured provider throws, because the route reports it", async () => {
	const { gateway } = makeGateway({ policy: { image: { "local-image": "off", openai: "off" } } });

	await assert.rejects(
		() => gateway.generateImage({ prompt: "a dwarf", lobbyId: LOBBY }),
		/unavailable|not offered|no image/i,
	);
});

test("image generation prefers the provider the lobby asked for", async () => {
	const fetchImpl = makeFetch({ body: { data: [{ b64_json: "iVBORw0KGgo=" }] } });
	const { gateway } = makeGateway({
		fetchImpl,
		policy: { image: { openai: "shared" } },
		vaultKeys: { openai: SERVER_KEY },
	});

	await gateway.generateImage({ prompt: "a dwarf", lobbyId: LOBBY, provider: "openai" });
	assert.match(fetchImpl.calls[0].url, /images\/generations/);
});

test("a lobby with no model configured fails with a message naming the problem", async () => {
	const { gateway } = makeGateway({
		policy: { chat: { anthropic: "shared" } },
		vaultKeys: { anthropic: SERVER_KEY },
	});

	const reply = await gateway.getLLMResponse(MESSAGES, { provider: "anthropic", lobbyId: LOBBY });

	assert.equal(isLLMFailure(reply), true);
	assert.match(reply, /model/i);
});

// ── Character continuity ─────────────────────────────────────────────────────

/** Policy and vault for a lobby whose images come from the local server. */
const IMAGE_SETUP = {
	policy: { image: { "local-image": { policy: "local", baseUrl: "http://192.168.1.50:8189" } } },
	vaultKeys: { "local-image": SERVER_KEY },
};

/**
 * @description Builds a fetch double answering each call from a queue.
 * @param {Array<object>} script - One response per call, in order.
 * @returns {Function} A fetch-shaped function carrying a `calls` array.
 */
function makeScript(script) {
	const queue = [...script];
	const calls = [];
	const impl = async (url, init) => {
		const spec = queue.shift() ?? { body: {} };
		calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
		const status = spec.status ?? 200;
		return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(spec.body ?? {}) };
	};
	impl.calls = calls;
	return impl;
}

test("a player drawn for the first time gets a stored likeness", async () => {
	const fetchImpl = makeScript([{ body: { id: "chr_1", image: "iVBORw0KGgo=" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	const result = await gateway.ensureCharacterImage({
		lobbyId: LOBBY, record: {}, name: "Brannor", appearance: "A Dwarf Paladin. Copper beard.",
	});

	assert.equal(result.characterId, "chr_1");
	assert.equal(result.created, true);
	assert.match(fetchImpl.calls[0].url, /\/characters$/);
});

test("a player drawn again with the same appearance keeps their likeness", async () => {
	const fetchImpl = makeScript([{ body: { images: ["iVBORw0KGgo="], model: "krea2" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	const result = await gateway.ensureCharacterImage({
		lobbyId: LOBBY,
		record: { imageCharacterId: "chr_1", imageAppearance: "A Dwarf Paladin. Copper beard." },
		name: "Brannor",
		appearance: "A Dwarf Paladin. Copper beard.",
	});

	assert.equal(result.characterId, "chr_1");
	assert.equal(result.created, false);
	assert.match(fetchImpl.calls[0].url, /\/characters\/chr_1\/generate$/, "an existing likeness should be posed, not recreated");
});

test("a permanently changed appearance mints a new likeness and retires the old", async () => {
	const fetchImpl = makeScript([
		{ body: { id: "chr_2", image: "iVBORw0KGgo=" } },
		{ body: { ok: true } },
	]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	const result = await gateway.ensureCharacterImage({
		lobbyId: LOBBY,
		record: { imageCharacterId: "chr_1", imageAppearance: "A Dwarf Paladin. Copper beard." },
		name: "Brannor",
		appearance: "A Dwarf Paladin. Copper beard, and a missing eye.",
	});

	assert.equal(result.characterId, "chr_2");
	assert.ok(fetchImpl.calls.some((c) => /\/characters\/chr_1\/delete$/.test(c.url)), "the orphaned likeness was not cleaned up");
});

test("failing to retire an old likeness does not fail the new portrait", async () => {
	const fetchImpl = makeScript([
		{ body: { id: "chr_2", image: "iVBORw0KGgo=" } },
		{ status: 500, body: { error: "boom" } },
	]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	const result = await gateway.ensureCharacterImage({
		lobbyId: LOBBY,
		record: { imageCharacterId: "chr_1", imageAppearance: "old" },
		name: "Brannor",
		appearance: "A Dwarf Paladin.",
	});

	assert.equal(result.characterId, "chr_2", "a cleanup failure must not lose the portrait that succeeded");
});

test("a provider with no character support falls back to a plain image", async () => {
	const fetchImpl = makeScript([{ body: { data: [{ b64_json: "iVBORw0KGgo=" }] } }]);
	const { gateway } = makeGateway({
		policy: { image: { openai: "shared" } },
		vaultKeys: { openai: SERVER_KEY },
		fetchImpl,
	});

	const result = await gateway.ensureCharacterImage({
		lobbyId: LOBBY, record: {}, name: "Brannor", appearance: "A Dwarf Paladin.", provider: "openai",
	});

	assert.equal(result.characterId, null);
	assert.ok(result.b64, "a provider without continuity should still draw a portrait");
});

test("posing a stored character sends only the scene", async () => {
	const fetchImpl = makeScript([{ body: { images: ["iVBORw0KGgo="], model: "krea2" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	await gateway.generateCharacterScene({
		lobbyId: LOBBY, characterId: "chr_1", moment: "standing over a fallen troll", mood: "triumphant", name: "Brannor",
	});

	const payload = fetchImpl.calls[0].payload;
	assert.match(payload.scene, /fallen troll/);
	assert.match(payload.scene, /triumphant/);
	assert.equal(Object.hasOwn(payload, "prompt"), false);
	assert.doesNotMatch(payload.scene, /Brannor/);
});

test("posing a character the server has forgotten reports it clearly", async () => {
	const fetchImpl = makeScript([{ status: 404, body: { error: "no such character" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	await assert.rejects(
		() => gateway.generateCharacterScene({ lobbyId: LOBBY, characterId: "gone", moment: "fighting" }),
		/character|not found|404/i,
	);
});

test("scenes are unavailable on a provider that cannot pose a character", async () => {
	const { gateway } = makeGateway({ policy: { image: { openai: "shared" } }, vaultKeys: { openai: SERVER_KEY } });

	await assert.rejects(
		() => gateway.generateCharacterScene({ lobbyId: LOBBY, characterId: "chr_1", moment: "fighting", provider: "openai" }),
		/does not support|continuity|scene/i,
	);
});

// ── The portrait a player is shown is posed, not a reference shot ────────────
//
// The image server draws a neutral, front-facing reference when a likeness is
// created — correct for identity matching, and exactly the driving-licence photo the
// operator complained about, because that reference was handed straight to the player
// as their portrait. The reference stays neutral; what they are shown is rendered
// from it with direction.

test("a first portrait is rendered from the new likeness rather than being the reference", async () => {
	const fetchImpl = makeScript([
		{ body: { id: "chr_1", image: "cmVmZXJlbmNl" } },          // createCharacter
		{ body: { images: ["cG9zZWQ="], model: "krea2" } },         // the posed render
	]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	const result = await gateway.ensureCharacterImage({
		lobbyId: LOBBY, record: {}, name: "Brannor", appearance: "A Dwarf Paladin. Copper beard.",
	});

	assert.equal(result.characterId, "chr_1");
	assert.equal(result.created, true);
	assert.equal(result.b64, "cG9zZWQ=", "the player was handed the reference shot");
	assert.match(fetchImpl.calls[0].url, /\/characters$/);
	assert.match(fetchImpl.calls[1].url, /generate/);
});

test("the portrait scene directs a pose, and never asks them to face the viewer", async () => {
	// "a formal character portrait, facing the viewer" was hardcoded here.
	const fetchImpl = makeScript([{ body: { images: ["cG9zZWQ="], model: "krea2" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	await gateway.ensureCharacterImage({
		lobbyId: LOBBY,
		record: { imageCharacterId: "chr_1", imageAppearance: "A Dwarf Paladin. Copper beard." },
		name: "Brannor",
		appearance: "A Dwarf Paladin. Copper beard.",
	});

	const { scene } = fetchImpl.calls[0].payload;
	assert.doesNotMatch(scene, /facing the viewer|formal/i, "still asking for a passport photo");
	assert.match(scene, /pose|motion|stance|angle/i, "the scene gives no direction");
});

test("a caller may direct the portrait itself", async () => {
	const fetchImpl = makeScript([{ body: { images: ["cG9zZWQ="], model: "krea2" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	await gateway.ensureCharacterImage({
		lobbyId: LOBBY,
		record: { imageCharacterId: "chr_1", imageAppearance: "A Dwarf Paladin. Copper beard." },
		name: "Brannor",
		appearance: "A Dwarf Paladin. Copper beard.",
		portraitScene: "mid-leap over a chasm, cloak snapping",
	});

	assert.equal(fetchImpl.calls[0].payload.scene, "mid-leap over a chasm, cloak snapping");
});

test("the scene carries direction only, never the appearance", async () => {
	// The image server prepends the stored appearance itself; restating it inside the
	// scene is the documented cause of the likeness drifting.
	const fetchImpl = makeScript([{ body: { images: ["cG9zZWQ="], model: "krea2" } }]);
	const { gateway } = makeGateway({ ...IMAGE_SETUP, fetchImpl });

	await gateway.ensureCharacterImage({
		lobbyId: LOBBY,
		record: { imageCharacterId: "chr_1", imageAppearance: "A Dwarf Paladin. Copper beard." },
		name: "Brannor",
		appearance: "A Dwarf Paladin. Copper beard.",
	});

	assert.doesNotMatch(fetchImpl.calls[0].payload.scene, /Dwarf|Paladin|Copper beard/i);
});
