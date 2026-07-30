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
	const dirs = [];
	return {
		files,
		dirs,
		mkdirSync: (p) => { dirs.push(String(p).split("\\").join("/")); },
		unlinkSync: (p) => { delete files[p]; },
		statSync: () => ({ mode: 0o700 }),
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

// ── Moving into the secrets folder ───────────────────────────────────────────

const LEGACY_PATH = "/data/charkey.pem";
const SECRET_PATH = "/data/credentials/charkey.pem";

/**
 * @description Builds the key system at its new home, with the old one as the migration source.
 * @param {object} fsImpl - The filesystem double.
 * @param {object} [options] - `generateKeyPair` and `log` overrides.
 * @returns {object} The key system.
 */
function atNewHome(fsImpl, { generateKeyPair = generatorOf([PAIR_B]), log = () => {} } = {}) {
	return createCharacterKeys({ fsImpl, keyPath: SECRET_PATH, legacyKeyPath: LEGACY_PATH, generateKeyPair, log });
}

test("a key already in the secrets folder is used, and no migration happens", () => {
	const fsImpl = makeFs({ [SECRET_PATH]: PAIR_A.privateKey });
	const keys = atNewHome(fsImpl, { generateKeyPair: () => { throw new Error("must not generate"); } });

	assert.equal(keys.privateKey(), PAIR_A.privateKey);
	assert.equal(Object.hasOwn(fsImpl.files, LEGACY_PATH), false, "nothing was written to the old path");
});

test("a key at the old path is moved, not regenerated", () => {
	// The whole point of the fallback. An install upgrading to this layout must keep its key, or every
	// character its players exported silently stops importing.
	const fsImpl = makeFs({ [LEGACY_PATH]: PAIR_A.privateKey });
	const logged = [];
	const keys = atNewHome(fsImpl, {
		generateKeyPair: () => { throw new Error("must not generate — the old key was right there"); },
		log: (m) => logged.push(m),
	});

	assert.equal(keys.privateKey(), PAIR_A.privateKey, "same key, so exports keep verifying");
	assert.equal(fsImpl.files[SECRET_PATH], PAIR_A.privateKey, "now at the new path");
	assert.equal(Object.hasOwn(fsImpl.files, LEGACY_PATH), false, "and gone from the old one");
	assert.ok(logged.some((m) => /moved|migrat/i.test(m)), "a move worth knowing about is worth a log line");
});

test("an unreadable key at the old path is left where it is", () => {
	// Deleting it would destroy the only copy of something an operator might yet recover by hand.
	const fsImpl = makeFs({ [LEGACY_PATH]: "-----BEGIN PRIVATE KEY-----\nnonsense\n-----END PRIVATE KEY-----" });

	assert.throws(() => atNewHome(fsImpl), /character signing key/i);
	assert.ok(Object.hasOwn(fsImpl.files, LEGACY_PATH), "still there to be rescued");
	assert.equal(Object.hasOwn(fsImpl.files, SECRET_PATH), false, "and nothing half-written at the new path");
});

test("with keys at both paths the secrets folder wins, and the stray is reported", () => {
	const fsImpl = makeFs({ [SECRET_PATH]: PAIR_A.privateKey, [LEGACY_PATH]: PAIR_B.privateKey });
	const logged = [];
	const keys = atNewHome(fsImpl, { log: (m) => logged.push(m) });

	assert.equal(keys.privateKey(), PAIR_A.privateKey);
	assert.ok(Object.hasOwn(fsImpl.files, LEGACY_PATH), "left alone rather than deleted unasked");
	assert.ok(logged.some((m) => /old|stray|leftover/i.test(m)), "but said out loud — a spare private key is a liability");
});

test("a first run creates the secrets folder and puts the key only there", () => {
	const fsImpl = makeFs();
	const keys = atNewHome(fsImpl);

	assert.equal(fsImpl.files[SECRET_PATH], PAIR_B.privateKey);
	assert.equal(Object.hasOwn(fsImpl.files, LEGACY_PATH), false);
	assert.ok(fsImpl.dirs.includes("/data/credentials"), "the folder is created rather than assumed");
	assert.ok(keys.publicKey().includes("BEGIN PUBLIC KEY"));
});

test("rotation writes to the new path, never back to the old one", () => {
	const fsImpl = makeFs({ [LEGACY_PATH]: PAIR_A.privateKey });
	const third = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const keys = atNewHome(fsImpl, { generateKeyPair: generatorOf([third]) });

	keys.rotate();

	assert.equal(fsImpl.files[SECRET_PATH], third.privateKey);
	assert.equal(Object.hasOwn(fsImpl.files, LEGACY_PATH), false);
});

test("omitting the legacy path is fine, so a caller need not know this history", () => {
	const fsImpl = makeFs();
	const keys = createCharacterKeys({ fsImpl, keyPath: SECRET_PATH, generateKeyPair: generatorOf([PAIR_B]) });
	assert.equal(keys.privateKey(), PAIR_B.privateKey);
});

// ── Telling an operator their folder is readable by everyone ──────────────────

/**
 * @description Builds a filesystem double reporting a chosen directory mode.
 * @param {number} mode - The POSIX mode bits to report.
 * @returns {object} An fs double whose `statSync` reports that mode.
 */
function fsWithMode(mode) {
	const fsImpl = makeFs({ [SECRET_PATH]: PAIR_A.privateKey });
	fsImpl.statSync = () => ({ mode });
	return fsImpl;
}

test("a folder only its owner can reach reports as fine", () => {
	const keys = createCharacterKeys({ fsImpl: fsWithMode(0o40700), keyPath: SECRET_PATH });
	const check = keys.checkPermissions({ platform: "linux" });

	assert.equal(check.secure, true);
	assert.equal(check.advice, "");
});

test("a world-readable folder is reported with the exact command to fix it", () => {
	// The complaint has to carry the fix. "Secure your keys" is what every project says and is why
	// nobody does it — an operator who does not know the command will not go looking for it.
	const keys = createCharacterKeys({ fsImpl: fsWithMode(0o40755), keyPath: SECRET_PATH });
	const check = keys.checkPermissions({ platform: "linux" });

	assert.equal(check.secure, false);
	assert.match(check.advice, /chmod 700/);
	assert.match(check.advice, /credentials/, "and names the folder, not just the concept");
});

test("group-readable counts as readable — the group is not always just you", () => {
	assert.equal(createCharacterKeys({ fsImpl: fsWithMode(0o40740), keyPath: SECRET_PATH })
		.checkPermissions({ platform: "linux" }).secure, false);
});

test("nothing is claimed on Windows, where those bits mean nothing", () => {
	// `statSync().mode` returns a synthesised value there, so judging it would produce a confident
	// warning about a permission model that is not in use.
	const check = createCharacterKeys({ fsImpl: fsWithMode(0o40777), keyPath: SECRET_PATH })
		.checkPermissions({ platform: "win32" });

	assert.equal(check.checked, false);
	assert.equal(check.secure, null, "not false — unknown is not insecure");
	assert.match(check.advice, /icacls|Windows/i, "but still points somewhere useful");
});

test("a filesystem that cannot be asked reports unknown rather than throwing", () => {
	// Boot must not fail over a permission check. This is a toy: an install that refuses to start
	// because it could not stat a directory is an install nobody plays.
	const fsImpl = fsWithMode(0o40700);
	fsImpl.statSync = () => { throw new Error("EPERM"); };
	const check = createCharacterKeys({ fsImpl, keyPath: SECRET_PATH }).checkPermissions({ platform: "linux" });

	assert.equal(check.checked, false);
	assert.equal(check.secure, null);
});

test("the check describes the folder, not the key file, because the folder is what is chmodded", () => {
	const keys = createCharacterKeys({ fsImpl: fsWithMode(0o40755), keyPath: SECRET_PATH });
	assert.equal(keys.checkPermissions({ platform: "linux" }).path, "/data/credentials");
});
