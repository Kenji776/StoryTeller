import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { sha256Hex } from "./sha256.js";

/**
 * @description The answer Node's own SHA-256 gives, which is the thing this must
 *   agree with — the server hashes with `createHash("sha256")` and compares.
 * @param {string} text - The input.
 * @returns {string} Lowercase hex digest.
 */
const reference = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ── Known answers ────────────────────────────────────────────────────────────

test("the empty string hashes to the published SHA-256 of nothing", () => {
	assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("abc hashes to its published digest", () => {
	assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// ── Agreement with the server, which is the only thing that matters ─────────

test("it agrees with Node's SHA-256 across a spread of inputs", () => {
	const inputs = [
		"",
		"a",
		"password",
		"test-DO-NOT-USE",
		"correct horse battery staple",
		// The real shape: password concatenated with a 32-byte hex nonce.
		`hunter2${"a1b2c3d4".repeat(8)}`,
		"x".repeat(55),   // one byte under a block boundary
		"x".repeat(56),   // the length that forces a second padding block
		"x".repeat(64),   // exactly one block
		"x".repeat(1000),
	];

	for (const input of inputs) {
		assert.equal(sha256Hex(input), reference(input), `mismatch for input of length ${input.length}`);
	}
});

test("it agrees with Node on multi-byte characters", () => {
	// A password may hold anything a keyboard produces. Hashing the UTF-8 bytes
	// rather than the code units is what keeps this in step with the server.
	for (const input of ["café", "日本語", "emoji 🐉 here", "ünïcödé pässwörd"]) {
		assert.equal(sha256Hex(input), reference(input), `mismatch for "${input}"`);
	}
});

test("a long input spanning many blocks still agrees", () => {
	const input = "The quick brown fox jumps over the lazy dog. ".repeat(200);
	assert.equal(sha256Hex(input), reference(input));
});

// ── Shape ────────────────────────────────────────────────────────────────────

test("the digest is 64 lowercase hex characters", () => {
	const digest = sha256Hex("anything");
	assert.equal(digest.length, 64);
	assert.match(digest, /^[0-9a-f]{64}$/);
});

test("a one-character change produces a completely different digest", () => {
	const a = sha256Hex("password1");
	const b = sha256Hex("password2");
	assert.notEqual(a, b);
	// Not a real avalanche test, but it would catch a truncating or seeding bug.
	assert.ok([...a].filter((c, i) => c !== b[i]).length > 40);
});

test("a non-string input is refused rather than silently hashing something else", () => {
	for (const value of [null, undefined, 42, {}, []]) {
		assert.throws(() => sha256Hex(value), /string/i);
	}
});
