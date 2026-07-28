/**
 * Provider policy — who is allowed to spend which credential.
 *
 * The operator answers one question per capability and provider: does this
 * instance pay, does the player bring their own, is it a local service that
 * costs nothing, or is it not offered at all. Everything the settings modal
 * shows a player, and every credential the game loop is permitted to resolve,
 * follows from this document.
 *
 * The module knows nothing about which providers actually exist — that is the
 * registry's job — so a policy can be written for a provider before its adapter
 * lands, and this file stays testable without one (CQ-4, CQ-5).
 *
 * Lookups fail closed. A capability, provider, or document that is missing or
 * unrecognised resolves to `off`, because the failure mode of guessing wrong in
 * the other direction is spending someone's money without being asked.
 */

/** The three things an instance can need a third-party credential for. */
export const CAPABILITIES = Object.freeze(["chat", "speech", "image"]);

/**
 * Who pays, per provider.
 *
 * - `shared` — the instance's own key, optionally capped and restricted to an
 *   allowlist of models.
 * - `byok`   — offered, but the player supplies the credential.
 * - `local`  — a self-hosted service; no credential, an address instead.
 * - `off`    — not offered.
 */
export const POLICIES = Object.freeze(["shared", "byok", "local", "off"]);

/** What every unresolvable lookup returns. */
const CLOSED = Object.freeze({ policy: "off", sharedModels: null, maxCallsPerLobby: null, baseUrl: null });

/** Protocols the server is willing to dial for a local provider. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * @description Raised when a policy document is malformed. Carries the dotted
 *   path of the offending field so the admin console can highlight the right
 *   control instead of showing a generic failure.
 */
export class PolicyError extends Error {
	/**
	 * @description Constructs a policy validation error.
	 * @param {string} message - Human-readable explanation of the problem.
	 * @param {string|null} [field=null] - Dotted path, e.g. `chat.openai.policy`.
	 * @returns {PolicyError} The constructed error.
	 */
	constructor(message, field = null) {
		super(message);
		this.name = "PolicyError";
		this.field = field;
	}
}

/**
 * @description Determines whether a value is a plain (non-array, non-null) object.
 * @param {*} value - The value to test.
 * @returns {boolean} True when the value is a non-null, non-array object.
 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the shape of a local provider's address.
 *
 * @description Rejects anything that is not a bare http(s) origin, and strips
 *   trailing slashes so adapters can build paths by concatenation.
 *
 *   **This is a shape check, not a safety check.** The server dials this address,
 *   so an operator-supplied value must also be proven to resolve onto a private
 *   network before it is accepted — that requires DNS and therefore belongs at
 *   the async admin write boundary, using the same guard
 *   `services/tts/localConfig.js` applies to the speech server (ADR 0006). This
 *   function runs on every load, including from disk, where a DNS round trip
 *   would be wrong; the two layers are complementary, not redundant.
 * @param {*} value - The candidate address.
 * @param {string} field - Dotted path, for the error.
 * @returns {string} The canonical origin, with no trailing slash.
 * @throws {PolicyError} When the value is not a string, is unparseable, is not
 *   http(s), carries a path, or embeds credentials.
 */
function canonicalBaseUrl(value, field) {
	if (typeof value !== "string" || !value.trim()) {
		throw new PolicyError("A base URL must be a non-empty string.", field);
	}
	const stripped = value.trim().replace(/\/+$/, "");

	let url;
	try {
		url = new URL(stripped);
	} catch {
		throw new PolicyError(`"${stripped}" is not a valid address. Try something like http://192.168.1.50:11434`, field);
	}
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new PolicyError(`A base URL must use http or https, not "${url.protocol.replace(":", "")}".`, field);
	}
	if (url.username || url.password) {
		throw new PolicyError("Remove the username and password from the address — credentials are not supported here.", field);
	}
	if (url.pathname && url.pathname !== "/") {
		throw new PolicyError(`Leave off the path ("${url.pathname}") — just the host and port.`, field);
	}
	return `${url.protocol}//${url.host}`;
}

/**
 * @description Validates a shared-model allowlist.
 * @param {*} value - The candidate list.
 * @param {string} field - Dotted path, for the error.
 * @returns {string[]} The trimmed model ids.
 * @throws {PolicyError} When the value is not an array, is empty, or holds a
 *   non-string or blank entry.
 */
function canonicalSharedModels(value, field) {
	if (!Array.isArray(value)) {
		throw new PolicyError("A shared-model allowlist must be an array of model ids.", field);
	}
	// An empty allowlist is "shared, but no model may be used", which is `off`
	// written in a way nobody would read correctly. Surface it as the mistake it is.
	if (value.length === 0) {
		throw new PolicyError('An empty allowlist would offer no models at all — use the "off" policy instead.', field);
	}
	return value.map((entry) => {
		if (typeof entry !== "string" || !entry.trim()) {
			throw new PolicyError("Every entry in a shared-model allowlist must be a non-empty model id.", field);
		}
		return entry.trim();
	});
}

/**
 * @description Validates a per-lobby call cap.
 * @param {*} value - The candidate cap.
 * @param {string} field - Dotted path, for the error.
 * @returns {number} A positive integer.
 * @throws {PolicyError} When the value is not a positive whole number. Strings
 *   are rejected rather than coerced, because a cap arriving as text means the
 *   caller did not parse its own form.
 */
function canonicalCallCap(value, field) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new PolicyError(
			`A call cap must be a whole number of at least 1, received ${JSON.stringify(value)}. ` +
			'Leave it unset for no limit, or use the "off" policy to withdraw the provider.',
			field,
		);
	}
	return value;
}

/**
 * @description Validates one provider's entry and drops every field that does not
 *   apply to the policy it declares. Dropping rather than rejecting is deliberate:
 *   an admin toggling `shared` to `byok` should not have their save refused
 *   because a now-meaningless call cap is still in the form.
 * @param {*} raw - The entry, either a bare policy string or an object.
 * @param {string} path - Dotted path to this entry, for errors.
 * @returns {{policy: string, sharedModels: string[]|null, maxCallsPerLobby: number|null, baseUrl: string|null}}
 *   The canonical entry.
 * @throws {PolicyError} When the entry is the wrong type, or names an unknown policy.
 */
function normalizeEntry(raw, path) {
	const source = typeof raw === "string" ? { policy: raw } : raw;
	if (!isPlainObject(source)) {
		throw new PolicyError(
			`A provider entry must be a policy name or an object, received ${Array.isArray(raw) ? "array" : typeof raw}.`,
			path,
		);
	}

	const policy = typeof source.policy === "string" ? source.policy.trim().toLowerCase() : "";
	if (!POLICIES.includes(policy)) {
		throw new PolicyError(
			`Unknown policy "${source.policy}". Expected one of: ${POLICIES.join(", ")}.`,
			`${path}.policy`,
		);
	}

	const shared = policy === "shared";
	const local = policy === "local";

	return {
		policy,
		sharedModels: shared && source.sharedModels != null
			? canonicalSharedModels(source.sharedModels, `${path}.sharedModels`)
			: null,
		maxCallsPerLobby: shared && source.maxCallsPerLobby != null
			? canonicalCallCap(source.maxCallsPerLobby, `${path}.maxCallsPerLobby`)
			: null,
		baseUrl: local && source.baseUrl != null
			? canonicalBaseUrl(source.baseUrl, `${path}.baseUrl`)
			: null,
	};
}

/**
 * Validates and canonicalises a whole policy document.
 *
 * @description Runs once, wherever a document arrives from disk or from an admin
 *   form, and everything downstream may assume the result is well-formed (CQ-6).
 *   Every capability is present in the output even when the input omitted it, so
 *   callers never have to guard for a missing branch.
 *
 *   Unknown capabilities are dropped rather than rejected: a document written by
 *   a newer version that has grown a fourth capability must still load here,
 *   because refusing would lock an operator out of the admin console entirely.
 *   Unknown *policy values* are rejected, because there is no safe reading of one.
 * @param {object} [raw] - The untrusted document.
 * @returns {object} Capability → provider id → canonical entry.
 * @throws {PolicyError} When a capability's value is not an object, or any entry
 *   is malformed; `err.field` carries the dotted path.
 */
export function normalizePolicyDocument(raw) {
	if (raw != null && !isPlainObject(raw)) {
		throw new PolicyError(`A policy document must be an object, received ${Array.isArray(raw) ? "array" : typeof raw}.`, null);
	}
	const source = raw ?? {};
	const out = {};

	for (const capability of CAPABILITIES) {
		const providers = source[capability];
		out[capability] = {};
		if (providers == null) continue;
		if (!isPlainObject(providers)) {
			throw new PolicyError(
				`The "${capability}" section must map provider ids to policies, received ${typeof providers}.`,
				capability,
			);
		}
		for (const [providerId, entry] of Object.entries(providers)) {
			const id = providerId.trim().toLowerCase();
			if (!id) throw new PolicyError("A provider id must not be blank.", capability);
			out[capability][id] = normalizeEntry(entry, `${capability}.${id}`);
		}
	}

	return out;
}

/**
 * Resolves what a capability and provider are permitted to do.
 *
 * @description Assumes a normalized document. Anything unrecognised — an unknown
 *   capability, an unconfigured provider, a null document — resolves to `off`,
 *   so a lookup can never accidentally authorise spending.
 * @param {object|null} doc - A normalized policy document.
 * @param {string} capability - One of `CAPABILITIES`.
 * @param {string} providerId - The provider to look up.
 * @returns {{policy: string, sharedModels: string[]|null, maxCallsPerLobby: number|null, baseUrl: string|null}}
 *   The entry, or a closed entry.
 */
export function policyFor(doc, capability, providerId) {
	if (!isPlainObject(doc) || typeof capability !== "string" || typeof providerId !== "string") return { ...CLOSED };
	const entry = doc[capability]?.[providerId.trim().toLowerCase()];
	return entry ? { ...entry } : { ...CLOSED };
}

/**
 * Derives a starting policy from what the instance actually has.
 *
 * @description Used on first run, and whenever no policy file exists yet. The
 *   rule is one line: a provider needing no credential is `local`, a provider the
 *   vault holds a key for is `shared`, and everything else is `byok`.
 *
 *   `shared` for a configured key reproduces the behaviour every existing install
 *   already has — keys in `.env` served every lobby — so upgrading does not
 *   silently withdraw access from a running instance. `byok` rather than `off`
 *   for the rest matters just as much: it means a fresh install with no keys at
 *   all is still playable by anyone willing to bring their own.
 * @param {object} [options] - What the instance offers and holds.
 * @param {object} [options.known] - Capability → `[{id, local}]`, from the registries.
 * @param {object} [options.configured] - Capability → provider ids the vault has keys for.
 * @returns {object} A canonical policy document.
 */
export function defaultPolicyDocument({ known = {}, configured = {} } = {}) {
	const draft = {};

	for (const capability of CAPABILITIES) {
		draft[capability] = {};
		const withKeys = new Set(Array.isArray(configured[capability]) ? configured[capability] : []);

		for (const provider of Array.isArray(known[capability]) ? known[capability] : []) {
			if (!provider?.id) continue;
			if (provider.local) draft[capability][provider.id] = "local";
			else draft[capability][provider.id] = withKeys.has(provider.id) ? "shared" : "byok";
		}
	}

	return normalizePolicyDocument(draft);
}

/**
 * Reads and writes the policy document on disk.
 *
 * @description Plain JSON, deliberately: the document holds no secrets — only
 *   which providers are offered and who pays — so it is worth keeping readable
 *   and hand-editable. Key material lives in the vault and never here.
 * @param {object} options - Injected dependencies.
 * @param {object} options.fsImpl - Filesystem implementation.
 * @param {string} options.filePath - Where the document lives.
 * @returns {{load: Function, save: Function}} The store.
 */
export function createPolicyStore({ fsImpl, filePath }) {
	return {
		/**
		 * @description Reads the stored document.
		 * @returns {object|null} The normalized document, or null when none is stored.
		 * @throws {PolicyError} When the file is unreadable or holds an invalid
		 *   document. Falling back to defaults would quietly change who pays, which
		 *   is the one outcome an operator must never be surprised by.
		 */
		load() {
			if (!fsImpl.existsSync(filePath)) return null;
			let parsed;
			try {
				parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
			} catch (err) {
				throw new PolicyError(`${filePath} is not readable as JSON: ${err.message}`, null);
			}
			return normalizePolicyDocument(parsed);
		},

		/**
		 * @description Validates and writes a document. Nothing is written when
		 *   validation fails, so a bad admin submission cannot corrupt a working file.
		 * @param {object} doc - The document to store.
		 * @returns {object} The normalized document that was written.
		 * @throws {PolicyError} When the document is invalid.
		 */
		save(doc) {
			const normalized = normalizePolicyDocument(doc);
			fsImpl.writeFileSync(filePath, `${JSON.stringify(normalized, null, "\t")}\n`, "utf8");
			return normalized;
		},
	};
}
