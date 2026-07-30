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
 * @param {string} [options.legacyKeyPath] - Where it used to live. When a key is found there and not
 *   at `keyPath`, it is *moved* rather than replaced. An install upgrading to the secrets folder has
 *   to keep its key: generating a new one would silently stop every character its players had
 *   exported from importing, which is the one outcome this module exists to avoid.
 * @param {Function} [options.generateKeyPair] - `generateKeyPairSync`-shaped generator.
 * @param {Function} [options.log] - Logger.
 * @returns {{privateKey: Function, publicKey: Function, fingerprint: Function, rotate: Function}}
 *   Accessors rather than values — see `rotate`.
 * @throws {Error} When a key file exists but cannot be parsed. Deliberately fatal: generating a
 *   replacement would invalidate every character anyone had exported, and the only trace would be a
 *   log line. A corrupt key is something an operator must see and decide about.
 */
export function createCharacterKeys({ fsImpl, keyPath, legacyKeyPath = null, generateKeyPair, log = () => {} }) {
	let privateKeyPem = null;
	let publicKeyPem = null;

	/**
	 * @description Makes sure the directory holding the key exists before writing into it. Derived
	 *   from the path rather than passed in, so a caller cannot supply one that disagrees.
	 * @returns {void}
	 */
	const ensureDirectory = () => {
		const directory = keyPath.replace(/[\\/][^\\/]*$/, "");
		if (directory && directory !== keyPath) fsImpl.mkdirSync(directory, { recursive: true });
	};

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
		// A key at the old path as well means a half-finished move, or a copy somebody made. Not
		// deleted unasked — it may be the only copy of something worth keeping — but a spare private
		// key lying outside the protected folder is worth saying out loud.
		if (legacyKeyPath && fsImpl.existsSync(legacyKeyPath)) {
			log(`⚠️  An old character signing key is still at ${legacyKeyPath}. The one in use is `
				+ `${keyPath}; delete the leftover once you are sure you do not need it.`);
		}
	} else if (legacyKeyPath && fsImpl.existsSync(legacyKeyPath)) {
		// Adopted *before* anything is written or removed, so a key that turns out to be unreadable
		// throws while the original is still sitting where the operator can rescue it.
		adopt(fsImpl.readFileSync(legacyKeyPath, "utf8"));
		ensureDirectory();
		fsImpl.writeFileSync(keyPath, privateKeyPem, "utf8");
		fsImpl.unlinkSync(legacyKeyPath);
		log(`🔑 Moved the character signing key into ${keyPath} (${fingerprintOf(publicKeyPem)}). `
			+ "Same key, so every exported character still imports.");
	} else {
		const pair = generateKeyPair("rsa", KEY_OPTIONS);
		adopt(pair.privateKey);
		ensureDirectory();
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
		 * Reports whether anyone besides the owner can read the folder holding the key.
		 *
		 * @description Advisory only, and deliberately so. This is a game: an install that refuses to
		 *   start because a directory was group-readable is an install nobody plays, and a security
		 *   measure people work around by disabling it has achieved nothing. So it observes and says
		 *   so, and never throws — a filesystem that cannot be asked reports "unknown", not "insecure".
		 *
		 *   The advice carries the actual command. "Secure your keys" is what every project says, and
		 *   is why nobody does it; an operator who does not already know `chmod` will not go and find
		 *   out.
		 *
		 *   Nothing is claimed on Windows. `statSync().mode` there is a synthesised value that does not
		 *   describe the ACLs actually in force, so judging it would produce a confident warning about
		 *   a permission model the machine is not using.
		 * @param {object} [options] - Overrides.
		 * @param {string} [options.platform] - `process.platform`; injected so both branches are testable.
		 * @returns {{checked: boolean, secure: boolean|null, mode: string|null, path: string,
		 *   advice: string}} What was found. `secure: null` means it could not be determined.
		 */
		checkPermissions({ platform = process.platform } = {}) {
			const directory = keyPath.replace(/[\\/][^\\/]*$/, "") || keyPath;

			if (platform === "win32") {
				return {
					checked: false,
					secure: null,
					mode: null,
					path: directory,
					advice: `On Windows, restrict ${directory} with icacls — grant only the account running the `
						+ "server and your administrators, and remove inherited access for Users. File mode bits "
						+ "are not consulted here because they do not describe what Windows actually enforces.",
				};
			}

			let mode;
			try {
				mode = fsImpl.statSync(directory).mode;
			} catch {
				// Unreadable, missing, or a filesystem without modes — a network share, for instance.
				return { checked: false, secure: null, mode: null, path: directory, advice: "" };
			}

			// Group or other holding any bit at all. Group is not always "just you": on many distros a
			// new user's primary group is shared, and on a NAS it usually is.
			const openBits = mode & 0o077;
			if (openBits === 0) return { checked: true, secure: true, mode: (mode & 0o777).toString(8), path: directory, advice: "" };

			return {
				checked: true,
				secure: false,
				mode: (mode & 0o777).toString(8),
				path: directory,
				advice: `${directory} is readable beyond its owner (mode ${(mode & 0o777).toString(8)}). `
					+ `It holds the character signing key and the credential vault. Restrict it with: `
					+ `chmod 700 ${directory} && chmod 600 ${directory}/*  — run it as the user the server `
					+ "runs as. In Docker this is the host side of the bind mount, and the container runs as "
					+ "root, so tightening it does not lock the game out.",
			};
		},

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
			ensureDirectory();
			fsImpl.writeFileSync(keyPath, pair.privateKey, "utf8");
			const current = fingerprintOf(publicKeyPem);
			log(`🔑 Character signing key rotated (${previous} → ${current}). Existing exports no longer verify.`);
			return { previous, current };
		},
	};
}
