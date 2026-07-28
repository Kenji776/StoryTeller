/**
 * Per-lobby credential state: the host's supplied keys, and what a lobby has spent.
 *
 * A lobby runs on its host's credential (ADR 0001), which means one person's key
 * pays for every player at the table. Two consequences shape this module.
 *
 * **The host has to have agreed.** `put` refuses a credential that does not carry
 * explicit consent, so the disclosure cannot be skipped by a UI that forgot to
 * show it. The agreement is a required argument rather than a checkbox the server
 * trusts the browser to have rendered.
 *
 * **Two things are stored here with deliberately different lifetimes.**
 *
 * - The *secret* is purged aggressively: on host disconnect, on expiry, on an
 *   idle timeout, and when the lobby ends. It exists only while it is useful.
 * - The *ledger* — how many calls this lobby has spent — is not sensitive and
 *   lives as long as the lobby does. This is not tidiness. ADR 0003 drops the
 *   credential whenever the host's socket closes and has the client re-send it
 *   on rejoin, so a ledger sharing the secret's lifetime would reset on every
 *   flaky connection, and a host's spending limit would mean nothing.
 *
 * Time is injected. Nothing here reaches for a clock, a timer, or the network,
 * which is what lets expiry be asserted at an instant rather than slept through
 * (CQ-5, TDD-8).
 */

import { CAPABILITIES } from "./policy.js";

/** How long an untouched credential survives when the host set no expiry. */
const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

/** Keys of this length or shorter reveal nothing, matching the vault and `redactLLMConfig`. */
const MASK_THRESHOLD = 8;

/**
 * @description Determines whether a value is a plain (non-array, non-null) object.
 * @param {*} value - The value to test.
 * @returns {boolean} True when the value is a non-null, non-array object.
 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @description Reads a required non-blank string argument.
 * @param {*} value - The candidate.
 * @param {string} label - The argument name, used in the message.
 * @returns {string} The trimmed value.
 * @throws {TypeError} When the value is not a string or trims to nothing.
 */
function requireText(value, label) {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${label} is required and must be a non-empty string.`);
	}
	return value.trim();
}

/**
 * @description Validates the host's call limit.
 * @param {*} value - The candidate limit, or null/undefined for unlimited.
 * @returns {number|null} A positive integer, or null meaning no limit.
 * @throws {TypeError} When the value is present but is not a whole number of at least one.
 */
function normalizeLimit(value) {
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new TypeError(
			`A call limit must be a whole number of at least 1, received ${JSON.stringify(value)}. ` +
			"Leave it unset for no limit.",
		);
	}
	return value;
}

/**
 * Validates the host's expiry date.
 *
 * @description An expiry can only ever shorten a credential's life. Every other
 *   purge trigger still applies underneath it, so a host setting a date a year out
 *   is not asking us to hold their key for a year — their socket closing will drop
 *   it long before. A date already in the past is refused rather than accepted and
 *   instantly expired, because it means a broken form or a timezone mistake, and
 *   silently accepting it would look like the credential simply never worked.
 * @param {*} value - Epoch milliseconds, an ISO string, or null for no expiry.
 * @param {number} nowMs - The current instant.
 * @returns {number|null} The expiry in epoch milliseconds, or null.
 * @throws {TypeError} When the value is unparseable or is not in the future.
 */
function normalizeExpiry(value, nowMs) {
	if (value === null || value === undefined) return null;

	const parsed = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new TypeError(`The expiry date could not be read: ${JSON.stringify(value)}.`);
	}
	if (parsed <= nowMs) {
		throw new TypeError("The expiry date must be in the future.");
	}
	return parsed;
}

/**
 * @description Produces the identifying tail of a key, or nothing when it is too
 *   short for a tail to be safe to show.
 * @param {string|null|undefined} apiKey - The credential.
 * @returns {string|null} The last four characters, or null.
 */
function last4Of(apiKey) {
	return typeof apiKey === "string" && apiKey.length > MASK_THRESHOLD ? apiKey.slice(-4) : null;
}

/**
 * Creates the per-lobby credential store.
 *
 * @param {object} [options] - Injected dependencies.
 * @param {Function} [options.now] - Clock returning epoch milliseconds.
 * @param {Function} [options.log] - Logger for purge notices.
 * @param {Function} [options.onPurge] - Called with `{lobbyId, capability, reason}`
 *   whenever a secret is dropped, so the server can pause the lobby and tell the host.
 * @param {number} [options.idleTtlMs] - How long an untouched credential survives.
 * @returns {object} The store interface.
 */
export function createSessionKeys({
	now = () => Date.now(),
	log = () => {},
	onPurge = () => {},
	idleTtlMs = DEFAULT_IDLE_TTL_MS,
} = {}) {
	/** lobbyId → capability → the secret and its terms. Purged aggressively. */
	const secrets = new Map();
	/** lobbyId → { capabilities: {…}, shared: {…} }. Lives as long as the lobby. */
	const ledgers = new Map();

	/**
	 * @description Fetches a lobby's ledger, creating it on first use.
	 * @param {string} lobbyId - The lobby.
	 * @returns {object} The ledger.
	 */
	function ledgerFor(lobbyId) {
		if (!ledgers.has(lobbyId)) ledgers.set(lobbyId, { capabilities: {}, shared: {} });
		return ledgers.get(lobbyId);
	}

	/**
	 * @description Removes one secret and reports it, leaving the ledger intact.
	 * @param {string} lobbyId - The lobby.
	 * @param {string} capability - The capability.
	 * @param {string} reason - Why it is being dropped.
	 * @returns {object|null} The purge record, or null when there was nothing to drop.
	 */
	function drop(lobbyId, capability, reason) {
		const held = secrets.get(lobbyId);
		if (!held?.[capability]) return null;

		// Overwriting before deleting does not guarantee the string leaves memory —
		// JS offers no way to promise that — but it does mean the live object graph
		// stops referencing it the moment this returns.
		held[capability].config.apiKey = null;
		delete held[capability];
		if (!Object.keys(held).length) secrets.delete(lobbyId);

		const record = { lobbyId, capability, reason };
		log(`🔑 Dropped the ${capability} credential for lobby ${lobbyId} (${reason})`);
		onPurge(record);
		return record;
	}

	return {
		/**
		 * Stores a host-supplied credential for one capability of one lobby.
		 *
		 * @description Replaces any credential already held, and deliberately does
		 *   *not* reset the spend ledger: re-supplying after a reconnect must not
		 *   hand the host a fresh budget they did not ask for.
		 * @param {string} lobbyId - The lobby this credential pays for.
		 * @param {object} entry - The credential and its terms.
		 * @param {string} entry.capability - One of `CAPABILITIES`.
		 * @param {object} entry.config - A normalized AI configuration.
		 * @param {string} entry.ownerSid - The host's socket id, so a disconnect can clear it.
		 * @param {boolean} entry.consent - Must be exactly `true`: the host's
		 *   acknowledgement that this key pays for every player in the lobby.
		 * @param {number|null} [entry.maxCalls] - Call limit, or null for unlimited.
		 * @param {number|string|null} [entry.expiresAt] - When to drop it regardless
		 *   of game state, as epoch milliseconds or an ISO string.
		 * @returns {void}
		 * @throws {TypeError} When any field is missing, malformed, or when consent
		 *   was not given.
		 */
		put(lobbyId, { capability, config, ownerSid, consent, maxCalls = null, expiresAt = null } = {}) {
			const id = requireText(lobbyId, "lobbyId");

			const cap = requireText(capability, "capability");
			if (!CAPABILITIES.includes(cap)) {
				throw new TypeError(`Unknown capability "${cap}". Expected one of: ${CAPABILITIES.join(", ")}.`);
			}

			if (!isPlainObject(config)) {
				throw new TypeError(`config must be an object, received ${config === null ? "null" : typeof config}.`);
			}
			const providerId = requireText(config.providerId, "config.providerId");
			const sid = requireText(ownerSid, "ownerSid");

			// Exactly true. A truthy string from a query parameter is not agreement,
			// and neither is a checkbox the browser forgot to send.
			if (consent !== true) {
				throw new TypeError(
					"A host must consent before their credential is accepted: this key pays for every " +
					"player in the lobby, for every call the game makes that is not to a local service.",
				);
			}

			const at = now();
			const limit = normalizeLimit(maxCalls);
			const expiry = normalizeExpiry(expiresAt, at);

			if (!secrets.has(id)) secrets.set(id, {});
			secrets.get(id)[cap] = {
				config: { ...config },
				ownerSid: sid,
				suppliedAt: at,
				lastUsedAt: null,
				maxCalls: limit,
				expiresAt: expiry,
			};

			const book = ledgerFor(id).capabilities;
			// `used` is preserved across a re-supply; everything else is a fresh memo,
			// kept so the host's UI can still explain a credential after it is dropped.
			book[cap] = {
				used: book[cap]?.used ?? 0,
				providerId,
				last4: last4Of(config.apiKey),
				consentAt: new Date(at).toISOString(),
				maxCalls: limit,
				expiresAt: expiry ? new Date(expiry).toISOString() : null,
			};
		},

		/**
		 * Spends one call against a lobby's host credential.
		 *
		 * @description Checking and counting are one operation so that a caller
		 *   cannot read a credential and forget to record the spend. An expired
		 *   credential is dropped here as well as by the sweep — a failed read is
		 *   still a moment at which we have learned it is no longer useful.
		 * @param {string} lobbyId - The lobby making the call.
		 * @param {string} capability - The capability being used.
		 * @returns {{ok: true, config: object}|{ok: false, reason: string}} The
		 *   credential, or why it cannot be used: `absent`, `expired`, or `exhausted`.
		 */
		take(lobbyId, capability) {
			const entry = secrets.get(lobbyId)?.[capability];
			if (!entry) return { ok: false, reason: "absent" };

			if (entry.expiresAt !== null && now() >= entry.expiresAt) {
				drop(lobbyId, capability, "expired");
				return { ok: false, reason: "expired" };
			}

			const book = ledgerFor(lobbyId).capabilities[capability] ?? { used: 0 };
			if (entry.maxCalls !== null && book.used >= entry.maxCalls) {
				// Kept rather than dropped: the host may raise their own limit, and
				// making them re-enter the key to do it would be gratuitous. Every
				// other purge trigger still bounds how long it is held.
				return { ok: false, reason: "exhausted" };
			}

			book.used += 1;
			ledgerFor(lobbyId).capabilities[capability] = book;
			entry.lastUsedAt = now();
			return { ok: true, config: { ...entry.config } };
		},

		/**
		 * @description Describes what a lobby holds, in a form safe to send to a
		 *   browser. Capabilities whose secret has been dropped are still reported,
		 *   with `configured: false`, so the host's UI can say *why* a game paused
		 *   rather than showing an empty panel.
		 * @param {string} lobbyId - The lobby to describe.
		 * @returns {object|null} Capability → metadata, or null when the lobby has
		 *   never held a credential.
		 */
		describe(lobbyId) {
			const held = secrets.get(lobbyId);
			const ledger = ledgers.get(lobbyId);
			if (!held && !ledger) return null;

			const out = {};
			for (const [capability, memo] of Object.entries(ledger?.capabilities ?? {})) {
				out[capability] = {
					configured: Boolean(held?.[capability]),
					providerId: memo.providerId,
					last4: memo.last4,
					consentAt: memo.consentAt,
					maxCalls: memo.maxCalls,
					used: memo.used,
					expiresAt: memo.expiresAt,
				};
			}
			return out;
		},

		/**
		 * @description Drops every secret a lobby holds, keeping its spend ledger.
		 *   This is the host-disconnect path (ADR 0003).
		 * @param {string} lobbyId - The lobby.
		 * @param {string} reason - Why, for the log and the purge listener.
		 * @returns {boolean} True when at least one secret was dropped.
		 */
		dropSecrets(lobbyId, reason) {
			const held = secrets.get(lobbyId);
			if (!held) return false;
			for (const capability of Object.keys(held)) drop(lobbyId, capability, reason);
			return true;
		},

		/**
		 * @description Drops every secret belonging to one host's socket, wherever it
		 *   is held. Spend ledgers are kept.
		 * @param {string} socketId - The socket that has gone away.
		 * @param {string} reason - Why, for the log and the purge listener.
		 * @returns {Array<object>} One record per secret dropped.
		 */
		dropSecretsBySocket(socketId, reason) {
			const dropped = [];
			for (const [lobbyId, held] of [...secrets]) {
				for (const [capability, entry] of Object.entries(held)) {
					if (entry.ownerSid === socketId) {
						const record = drop(lobbyId, capability, reason);
						if (record) dropped.push(record);
					}
				}
			}
			return dropped;
		},

		/**
		 * @description Forgets a lobby entirely — secrets and ledger both. This is
		 *   the end of a game, not the end of a connection: the spend history is
		 *   only meaningful while the lobby it belongs to exists.
		 * @param {string} lobbyId - The lobby.
		 * @param {string} reason - Why, for the log and the purge listener.
		 * @returns {boolean} True when the lobby held anything at all.
		 */
		forget(lobbyId, reason) {
			const had = secrets.has(lobbyId) || ledgers.has(lobbyId);
			if (!had) return false;
			for (const capability of Object.keys(secrets.get(lobbyId) ?? {})) drop(lobbyId, capability, reason);
			ledgers.delete(lobbyId);
			return true;
		},

		/**
		 * Drops everything that has outlived its usefulness.
		 *
		 * @description The active half of expiry. A credential the host put a date on
		 *   must go when that date passes whether or not anyone is playing, which a
		 *   check on the read path alone cannot deliver. The idle timeout underneath
		 *   it is a backstop for a host whose disconnect was never observed.
		 * @returns {Array<object>} One record per secret dropped.
		 */
		sweep() {
			const at = now();
			const dropped = [];
			for (const [lobbyId, held] of [...secrets]) {
				for (const [capability, entry] of Object.entries(held)) {
					const idleSince = entry.lastUsedAt ?? entry.suppliedAt;
					const reason = entry.expiresAt !== null && at >= entry.expiresAt ? "expired"
						: at - idleSince > idleTtlMs ? "idle"
						: null;
					if (reason) {
						const record = drop(lobbyId, capability, reason);
						if (record) dropped.push(record);
					}
				}
			}
			return dropped;
		},

		/**
		 * @description Records one call made against the instance's own shared key.
		 *   Tracked per provider, because an operator may cap two providers differently.
		 * @param {string} lobbyId - The lobby making the call.
		 * @param {string} capability - The capability being used.
		 * @param {string} providerId - The provider being called.
		 * @returns {number} The lobby's new total for that provider.
		 */
		countSharedUse(lobbyId, capability, providerId) {
			const book = ledgerFor(lobbyId).shared;
			const slot = `${capability}:${providerId}`;
			book[slot] = (book[slot] ?? 0) + 1;
			return book[slot];
		},

		/**
		 * @description Reports how much of the instance's shared key a lobby has spent.
		 * @param {string} lobbyId - The lobby.
		 * @param {string} capability - The capability.
		 * @param {string} providerId - The provider.
		 * @returns {number} The count, zero when there is none.
		 */
		sharedUse(lobbyId, capability, providerId) {
			return ledgers.get(lobbyId)?.shared?.[`${capability}:${providerId}`] ?? 0;
		},

		/**
		 * @description Counts the credentials currently held. Ledgers are not counted;
		 *   this is "how many secrets are in memory right now", which is the number
		 *   worth watching.
		 * @returns {number} The count.
		 */
		size() {
			let total = 0;
			for (const held of secrets.values()) total += Object.keys(held).length;
			return total;
		},
	};
}
