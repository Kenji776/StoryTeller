import { test } from "node:test";
import assert from "node:assert/strict";

import { createVault, VaultLockedError } from "./vault.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const FAKE_KEY = "test-token-DO-NOT-USE-openai";
const OTHER_KEY = "test-token-DO-NOT-USE-anthropic";
const SECRET = "test-vault-secret-DO-NOT-USE";
const VAULT_PATH = "/data/credentials.enc";

/**
 * Builds an in-memory stand-in for the filesystem calls the vault makes.
 *
 * @description Matches the double used by `services/tts/localConfig.test.js`, so
 *   the unit tier never touches a real disk (`TDD-8`).
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

/** A frozen clock, so stored timestamps are asserted exactly (`TDD-8`). */
const FROZEN = "2026-07-27T12:00:00.000Z";
const now = () => new Date(FROZEN);

/**
 * Builds a vault over a fake filesystem with sensible test defaults.
 *
 * @param {object} [options] - Overrides.
 * @param {object} [options.fsImpl] - The filesystem double to use.
 * @param {string|null} [options.secret] - The encryption secret.
 * @returns {object} The vault under test.
 */
function vaultOver({ fsImpl = makeFs(), secret = SECRET } = {}) {
	return createVault({ fsImpl, filePath: VAULT_PATH, secret, now, log: () => {} });
}

// ── Happy path ───────────────────────────────────────────────────────────────

test("a stored key is readable back out of the vault", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);
	assert.equal(vault.read("openai"), FAKE_KEY);
});

test("a key survives a round trip through a second vault over the same file", () => {
	const fsImpl = makeFs();
	vaultOver({ fsImpl }).set("openai", FAKE_KEY);

	const reopened = vaultOver({ fsImpl });
	assert.equal(reopened.read("openai"), FAKE_KEY);
});

test("several providers are held independently", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);
	vault.set("anthropic", OTHER_KEY);

	assert.equal(vault.read("openai"), FAKE_KEY);
	assert.equal(vault.read("anthropic"), OTHER_KEY);
});

test("describe reports a configured provider with the date it was added", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);

	assert.deepEqual(vault.describe().openai, {
		configured: true,
		last4: FAKE_KEY.slice(-4),
		addedAt: FROZEN,
		status: "unknown",
		lastValidated: null,
	});
});

test("recordValidation stores the outcome of a live key check", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);
	vault.recordValidation("openai", { ok: false, error: "401 Unauthorized" });

	const described = vault.describe().openai;
	assert.equal(described.status, "rejected");
	assert.equal(described.lastValidated, FROZEN);
});

test("clear removes a key and reports that one was present", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);

	assert.equal(vault.clear("openai"), true);
	assert.equal(vault.read("openai"), null);
	assert.equal(vault.has("openai"), false);
});

// ── Boundary ─────────────────────────────────────────────────────────────────

test("reading a provider that was never configured returns null", () => {
	assert.equal(vaultOver().read("openai"), null);
});

test("describe on an empty vault is an empty object", () => {
	assert.deepEqual(vaultOver().describe(), {});
});

test("clearing a provider that was never configured reports nothing was removed", () => {
	assert.equal(vaultOver().clear("openai"), false);
});

test("a key of nine characters reveals its last four", () => {
	const vault = vaultOver();
	vault.set("openai", "123456789");
	assert.equal(vault.describe().openai.last4, "6789");
});

test("a key of eight characters is masked entirely", () => {
	const vault = vaultOver();
	vault.set("openai", "12345678");
	assert.equal(vault.describe().openai.last4, null);
});

test("a missing vault file opens as an empty, writable vault", () => {
	const vault = vaultOver({ fsImpl: makeFs() });
	assert.equal(vault.persistent, true);
	assert.deepEqual(vault.describe(), {});
});

test("re-setting a provider replaces the key rather than adding a second", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);
	vault.set("openai", OTHER_KEY);

	assert.equal(vault.read("openai"), OTHER_KEY);
	assert.equal(Object.keys(vault.describe()).length, 1);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("set rejects a blank key", () => {
	assert.throws(() => vaultOver().set("openai", "   "), /key/i);
});

test("set rejects a non-string key", () => {
	assert.throws(() => vaultOver().set("openai", 12345), /string/i);
});

test("set rejects a blank provider id", () => {
	assert.throws(() => vaultOver().set("", FAKE_KEY), /provider/i);
});

test("set rejects a non-string provider id", () => {
	assert.throws(() => vaultOver().set(null, FAKE_KEY), /provider/i);
});

// ── Error paths ──────────────────────────────────────────────────────────────

test("opening an existing vault with the wrong secret raises VaultLockedError", () => {
	const fsImpl = makeFs();
	vaultOver({ fsImpl }).set("openai", FAKE_KEY);

	assert.throws(
		() => createVault({ fsImpl, filePath: VAULT_PATH, secret: "wrong-secret-DO-NOT-USE", now, log: () => {} }),
		VaultLockedError,
	);
});

test("opening an existing vault with no secret at all raises VaultLockedError", () => {
	const fsImpl = makeFs();
	vaultOver({ fsImpl }).set("openai", FAKE_KEY);

	assert.throws(
		() => createVault({ fsImpl, filePath: VAULT_PATH, secret: null, now, log: () => {} }),
		VaultLockedError,
	);
});

test("a corrupt vault file raises VaultLockedError rather than opening empty", () => {
	const fsImpl = makeFs({ [VAULT_PATH]: "this is not an envelope" });
	assert.throws(() => vaultOver({ fsImpl }), VaultLockedError);
});

test("a tampered ciphertext raises VaultLockedError", () => {
	const fsImpl = makeFs();
	vaultOver({ fsImpl }).set("openai", FAKE_KEY);

	const envelope = JSON.parse(fsImpl.files[VAULT_PATH]);
	const bytes = Buffer.from(envelope.data, "base64");
	bytes[0] ^= 0xff;
	envelope.data = bytes.toString("base64");
	fsImpl.files[VAULT_PATH] = JSON.stringify(envelope);

	assert.throws(() => vaultOver({ fsImpl }), VaultLockedError);
});

test("a locked vault never overwrites the file it could not read", () => {
	const fsImpl = makeFs();
	vaultOver({ fsImpl }).set("openai", FAKE_KEY);
	const original = fsImpl.files[VAULT_PATH];

	assert.throws(() => vaultOver({ fsImpl, secret: "wrong-secret-DO-NOT-USE" }), VaultLockedError);
	assert.equal(fsImpl.files[VAULT_PATH], original);
});

// ── Security properties ──────────────────────────────────────────────────────

test("the key never appears in the bytes written to disk", () => {
	const fsImpl = makeFs();
	vaultOver({ fsImpl }).set("openai", FAKE_KEY);

	const written = fsImpl.files[VAULT_PATH];
	assert.ok(written, "expected the vault to have written a file");
	assert.ok(!written.includes(FAKE_KEY), "the plaintext key was found in the vault file");
	assert.ok(
		!Buffer.from(written).toString("latin1").includes(FAKE_KEY),
		"the plaintext key was found in the raw vault bytes",
	);
});

test("describe never carries the key in any of its values", () => {
	const vault = vaultOver();
	vault.set("openai", FAKE_KEY);

	assert.ok(!JSON.stringify(vault.describe()).includes(FAKE_KEY));
});

test("the same key written twice produces different ciphertext", () => {
	const first = makeFs();
	const second = makeFs();
	vaultOver({ fsImpl: first }).set("openai", FAKE_KEY);
	vaultOver({ fsImpl: second }).set("openai", FAKE_KEY);

	assert.notEqual(
		JSON.parse(first.files[VAULT_PATH]).data,
		JSON.parse(second.files[VAULT_PATH]).data,
		"identical plaintext produced identical ciphertext — the IV or salt is being reused",
	);
});

// ── No-secret mode ───────────────────────────────────────────────────────────

test("without a secret the vault holds keys in memory but writes nothing", () => {
	const fsImpl = makeFs();
	const vault = createVault({ fsImpl, filePath: VAULT_PATH, secret: null, now, log: () => {} });

	vault.set("openai", FAKE_KEY);

	assert.equal(vault.persistent, false);
	assert.equal(vault.read("openai"), FAKE_KEY);
	assert.deepEqual(Object.keys(fsImpl.files), [], "a vault with no secret must not write plaintext to disk");
});
