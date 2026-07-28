import { test } from "node:test";
import assert from "node:assert/strict";

import {
	CAPABILITIES,
	POLICIES,
	PolicyError,
	normalizePolicyDocument,
	policyFor,
	defaultPolicyDocument,
	createPolicyStore,
} from "./policy.js";

const POLICY_PATH = "/data/provider-policy.json";

/** The entry every lookup falls back to. Nothing is offered unless it was configured. */
const CLOSED = { policy: "off", sharedModels: null, maxCallsPerLobby: null, baseUrl: null };

/**
 * Runs a function that must throw, and hands back what it threw.
 *
 * @description `node:assert`'s `throws` returns undefined, so asserting on an
 *   error's own fields — which is the point of `PolicyError.field` — needs the
 *   error itself. Fails the test when nothing is thrown, so this can never turn
 *   into a vacuous pass (`TDD-7`).
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
 * Builds an in-memory stand-in for the filesystem calls the store makes.
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

// ── Happy path ───────────────────────────────────────────────────────────────

test("a full document normalizes to itself", () => {
	const doc = normalizePolicyDocument({
		chat: {
			openai: { policy: "shared", sharedModels: ["gpt-4o-mini"], maxCallsPerLobby: 200 },
			anthropic: { policy: "byok" },
			ollama: { policy: "local", baseUrl: "http://192.168.1.20:11434" },
		},
		speech: { elevenlabs: { policy: "byok" } },
		image: { openai: { policy: "off" } },
	});

	assert.deepEqual(doc.chat.openai, {
		policy: "shared", sharedModels: ["gpt-4o-mini"], maxCallsPerLobby: 200, baseUrl: null,
	});
	assert.deepEqual(doc.chat.anthropic, { policy: "byok", sharedModels: null, maxCallsPerLobby: null, baseUrl: null });
	assert.deepEqual(doc.chat.ollama, {
		policy: "local", sharedModels: null, maxCallsPerLobby: null, baseUrl: "http://192.168.1.20:11434",
	});
});

test("a bare policy string is accepted as shorthand for an entry", () => {
	const doc = normalizePolicyDocument({ chat: { anthropic: "byok" } });
	assert.deepEqual(doc.chat.anthropic, { policy: "byok", sharedModels: null, maxCallsPerLobby: null, baseUrl: null });
});

test("policyFor returns the entry a capability and provider resolve to", () => {
	const doc = normalizePolicyDocument({ chat: { openai: { policy: "shared", maxCallsPerLobby: 50 } } });
	assert.deepEqual(policyFor(doc, "chat", "openai"), {
		policy: "shared", sharedModels: null, maxCallsPerLobby: 50, baseUrl: null,
	});
});

test("every capability is present after normalization even when the input omits it", () => {
	const doc = normalizePolicyDocument({ chat: { openai: "shared" } });
	assert.deepEqual(Object.keys(doc).sort(), [...CAPABILITIES].sort());
	assert.deepEqual(doc.speech, {});
	assert.deepEqual(doc.image, {});
});

test("the recognised policies are exactly the four the model defines", () => {
	assert.deepEqual([...POLICIES].sort(), ["byok", "local", "off", "shared"]);
});

// ── Defaults ─────────────────────────────────────────────────────────────────

test("a provider the vault holds a key for defaults to shared", () => {
	const doc = defaultPolicyDocument({
		known: { chat: [{ id: "openai", local: false }] },
		configured: { chat: ["openai"] },
	});
	assert.equal(doc.chat.openai.policy, "shared");
});

test("a key-requiring provider with no key defaults to bring-your-own", () => {
	const doc = defaultPolicyDocument({
		known: { chat: [{ id: "anthropic", local: false }] },
		configured: { chat: [] },
	});
	assert.equal(doc.chat.anthropic.policy, "byok");
});

test("a provider needing no key defaults to local regardless of the vault", () => {
	const doc = defaultPolicyDocument({
		known: { chat: [{ id: "ollama", local: true }] },
		configured: { chat: ["ollama"] },
	});
	assert.equal(doc.chat.ollama.policy, "local");
});

test("defaults over no known providers produce an empty but complete document", () => {
	const doc = defaultPolicyDocument({ known: {}, configured: {} });
	assert.deepEqual(Object.keys(doc).sort(), [...CAPABILITIES].sort());
	assert.deepEqual(doc.chat, {});
});

// ── Boundary and fail-closed ─────────────────────────────────────────────────

test("an unknown capability resolves to off rather than throwing", () => {
	assert.deepEqual(policyFor(normalizePolicyDocument({}), "telepathy", "openai"), CLOSED);
});

test("an unconfigured provider resolves to off", () => {
	assert.deepEqual(policyFor(normalizePolicyDocument({}), "chat", "openai"), CLOSED);
});

test("policyFor over a null document resolves to off", () => {
	assert.deepEqual(policyFor(null, "chat", "openai"), CLOSED);
});

test("an empty document normalizes without error", () => {
	assert.deepEqual(normalizePolicyDocument({}), { chat: {}, speech: {}, image: {} });
});

test("an absent document normalizes to the empty document", () => {
	assert.deepEqual(normalizePolicyDocument(undefined), { chat: {}, speech: {}, image: {} });
});

test("a base URL keeps its port and loses its trailing slash", () => {
	const doc = normalizePolicyDocument({ chat: { ollama: { policy: "local", baseUrl: "http://127.0.0.1:11434///" } } });
	assert.equal(doc.chat.ollama.baseUrl, "http://127.0.0.1:11434");
});

test("a local provider with no base URL is allowed, meaning the provider default", () => {
	const doc = normalizePolicyDocument({ chat: { ollama: { policy: "local" } } });
	assert.equal(doc.chat.ollama.baseUrl, null);
});

// ── Fields that do not apply to the chosen policy are dropped ────────────────

test("a shared-key allowlist is dropped when the policy is not shared", () => {
	const doc = normalizePolicyDocument({ chat: { openai: { policy: "byok", sharedModels: ["gpt-4o"] } } });
	assert.equal(doc.chat.openai.sharedModels, null);
});

test("a call cap is dropped when the policy is not shared", () => {
	const doc = normalizePolicyDocument({ chat: { openai: { policy: "byok", maxCallsPerLobby: 10 } } });
	assert.equal(doc.chat.openai.maxCallsPerLobby, null);
});

test("a base URL is dropped when the policy is not local", () => {
	const doc = normalizePolicyDocument({ chat: { openai: { policy: "shared", baseUrl: "http://127.0.0.1:11434" } } });
	assert.equal(doc.chat.openai.baseUrl, null);
});

test("unknown fields on an entry are dropped", () => {
	const doc = normalizePolicyDocument({ chat: { openai: { policy: "shared", secretBackdoor: "nope" } } });
	assert.deepEqual(Object.keys(doc.chat.openai).sort(), ["baseUrl", "maxCallsPerLobby", "policy", "sharedModels"]);
});

test("an unknown capability in the document is dropped rather than rejected", () => {
	const doc = normalizePolicyDocument({ chat: { openai: "shared" }, divination: { crystal: "shared" } });
	assert.equal(Object.hasOwn(doc, "divination"), false);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("an unrecognised policy value is rejected and names the offending field", () => {
	const err = captureThrow(() => normalizePolicyDocument({ chat: { openai: { policy: "freeforall" } } }));
	assert.ok(err instanceof PolicyError);
	assert.match(err.message, /freeforall/);
	assert.equal(err.field, "chat.openai.policy");
});

test("an empty shared-model allowlist is rejected as an ambiguous way to write off", () => {
	const err = captureThrow(() => normalizePolicyDocument({ chat: { openai: { policy: "shared", sharedModels: [] } } }));
	assert.ok(err instanceof PolicyError);
	assert.equal(err.field, "chat.openai.sharedModels");
});

test("a shared-model allowlist holding a non-string is rejected", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { openai: { policy: "shared", sharedModels: ["gpt-4o", 7] } } }),
		PolicyError,
	);
});

test("a call cap of zero is rejected as an ambiguous way to write off", () => {
	const err = captureThrow(() => normalizePolicyDocument({ chat: { openai: { policy: "shared", maxCallsPerLobby: 0 } } }));
	assert.ok(err instanceof PolicyError);
	assert.equal(err.field, "chat.openai.maxCallsPerLobby");
});

test("a negative call cap is rejected", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { openai: { policy: "shared", maxCallsPerLobby: -5 } } }),
		PolicyError,
	);
});

test("a fractional call cap is rejected", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { openai: { policy: "shared", maxCallsPerLobby: 2.5 } } }),
		PolicyError,
	);
});

test("a call cap given as a string is rejected rather than coerced", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { openai: { policy: "shared", maxCallsPerLobby: "100" } } }),
		PolicyError,
	);
});

test("a non-http base URL is rejected", () => {
	const err = captureThrow(() => normalizePolicyDocument({ chat: { ollama: { policy: "local", baseUrl: "file:///etc/passwd" } } }));
	assert.ok(err instanceof PolicyError);
	assert.equal(err.field, "chat.ollama.baseUrl");
});

test("a base URL carrying a path is rejected", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { ollama: { policy: "local", baseUrl: "http://127.0.0.1:11434/api/chat" } } }),
		PolicyError,
	);
});

test("a base URL carrying embedded credentials is rejected", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { ollama: { policy: "local", baseUrl: "http://user:pass@127.0.0.1:11434" } } }),
		PolicyError,
	);
});

test("an unparseable base URL is rejected", () => {
	assert.throws(
		() => normalizePolicyDocument({ chat: { ollama: { policy: "local", baseUrl: "not a url at all" } } }),
		PolicyError,
	);
});

test("a capability whose value is not an object is rejected", () => {
	assert.throws(() => normalizePolicyDocument({ chat: "shared" }), PolicyError);
});

test("an entry that is neither a string nor an object is rejected", () => {
	assert.throws(() => normalizePolicyDocument({ chat: { openai: 42 } }), PolicyError);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("normalization is idempotent", () => {
	const once = normalizePolicyDocument({
		chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"], maxCallsPerLobby: 25 }, ollama: "local" },
		speech: { elevenlabs: "byok" },
	});
	assert.deepEqual(normalizePolicyDocument(once), once);
});

// ── Store ────────────────────────────────────────────────────────────────────

test("loading when no policy file exists reports that nothing is stored", () => {
	const store = createPolicyStore({ fsImpl: makeFs(), filePath: POLICY_PATH });
	assert.equal(store.load(), null);
});

test("a saved document loads back identically", () => {
	const fsImpl = makeFs();
	const store = createPolicyStore({ fsImpl, filePath: POLICY_PATH });
	const doc = normalizePolicyDocument({ chat: { openai: { policy: "shared", maxCallsPerLobby: 30 } } });

	store.save(doc);
	assert.deepEqual(store.load(), doc);
});

test("saving normalizes what it is given rather than trusting it", () => {
	const fsImpl = makeFs();
	const store = createPolicyStore({ fsImpl, filePath: POLICY_PATH });

	store.save({ chat: { openai: "shared" } });
	assert.deepEqual(store.load().chat.openai, {
		policy: "shared", sharedModels: null, maxCallsPerLobby: null, baseUrl: null,
	});
});

test("saving an invalid document throws and writes nothing", () => {
	const fsImpl = makeFs();
	const store = createPolicyStore({ fsImpl, filePath: POLICY_PATH });

	assert.throws(() => store.save({ chat: { openai: { policy: "nonsense" } } }), PolicyError);
	assert.deepEqual(Object.keys(fsImpl.files), []);
});

test("a corrupt policy file throws rather than silently falling back to defaults", () => {
	const store = createPolicyStore({ fsImpl: makeFs({ [POLICY_PATH]: "{ not json" }), filePath: POLICY_PATH });
	assert.throws(() => store.load(), PolicyError);
});

test("a policy file holding an invalid policy throws on load", () => {
	const fsImpl = makeFs({ [POLICY_PATH]: JSON.stringify({ chat: { openai: { policy: "everyone" } } }) });
	const store = createPolicyStore({ fsImpl, filePath: POLICY_PATH });
	assert.throws(() => store.load(), PolicyError);
});

test("the policy file holds no key material", () => {
	const fsImpl = makeFs();
	const store = createPolicyStore({ fsImpl, filePath: POLICY_PATH });

	store.save({ chat: { openai: { policy: "shared", sharedModels: ["gpt-4o-mini"] } } });
	assert.ok(!/apiKey|sk-|test-token/i.test(fsImpl.files[POLICY_PATH]));
});
