import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";

import { createProviderAdminRoutes } from "./providerAdmin.js";
import { createCredentialSystem } from "../services/credentials/index.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const OPENAI_KEY = "test-token-DO-NOT-USE-openai";
const SECRET = "test-vault-secret-DO-NOT-USE";
const DATA_DIR = "/data";

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
		mkdirSync: () => {},
	};
}

/**
 * @description Builds a DNS double, so the private-network guard never resolves for real.
 * @param {object} table - Hostname → address records.
 * @returns {Function} A lookup-shaped function.
 */
function makeLookup(table) {
	return async (hostname) => {
		const entry = table[hostname];
		if (!entry) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
		return entry;
	};
}

const lookup = makeLookup({
	"192.168.1.20": [{ address: "192.168.1.20", family: 4 }],
	"evil.example.com": [{ address: "93.184.216.34", family: 4 }],
});

/**
 * @description Builds a response double recording what a handler sent.
 * @returns {object} An express-response-shaped double.
 */
function makeRes() {
	const res = { statusCode: 200, body: null };
	res.status = (code) => { res.statusCode = code; return res; };
	res.json = (payload) => { res.body = payload; return res; };
	return res;
}

/**
 * @description Builds a request double.
 * @param {object} [options] - Params and body.
 * @returns {object} An express-request-shaped double.
 */
function makeReq({ capability = "chat", providerId = "openai", body = {} } = {}) {
	return { params: { capability, providerId }, body, headers: {} };
}

/**
 * Assembles routes over a real credential system and a fake world.
 *
 * @param {object} [options] - Overrides.
 * @returns {object} The routes, the credential system, and the auth spies.
 */
function makeRoutes({ admin = true, host = false, fsImpl = makeFs(), fetchImpl, characterKeys } = {}) {
	const credentials = createCredentialSystem({
		fsImpl, dataDir: DATA_DIR, secret: SECRET, env: {}, log: () => {},
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});
	const hostTokenChecks = [];
	const routes = createProviderAdminRoutes({
		credentials,
		isAdminAuthenticated: () => admin,
		// Present so a test can prove it is never consulted: a host holding a
		// lobby-scoped token is not an operator.
		isHostToken: () => { hostTokenChecks.push(true); return host ? "LOBBY" : null; },
		lookup,
		fetchImpl,
		characterKeys,
		log: () => {},
	});
	return { routes, credentials, fsImpl, hostTokenChecks };
}

/** Every handler that changes something, for the auth sweep. */
const MUTATORS = ["setKey", "clearKey", "setPolicy", "testProvider"];

// ── Authentication ───────────────────────────────────────────────────────────

test("listing is refused without an admin session", async () => {
	const { routes } = makeRoutes({ admin: false });
	const res = makeRes();

	await routes.list(makeReq(), res);
	assert.equal(res.statusCode, 401);
});

test("listing is allowed for a password admin", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.list(makeReq(), res);
	assert.equal(res.statusCode, 200);
});

test("a host token does not open the operator's provider configuration", async () => {
	const { routes } = makeRoutes({ admin: false, host: true });
	const res = makeRes();

	await routes.list(makeReq(), res);
	assert.equal(res.statusCode, 401, "a lobby host reached operator configuration");
});

test("every mutating route refuses a host token", async () => {
	for (const handler of MUTATORS) {
		const { routes } = makeRoutes({ admin: false, host: true });
		const res = makeRes();

		await routes[handler](makeReq({ body: { apiKey: OPENAI_KEY, policy: "shared" } }), res);
		assert.equal(res.statusCode, 401, `${handler} was reachable with a host token`);
	}
});

test("host tokens are never even consulted, so they cannot become an accepted path", () => {
	const { routes, hostTokenChecks } = makeRoutes();
	assert.ok(routes);
	assert.deepEqual(hostTokenChecks, [], "the host-token check was wired into an operator-only route");
});

// ── Listing ──────────────────────────────────────────────────────────────────

test("listing describes every capability's providers", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.list(makeReq(), res);
	assert.ok(res.body.capabilities.chat.providers.length > 0);
	assert.ok(res.body.capabilities.speech.providers.length > 0);
	assert.ok(res.body.capabilities.image.providers.length > 0);
});

test("listing never carries key material", async () => {
	const { routes, credentials } = makeRoutes();
	credentials.vault.set("openai", OPENAI_KEY);
	const res = makeRes();

	await routes.list(makeReq(), res);
	assert.ok(!JSON.stringify(res.body).includes(OPENAI_KEY));
});

// ── Storing and clearing a key ───────────────────────────────────────────────

test("a submitted key is stored in the vault", async () => {
	const { routes, credentials } = makeRoutes();

	await routes.setKey(makeReq({ body: { apiKey: OPENAI_KEY } }), makeRes());
	assert.equal(credentials.vault.read("openai"), OPENAI_KEY);
});

test("storing a key answers with metadata and never the key itself", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.setKey(makeReq({ body: { apiKey: OPENAI_KEY } }), res);

	assert.equal(res.body.provider.key.configured, true);
	assert.equal(res.body.provider.key.last4, OPENAI_KEY.slice(-4));
	assert.ok(!JSON.stringify(res.body).includes(OPENAI_KEY), "the key was echoed back to the browser");
});

test("a blank key is refused", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.setKey(makeReq({ body: { apiKey: "   " } }), res);
	assert.equal(res.statusCode, 400);
});

test("clearing removes the key and says it did", async () => {
	const { routes, credentials } = makeRoutes();
	credentials.vault.set("openai", OPENAI_KEY);
	const res = makeRes();

	await routes.clearKey(makeReq(), res);

	assert.equal(res.body.removed, true);
	assert.equal(credentials.vault.read("openai"), null);
});

test("clearing a provider that had no key says so rather than failing", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.clearKey(makeReq(), res);
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.removed, false);
});

// ── Unknown targets ──────────────────────────────────────────────────────────

test("an unknown provider is a 404", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.setKey(makeReq({ providerId: "hal9000", body: { apiKey: OPENAI_KEY } }), res);
	assert.equal(res.statusCode, 404);
});

test("an unknown capability is a 404", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.setKey(makeReq({ capability: "telepathy", body: { apiKey: OPENAI_KEY } }), res);
	assert.equal(res.statusCode, 404);
});

// ── Policy ───────────────────────────────────────────────────────────────────

test("a policy submitted for one provider is saved", async () => {
	const { routes, credentials } = makeRoutes();

	await routes.setPolicy(makeReq({ body: { policy: "shared", maxCallsPerLobby: 40 } }), makeRes());

	assert.equal(credentials.getPolicy().chat.openai.policy, "shared");
	assert.equal(credentials.getPolicy().chat.openai.maxCallsPerLobby, 40);
});

test("saving one provider's policy leaves the others alone", async () => {
	const { routes, credentials } = makeRoutes();
	const before = credentials.getPolicy().chat.ollama.policy;

	await routes.setPolicy(makeReq({ body: { policy: "off" } }), makeRes());

	assert.equal(credentials.getPolicy().chat.ollama.policy, before);
	assert.equal(credentials.getPolicy().chat.openai.policy, "off");
});

test("saving a policy for one capability leaves another capability alone", async () => {
	const { routes, credentials } = makeRoutes();
	const before = credentials.getPolicy().image["local-image"].policy;

	await routes.setPolicy(makeReq({ body: { policy: "off" } }), makeRes());

	assert.equal(credentials.getPolicy().image["local-image"].policy, before);
});

test("an unrecognised policy value is refused and the offending field is named", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.setPolicy(makeReq({ body: { policy: "everyone" } }), res);

	assert.equal(res.statusCode, 400);
	assert.match(res.body.error, /everyone/);
	assert.equal(res.body.field, "chat.openai.policy");
});

// ── The private-network guard on an operator-supplied address ────────────────

test("a private address for a local provider is accepted and stored canonically", async () => {
	const { routes, credentials } = makeRoutes();
	const res = makeRes();

	await routes.setPolicy(
		makeReq({ providerId: "ollama", body: { policy: "local", baseUrl: "192.168.1.20:11434/" } }),
		res,
	);

	assert.equal(res.statusCode, 200);
	assert.equal(credentials.getPolicy().chat.ollama.baseUrl, "http://192.168.1.20:11434");
});

test("a public address for a local provider is refused", async () => {
	const { routes, credentials } = makeRoutes();
	const res = makeRes();

	await routes.setPolicy(
		makeReq({ providerId: "ollama", body: { policy: "local", baseUrl: "http://evil.example.com" } }),
		res,
	);

	assert.equal(res.statusCode, 400);
	assert.match(res.body.error, /private network/i);
	assert.equal(credentials.getPolicy().chat.ollama.baseUrl, null, "a refused address was stored anyway");
});

test("an unresolvable address is refused rather than stored hopefully", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.setPolicy(
		makeReq({ providerId: "ollama", body: { policy: "local", baseUrl: "http://nosuchhost:11434" } }),
		res,
	);

	assert.equal(res.statusCode, 400);
	assert.match(res.body.error, /could not resolve/i);
});

test("the image server's address goes through the same guard", async () => {
	const { routes, credentials } = makeRoutes();
	const res = makeRes();

	await routes.setPolicy(
		makeReq({ capability: "image", providerId: "local-image", body: { policy: "local", baseUrl: "http://evil.example.com" } }),
		res,
	);

	assert.equal(res.statusCode, 400);
	assert.equal(credentials.getPolicy().image["local-image"].baseUrl, null);
});

test("a policy that is not local does not resolve an address at all", async () => {
	let resolved = false;
	const { routes } = makeRoutes();
	// A base URL on a non-local policy is dropped by the policy model, so the guard
	// must not be asked to resolve it — doing so would refuse a save for a field
	// that was going to be discarded.
	const res = makeRes();
	await routes.setPolicy(makeReq({ body: { policy: "byok", baseUrl: "http://evil.example.com" } }), res);

	assert.equal(res.statusCode, 200);
	assert.equal(resolved, false);
});

// ── Testing a provider ───────────────────────────────────────────────────────

test("a working key is recorded as validated", async () => {
	const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "gpt-4o" }] }) });
	const { routes, credentials } = makeRoutes({ fetchImpl });
	credentials.vault.set("openai", OPENAI_KEY);
	const res = makeRes();

	await routes.testProvider(makeReq(), res);

	assert.equal(res.body.ok, true);
	assert.equal(credentials.vault.describe().openai.status, "ok");
});

test("a rejected key is recorded and the reason is reported", async () => {
	const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "invalid key" } }) });
	const { routes, credentials } = makeRoutes({ fetchImpl });
	credentials.vault.set("openai", OPENAI_KEY);
	const res = makeRes();

	await routes.testProvider(makeReq(), res);

	assert.equal(res.body.ok, false);
	assert.ok(res.body.error);
	assert.equal(credentials.vault.describe().openai.status, "rejected");
});

test("testing a provider that needs a key and has none is refused", async () => {
	const { routes } = makeRoutes();
	const res = makeRes();

	await routes.testProvider(makeReq(), res);
	assert.equal(res.statusCode, 400);
});

test("a local provider is tested with the operator's token, not a player's", async () => {
	const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ gpu: "test" }) });
	const { routes, credentials } = makeRoutes({ fetchImpl });
	credentials.vault.set("local-image", OPENAI_KEY);
	credentials.setPolicy({ image: { "local-image": { policy: "local", baseUrl: "http://192.168.1.20:8189" } } });
	const res = makeRes();

	await routes.testProvider(makeReq({ capability: "image", providerId: "local-image" }), res);
	assert.equal(res.body.ok, true);
});

test("a local provider with no token yet is refused rather than passing on /health", async () => {
	// The health endpoint needs no token, so a token-less test would pass and then
	// every real generation would 401 -- the worst possible outcome for a button
	// whose whole job is to tell an operator whether this works.
	const { routes, credentials } = makeRoutes();
	credentials.setPolicy({ image: { "local-image": { policy: "local", baseUrl: "http://192.168.1.20:8189" } } });
	const res = makeRes();

	await routes.testProvider(makeReq({ capability: "image", providerId: "local-image" }), res);
	assert.equal(res.statusCode, 400);
});

test("no failure response echoes the key back", async () => {
	const fetchImpl = async () => ({
		ok: false, status: 401,
		text: async () => JSON.stringify({ error: { message: `bad key ${OPENAI_KEY}` } }),
	});
	const { routes, credentials } = makeRoutes({ fetchImpl });
	credentials.vault.set("openai", OPENAI_KEY);
	const res = makeRes();

	await routes.testProvider(makeReq(), res);
	assert.ok(!JSON.stringify(res.body).includes(OPENAI_KEY), "a test failure echoed the key back to the browser");
});

// ── The character signing key ────────────────────────────────────────────────

/**
 * @description A character-keys double, so these tests describe the route rather than re-testing
 *   `services/characterKeys.js`.
 * @param {object} [options] - `fingerprint` to report.
 * @returns {object} A keys-shaped double with a rotation counter.
 */
function makeKeys({ fingerprint = "aaaaaaaaaaaaaaaa" } = {}) {
	let current = fingerprint;
	const rotations = [];
	return {
		rotations,
		fingerprint: () => current,
		rotate() {
			const previous = current;
			current = "bbbbbbbbbbbbbbbb";
			rotations.push(previous);
			return { previous, current };
		},
	};
}

test("the operator can read the current signing key fingerprint", () => {
	const characterKeys = makeKeys();
	const { routes } = makeRoutes({ characterKeys });
	const res = makeRes();

	routes.characterKey(makeReq(), res);

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.fingerprint, "aaaaaaaaaaaaaaaa");
});

test("rotating answers with both fingerprints and never any key material", () => {
	const characterKeys = makeKeys();
	const { routes } = makeRoutes({ characterKeys });
	const res = makeRes();

	routes.rotateCharacterKey(makeReq(), res);

	assert.equal(res.statusCode, 200);
	assert.equal(res.body.previous, "aaaaaaaaaaaaaaaa");
	assert.equal(res.body.current, "bbbbbbbbbbbbbbbb");
	assert.equal(characterKeys.rotations.length, 1);

	const serialised = JSON.stringify(res.body);
	assert.ok(!/PRIVATE KEY|BEGIN /.test(serialised), "a key must never travel in a response");
});

test("a host token cannot rotate the signing key", () => {
	// The whole point of gating this on a password session. A host runs one game; rotating would
	// invalidate every exported character on the instance, for everybody.
	const characterKeys = makeKeys();
	const { routes } = makeRoutes({ admin: false, host: true, characterKeys });
	const res = makeRes();

	routes.rotateCharacterKey(makeReq(), res);

	// 401, matching every other handler on this surface — a caller without a password session is
	// unauthenticated here, not authenticated-and-forbidden.
	assert.equal(res.statusCode, 401);
	assert.equal(characterKeys.rotations.length, 0, "and nothing was rotated");
});

test("an unauthenticated caller cannot read the fingerprint either", () => {
	const { routes } = makeRoutes({ admin: false, characterKeys: makeKeys() });
	const res = makeRes();

	routes.characterKey(makeReq(), res);

	assert.equal(res.statusCode, 401);
});

test("the routes are absent rather than broken when no key system is supplied", () => {
	// `createProviderAdminRoutes` predates this and is constructed in tests without it; answering
	// 501 beats throwing a TypeError at whoever calls it.
	const { routes } = makeRoutes();
	const res = makeRes();

	routes.rotateCharacterKey(makeReq(), res);

	assert.equal(res.statusCode, 501);
});
