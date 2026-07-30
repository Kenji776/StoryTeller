/**
 * The RSA key that signs exported character files.
 *
 * Small, but load-bearing in a way that is easy to miss: a `.stchar` file is a character sheet plus
 * a signature over it, and that signature is what lets `/api/character/import` refuse a tampered
 * sheet — and what authenticates a host into the DM tools (`routes/adminAuth.js`), since holding a
 * validly-signed file for the lobby's recorded host character *is* the credential.
 *
 * Extracted from `server.js`, where it was fifteen lines of boot-time side effect with the key in a
 * module-level `let`. Two reasons it had to move: it could not be tested at all, and rotating the key
 * needs every verifier to see the new one rather than a copy captured at startup.
 *
 * Nothing here reads the disk or generates a key by itself — both are injected, so the tests run
 * without either (`CQ-5`, `TDD-8`).
 */

import { createPublicKey, createHash } from "node:crypto";

/** How the pair is generated when one is needed. Matches `generateKeyPairSync`'s option shape. */
const KEY_OPTIONS = Object.freeze({
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/**
 * @description Derives a short, stable identifier for a key. Shown in the admin panel and in logs so
 *   an operator can confirm a rotation actually took effect; taken from the *public* half and
 *   truncated, so it identifies the key without being usable as key material.
 * @param {string} publicKeyPem - The PEM public key.
 * @returns {string} Sixteen hex characters.
 */
function fingerprintOf(publicKeyPem) {
	return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

/**
 * Loads, or creates, the character signing key.
 *
 * @description Reads the key from disk when it exists and generates one when it does not, which is
 *   why a fresh clone and a fresh container both just work with no setup step. Users never see this.
 * @param {object} options - Collaborators.
 * @param {object} options.fsImpl - Node's `fs`, or a double. Needs `existsSync`, `readFileSync`,
 *   `writeFileSync`.
 * @param {string} options.keyPath - Where the private key lives.
 * @param {Function} [options.generateKeyPair] - `generateKeyPairSync`-shaped generator.
 * @param {Function} [options.log] - Logger.
 * @returns {{privateKey: Function, publicKey: Function, fingerprint: Function, rotate: Function}}
 *   Accessors rather than values — see `rotate`.
 * @throws {Error} When a key file exists but cannot be parsed. Deliberately fatal: generating a
 *   replacement would invalidate every character anyone had exported, and the only trace would be a
 *   log line. A corrupt key is something an operator must see and decide about.
 */
export function createCharacterKeys({ fsImpl, keyPath, generateKeyPair, log = () => {} }) {
	let privateKeyPem = null;
	let publicKeyPem = null;

	/**
	 * @description Derives and caches the public half, failing loudly on unusable key material.
	 * @param {string} pem - The private key.
	 * @returns {void}
	 * @throws {Error} When the key cannot be parsed.
	 */
	const adopt = (pem) => {
		try {
			publicKeyPem = createPublicKey(pem).export({ type: "spki", format: "pem" });
		} catch (err) {
			throw new Error(
				`The character signing key at ${keyPath} could not be read: ${err.message}. `
				+ "Move it aside to have a new one generated — but every character exported with the "
				+ "old key will stop importing, and any host holding one will have to export again.",
			);
		}
		privateKeyPem = pem;
	};

	if (fsImpl.existsSync(keyPath)) {
		adopt(fsImpl.readFileSync(keyPath, "utf8"));
	} else {
		const pair = generateKeyPair("rsa", KEY_OPTIONS);
		adopt(pair.privateKey);
		fsImpl.writeFileSync(keyPath, pair.privateKey, "utf8");
		log(`🔑 Generated a character signing key (${fingerprintOf(publicKeyPem)})`);
	}

	return {
		/**
		 * @description The key that signs an export.
		 * @returns {string} PEM private key.
		 */
		privateKey: () => privateKeyPem,

		/**
		 * The key that verifies one.
		 *
		 * @description A function, not a value, and that is the whole point of this module. `server.js`
		 *   used to pass the public key *by value* into `registerAdminAuth`, so a rotation would leave
		 *   host-verify checking against a copy from startup — accepting files signed with the retired
		 *   key and rejecting freshly exported ones, which is precisely backwards.
		 * @returns {string} PEM public key.
		 */
		publicKey: () => publicKeyPem,

		/**
		 * @description Identifies the current key without exposing it.
		 * @returns {string} Sixteen hex characters.
		 */
		fingerprint: () => fingerprintOf(publicKeyPem),

		/**
		 * Replaces the key.
		 *
		 * @description Offered to operators because a key that has leaked has to be replaceable, and
		 *   this one ships inside a Docker image if anyone is careless with `.dockerignore`.
		 *
		 *   What it costs, precisely: every already-exported `.stchar` stops importing, and a host
		 *   whose file was exported with the old key cannot open the DM tools until they export again.
		 *   What it does *not* cost: anything in a running game. Characters live in lobby JSON with no
		 *   signature anywhere near them, so no campaign, sheet, inventory or progress is touched.
		 * @returns {{previous: string, current: string}} Fingerprints either side of the change, so a
		 *   caller can report what happened without handling key material.
		 */
		rotate() {
			const previous = fingerprintOf(publicKeyPem);
			const pair = generateKeyPair("rsa", KEY_OPTIONS);
			adopt(pair.privateKey);
			fsImpl.writeFileSync(keyPath, pair.privateKey, "utf8");
			const current = fingerprintOf(publicKeyPem);
			log(`🔑 Character signing key rotated (${previous} → ${current}). Existing exports no longer verify.`);
			return { previous, current };
		},
	};
}
