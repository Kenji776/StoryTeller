import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createVerify } from "node:crypto";

import { createCharacterKeys } from "./characterKeys.js";

const KEY_PATH = "/data/charkey.pem";

/**
 * @description Builds an in-memory filesystem double, so no test touches a real disk (`TDD-8`).
 * @param {object} [seed] - Files to start with, keyed by path.
 * @returns {object} An fs-shaped double with its file table exposed.
 */
function makeFs(seed = {}) {
	const files = { ...seed };
	return {
		files,
		existsSync: (p) => Object.hasOwn(files, p),
		readFileSync: (p) => {
			if (!Object.hasOwn(files, p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[p];
		},
		writeFileSync: (p, data) => { files[p] = data; },
	};
}

/** A real RSA pair, generated once — keygen is slow and these tests only need two distinct pairs. */
const PAIR_A = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PAIR_B = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/**
 * @description A key generator handing out prepared pairs in order, so a test can say which key
 *   comes next instead of depending on randomness.
 * @param {Array<object>} pairs - Pairs to return, one per call.
 * @returns {Function} A `generateKeyPairSync`-shaped function.
 */
function generatorOf(pairs) {
	let next = 0;
	return () => pairs[Math.min(next++, pairs.length - 1)];
}

/**
 * @description Signs text the way `/api/character/export` does.
 * @param {string} privateKey - PEM private key.
 * @param {string} data - The payload.
 * @returns {string} A base64 signature.
 */
function sign(privateKey, data) {
	const signer = createSign("SHA256");
	signer.update(data);
	signer.end();
	return signer.sign(privateKey, "base64");
}

/**
 * @description Verifies the way `/api/character/import` and host-verify do.
 * @param {string} publicKey - PEM public key.
 * @param {string} data - The payload.
 * @param {string} signature - A base64 signature.
 * @returns {boolean} Whether it checks out.
 */
function verify(publicKey, data, signature) {
	const verifier = createVerify("SHA256");
	verifier.update(data);
	verifier.end();
	return verifier.verify(publicKey, signature, "base64");
}

// ── First run ────────────────────────────────────────────────────────────────

test("a fresh install generates a key and writes it, with no help from anyone", () => {
	// This is what makes the feature invisible to a normal user: no setup step, no prompt.
	const fsImpl = makeFs();
	const logged = [];
	const keys = createCharacterKeys({
		fsImpl, keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_A]), log: (m) => logged.push(m),
	});

	assert.equal(fsImpl.files[KEY_PATH], PAIR_A.privateKey, "the key is persisted, or the next boot makes another");
	assert.equal(keys.privateKey(), PAIR_A.privateKey);
	assert.ok(keys.publicKey().includes("BEGIN PUBLIC KEY"));
	assert.ok(logged.some((m) => /generat/i.test(m)), "generating a key is worth a log line");
});

test("an existing key is loaded and never overwritten", () => {
	// Overwriting on boot would silently invalidate every character anyone had exported.
	const fsImpl = makeFs({ [KEY_PATH]: PAIR_A.privateKey });
	const keys = createCharacterKeys({
		fsImpl, keyPath: KEY_PATH, generateKeyPair: () => { throw new Error("must not generate"); },
	});

	assert.equal(keys.privateKey(), PAIR_A.privateKey);
	assert.equal(fsImpl.files[KEY_PATH], PAIR_A.privateKey, "untouched");
});

test("the public key is derived from the private one, not stored separately", () => {
	const keys = createCharacterKeys({ fsImpl: makeFs({ [KEY_PATH]: PAIR_A.privateKey }), keyPath: KEY_PATH });
	assert.ok(verify(keys.publicKey(), "hello", sign(PAIR_A.privateKey, "hello")));
});

test("a key file that cannot be parsed stops the boot rather than quietly making a new one", () => {
	// Silently generating here is the dangerous path: every exported character would stop
	// verifying and the only clue would be a log line nobody read.
	const fsImpl = makeFs({ [KEY_PATH]: "-----BEGIN PRIVATE KEY-----\nnonsense\n-----END PRIVATE KEY-----" });

	assert.throws(
		() => createCharacterKeys({ fsImpl, keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_A]) }),
		/character signing key/i,
	);
	assert.equal(fsImpl.files[KEY_PATH], "-----BEGIN PRIVATE KEY-----\nnonsense\n-----END PRIVATE KEY-----",
		"and the unreadable file is left exactly as found, so it can be recovered by hand");
});

// ── Rotation ─────────────────────────────────────────────────────────────────

test("rotating replaces the key on disk and in memory", () => {
	const fsImpl = makeFs({ [KEY_PATH]: PAIR_A.privateKey });
	const keys = createCharacterKeys({ fsImpl, keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_B]) });

	keys.rotate();

	assert.equal(keys.privateKey(), PAIR_B.privateKey);
	assert.equal(fsImpl.files[KEY_PATH], PAIR_B.privateKey, "persisted, or a restart undoes the rotation");
});

test("a character exported before rotation no longer verifies", () => {
	// The consequence, stated as a test so nobody has to take the warning text on trust.
	const keys = createCharacterKeys({
		fsImpl: makeFs({ [KEY_PATH]: PAIR_A.privateKey }), keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_B]),
	});
	const exported = sign(keys.privateKey(), "character-payload");

	assert.ok(verify(keys.publicKey(), "character-payload", exported), "it verified before");
	keys.rotate();
	assert.equal(verify(keys.publicKey(), "character-payload", exported), false, "and not after");
});

test("a character exported after rotation verifies, so re-exporting is the fix", () => {
	// The other half: the damage is recoverable, which is what makes rotation a reasonable
	// thing to offer rather than a one-way door.
	const keys = createCharacterKeys({
		fsImpl: makeFs({ [KEY_PATH]: PAIR_A.privateKey }), keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_B]),
	});
	keys.rotate();

	assert.ok(verify(keys.publicKey(), "character-payload", sign(keys.privateKey(), "character-payload")));
});

test("rotation reports the fingerprints, so an operator can tell it actually happened", () => {
	const keys = createCharacterKeys({
		fsImpl: makeFs({ [KEY_PATH]: PAIR_A.privateKey }), keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_B]),
	});

	const before = keys.fingerprint();
	const result = keys.rotate();

	assert.equal(result.previous, before);
	assert.equal(result.current, keys.fingerprint());
	assert.notEqual(result.previous, result.current);
});

test("a fingerprint identifies the key without revealing it", () => {
	const keys = createCharacterKeys({ fsImpl: makeFs({ [KEY_PATH]: PAIR_A.privateKey }), keyPath: KEY_PATH });
	const print = keys.fingerprint();

	assert.match(print, /^[a-f0-9]{16}$/, "short hex, safe to show in a UI and in a log");
	assert.ok(!PAIR_A.privateKey.includes(print), "and not a substring of the key material");
});

test("rotating twice keeps working, and each rotation is a new key", () => {
	const fsImpl = makeFs({ [KEY_PATH]: PAIR_A.privateKey });
	const third = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const keys = createCharacterKeys({ fsImpl, keyPath: KEY_PATH, generateKeyPair: generatorOf([PAIR_B, third]) });

	const first = keys.rotate();
	const second = keys.rotate();

	assert.equal(first.current, second.previous);
	assert.notEqual(second.previous, second.current);
	assert.equal(fsImpl.files[KEY_PATH], third.privateKey);
});
