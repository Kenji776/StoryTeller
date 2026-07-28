/**
 * SHA-256, for the browsers that will not give us one.
 *
 * `crypto.subtle` exists only in a **secure context** — HTTPS, or localhost. This
 * app is routinely served over plain HTTP on a LAN address, where
 * `crypto.subtle` is `undefined` and the admin login died on
 * "cannot read properties of undefined (reading 'digest')".
 *
 * **This is not a downgrade in security.** The login is a challenge-response over
 * the same plain HTTP either way: whoever can read `crypto.subtle`'s output off
 * the wire can read this one. The transport is the weak link, and the answer to
 * that is TLS — a deployment concern ADR 0001 already records as a requirement.
 * All this does is stop a browser API's availability deciding whether an operator
 * can log in at all.
 *
 * Correctness is not taken on trust: the tests check it against Node's own
 * `createHash("sha256")` across block boundaries and multi-byte input, because
 * agreeing with the server is the entire job.
 */

/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash values: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * @description Rotates a 32-bit word right.
 * @param {number} value - The word.
 * @param {number} bits - How far to rotate.
 * @returns {number} The rotated word.
 */
function rotr(value, bits) {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * @description Encodes text as UTF-8 bytes. `TextEncoder` is available wherever
 *   this runs, including the insecure contexts `crypto.subtle` abandons.
 * @param {string} text - The input.
 * @returns {Uint8Array} The bytes.
 */
function utf8Bytes(text) {
	return new TextEncoder().encode(text);
}

/**
 * Hashes text with SHA-256.
 *
 * @description Produces the same lowercase hex digest as
 *   `crypto.subtle.digest("SHA-256", …)` and as Node's
 *   `createHash("sha256").digest("hex")`, which is what the server compares
 *   against.
 * @param {string} text - The input, hashed as UTF-8.
 * @returns {string} A 64-character lowercase hex digest.
 * @throws {TypeError} When the input is not a string. Hashing a coerced value
 *   would silently produce a digest for something the caller never meant.
 */
export function sha256Hex(text) {
	if (typeof text !== "string") {
		throw new TypeError(`sha256Hex expects a string, received ${text === null ? "null" : typeof text}.`);
	}

	const bytes = utf8Bytes(text);
	const bitLength = bytes.length * 8;

	// Padding: a 1 bit, then zeroes, then the 64-bit big-endian length. The block
	// count is what makes the 55/56-byte boundary cases in the tests worth having.
	const withPadding = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
	withPadding.set(bytes);
	withPadding[bytes.length] = 0x80;

	const view = new DataView(withPadding.buffer);
	// JavaScript numbers hold the high word exactly for any input this will ever
	// see, and the low word is written separately to avoid BigInt.
	view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000), false);
	view.setUint32(withPadding.length - 4, bitLength >>> 0, false);

	const hash = H0.slice();
	const w = new Uint32Array(64);

	for (let offset = 0; offset < withPadding.length; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
		for (let i = 16; i < 64; i += 1) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let [a, b, c, d, e, f, g, h] = hash;

		for (let i = 0; i < 64; i += 1) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;

			h = g; g = f; f = e;
			e = (d + temp1) >>> 0;
			d = c; c = b; b = a;
			a = (temp1 + temp2) >>> 0;
		}

		hash[0] = (hash[0] + a) >>> 0;
		hash[1] = (hash[1] + b) >>> 0;
		hash[2] = (hash[2] + c) >>> 0;
		hash[3] = (hash[3] + d) >>> 0;
		hash[4] = (hash[4] + e) >>> 0;
		hash[5] = (hash[5] + f) >>> 0;
		hash[6] = (hash[6] + g) >>> 0;
		hash[7] = (hash[7] + h) >>> 0;
	}

	return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}
