/**
 * The operator's credential vault.
 *
 * Holds the third-party API keys an instance owner supplies — OpenAI, Anthropic,
 * ElevenLabs and anything else added later — encrypted on disk so that a leaked
 * backup, a volume snapshot, or a misconfigured static mount of `server/data/`
 * does not hand over working credentials.
 *
 * **What this does and does not protect against.** The encryption key is derived
 * from a secret held in the process environment, not from anything stored beside
 * the ciphertext. That is the difference between this and the "encrypt the lobby
 * JSON" idea rejected in ADR 0001 as security theatre: there the key would have
 * sat next to what it protected. Here, someone holding the file has nothing;
 * someone holding the environment has everything. See ADR 0013.
 *
 * With no secret configured the vault refuses to persist and runs in memory for
 * the life of the process. Writing plaintext would be worse than forgetting, and
 * refusing to boot would break every LAN install that never wanted a vault.
 *
 * Nothing here reaches for `fs`, `crypto`'s randomness, or the clock directly —
 * all three are injected, which is what lets the whole module be exercised
 * without a disk (CQ-5, TDD-8).
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import fs from "fs";
import path from "path";

/** Envelope format version, so a future change can migrate rather than guess. */
const ENVELOPE_VERSION = 1;

/** scrypt cost parameters. 128 * N * r = 16 MB, inside Node's 32 MB default. */
const KDF = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32 });

/** AES-256-GCM standard sizes, in bytes. */
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * Keys of this length or shorter reveal nothing at all.
 *
 * Matches `redactLLMConfig` in `services/llm/config.js`: long enough to identify
 * which key is in play, short enough that the remainder is useless.
 */
const MASK_THRESHOLD = 8;

/**
 * @description Raised when the vault file exists but cannot be read — a wrong
 *   secret, a missing secret, a corrupt file, or a tampered ciphertext. All four
 *   are indistinguishable to AES-GCM and all four mean the same thing to an
 *   operator: the keys on disk are not available to this process.
 */
export class VaultLockedError extends Error {
	/**
	 * @description Constructs a locked-vault error.
	 * @param {string} message - Human-readable explanation, never containing key material.
	 * @returns {VaultLockedError} The constructed error.
	 */
	constructor(message) {
		super(message);
		this.name = "VaultLockedError";
	}
}

/**
 * @description Reads a required non-blank string argument.
 * @param {*} value - The candidate.
 * @param {string} label - The argument name, for the message.
 * @returns {string} The trimmed value.
 * @throws {TypeError} When the value is not a string, or trims to nothing.
 */
function requireText(value, label) {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string, received ${value === null ? "null" : typeof value}.`);
	}
	const trimmed = value.trim();
	if (!trimmed) throw new TypeError(`${label} must not be blank.`);
	return trimmed;
}

/**
 * @description Produces the identifying tail of a key, or nothing when the key is
 *   too short for a tail to be safe to show.
 * @param {string} apiKey - The stored key.
 * @returns {string|null} The last four characters, or null.
 */
function last4Of(apiKey) {
	return apiKey.length > MASK_THRESHOLD ? apiKey.slice(-4) : null;
}

/**
 * @description Derives the file encryption key from the operator's secret.
 * @param {string} secret - The configured secret.
 * @param {Buffer} salt - The per-file salt.
 * @returns {Buffer} A 32-byte key.
 */
function deriveKey(secret, salt) {
	return scryptSync(secret, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p });
}

/**
 * @description Decrypts an envelope into the record map it carries.
 * @param {object} envelope - The parsed on-disk envelope.
 * @param {string} secret - The operator's secret.
 * @returns {{records: object, salt: Buffer, key: Buffer}} The records and the
 *   derived material, kept so subsequent writes need not re-run scrypt.
 * @throws {VaultLockedError} When the envelope is malformed or will not decrypt.
 */
function openEnvelope(envelope, secret) {
	if (!envelope || typeof envelope !== "object" || envelope.v !== ENVELOPE_VERSION) {
		throw new VaultLockedError("The credential file is not in a format this version understands.");
	}

	let records;
	let salt;
	let key;
	try {
		salt = Buffer.from(envelope.salt, "base64");
		const iv = Buffer.from(envelope.iv, "base64");
		const tag = Buffer.from(envelope.tag, "base64");
		key = deriveKey(secret, salt);

		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
		records = JSON.parse(plain.toString("utf8"));
	} catch {
		throw new VaultLockedError(
			"The credential file could not be decrypted. The secret does not match the one it was written with, " +
			"or the file has been altered. The file has been left untouched.",
		);
	}

	if (!records || typeof records !== "object" || Array.isArray(records)) {
		throw new VaultLockedError("The credential file decrypted to something that is not a set of records.");
	}
	return { records, salt, key };
}

/**
 * Opens the operator credential vault.
 *
 * @description Reads and decrypts the file once, at construction, so that a bad
 *   secret is a loud startup failure rather than a surprise on the first admin
 *   action. A vault that could not be opened is never writable: overwriting a
 *   file we cannot read would destroy working credentials on a typo.
 * @param {object} options - Injected dependencies and configuration.
 * @param {object} [options.fsImpl=fs] - Filesystem implementation.
 * @param {string} options.filePath - Where the encrypted vault lives.
 * @param {string|null} options.secret - The operator's secret. Null or blank puts
 *   the vault in memory-only mode.
 * @param {Function} [options.now] - Clock returning a Date, injected for tests.
 * @param {Function} [options.log] - Logger for operator-facing notices.
 * @returns {object} The vault interface.
 * @throws {VaultLockedError} When a vault file exists and cannot be decrypted,
 *   including when no secret was supplied at all.
 * @throws {TypeError} When `filePath` is missing.
 */
export function createVault({ fsImpl = fs, filePath, secret, now = () => new Date(), log = () => {} } = {}) {
	requireText(filePath, "filePath");

	const usableSecret = typeof secret === "string" && secret.trim() ? secret.trim() : null;
	const fileExists = fsImpl.existsSync(filePath);

	if (fileExists && !usableSecret) {
		throw new VaultLockedError(
			`${filePath} holds encrypted credentials but no secret is configured. ` +
			"Set STORYTELLER_SECRET (or STORYTELLER_SECRET_FILE) to the value it was written with.",
		);
	}

	/** @type {object} Provider id → { apiKey, addedAt, status, lastValidated }. */
	let records = {};
	/** Derived once and reused, so an admin write does not pay for scrypt again. */
	let salt = null;
	let key = null;

	if (fileExists) {
		let parsed;
		try {
			parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
		} catch {
			throw new VaultLockedError(`${filePath} is not readable as a credential envelope. The file has been left untouched.`);
		}
		({ records, salt, key } = openEnvelope(parsed, usableSecret));
	}

	const persistent = Boolean(usableSecret);
	if (!persistent) {
		log("⚠️  No STORYTELLER_SECRET is set — API keys entered in the admin console will be kept in memory only and lost on restart.");
	}

	/**
	 * @description Encrypts and writes the current records. A vault with no secret
	 *   writes nothing at all rather than falling back to plaintext.
	 * @returns {void}
	 */
	function persist() {
		if (!persistent) return;

		if (!salt) {
			salt = randomBytes(SALT_BYTES);
			key = deriveKey(usableSecret, salt);
		}
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const data = Buffer.concat([cipher.update(JSON.stringify(records), "utf8"), cipher.final()]);

		const envelope = {
			v: ENVELOPE_VERSION,
			kdf: "scrypt",
			N: KDF.N,
			r: KDF.r,
			p: KDF.p,
			salt: salt.toString("base64"),
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			data: data.toString("base64"),
		};

		const dir = path.dirname(filePath);
		if (dir && dir !== "." && !fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
		fsImpl.writeFileSync(filePath, JSON.stringify(envelope), { mode: 0o600 });
	}

	return {
		persistent,

		/**
		 * @description Stores or replaces a provider's key and writes the vault.
		 * @param {string} providerId - The provider the key belongs to.
		 * @param {string} apiKey - The credential.
		 * @returns {void}
		 * @throws {TypeError} When either argument is absent, blank, or not a string.
		 */
		set(providerId, apiKey) {
			const id = requireText(providerId, "providerId");
			const value = requireText(apiKey, "apiKey");
			records[id] = { apiKey: value, addedAt: now().toISOString(), status: "unknown", lastValidated: null };
			persist();
		},

		/**
		 * @description Forgets a provider's key.
		 * @param {string} providerId - The provider to clear.
		 * @returns {boolean} True when a key was actually removed.
		 * @throws {TypeError} When the provider id is absent or blank.
		 */
		clear(providerId) {
			const id = requireText(providerId, "providerId");
			if (!Object.hasOwn(records, id)) return false;
			delete records[id];
			persist();
			return true;
		},

		/**
		 * @description Returns a provider's raw key. The only function here that
		 *   yields key material; callers outside credential resolution have no
		 *   business with it, and nothing may put the result into a log (STY-3).
		 * @param {string} providerId - The provider to read.
		 * @returns {string|null} The key, or null when none is stored.
		 */
		read(providerId) {
			return typeof providerId === "string" ? records[providerId.trim()]?.apiKey ?? null : null;
		},

		/**
		 * @description Reports whether a provider has a key, without revealing it.
		 * @param {string} providerId - The provider to test.
		 * @returns {boolean} True when a key is stored.
		 */
		has(providerId) {
			return typeof providerId === "string" && Object.hasOwn(records, providerId.trim());
		},

		/**
		 * @description Describes what the vault holds, in a form safe to send to a
		 *   browser. This is what the admin console renders; the key itself never
		 *   travels back out of the server.
		 * @returns {object} Provider id → `{configured, last4, addedAt, status, lastValidated}`.
		 */
		describe() {
			const out = {};
			for (const [id, record] of Object.entries(records)) {
				out[id] = {
					configured: true,
					last4: last4Of(record.apiKey),
					addedAt: record.addedAt ?? null,
					status: record.status ?? "unknown",
					lastValidated: record.lastValidated ?? null,
				};
			}
			return out;
		},

		/**
		 * @description Records the outcome of a live check against the provider, so
		 *   the admin console can show a key as working or rejected without
		 *   re-testing on every page load.
		 * @param {string} providerId - The provider that was tested.
		 * @param {{ok: boolean}} result - The outcome of the test call.
		 * @returns {void}
		 */
		recordValidation(providerId, { ok } = {}) {
			const id = typeof providerId === "string" ? providerId.trim() : "";
			if (!records[id]) return;
			records[id].status = ok ? "ok" : "rejected";
			records[id].lastValidated = now().toISOString();
			persist();
		},
	};
}
