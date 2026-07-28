/**
 * providers — the logic behind the Providers section, kept out of the DOM.
 *
 * This panel has no DOM harness (see `docs/testing.md`), so everything that could
 * be got wrong lives here and is unit tested, leaving the section renderer to do
 * nothing but arrange elements. The decisions worth testing are which policies a
 * given provider can meaningfully take, how a key's state reads without ever
 * showing the key, and how a form becomes a request body the server will accept.
 */

/** The order capabilities are always presented in, whatever order the API used. */
const CAPABILITY_ORDER = Object.freeze(["chat", "speech", "image"]);

/** Policies in the order an operator should consider them. */
const POLICY_ORDER = Object.freeze(["local", "shared", "byok", "off"]);

/**
 * @description Flattens the capability response into one row per provider per
 *   capability. One provider can serve several — OpenAI is both a chat and an
 *   image provider — so a row is keyed by the pair rather than by provider id.
 * @param {object} capabilities - The `/api/admin/providers` payload.
 * @returns {Array<object>} Rows, each carrying its capability and a unique `rowKey`.
 */
export function providerRows(capabilities) {
	if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return [];

	const rows = [];
	for (const capability of CAPABILITY_ORDER) {
		const providers = capabilities[capability]?.providers;
		if (!Array.isArray(providers)) continue;
		for (const provider of providers) {
			if (!provider?.id) continue;
			rows.push({ ...provider, capability, rowKey: `${capability}:${provider.id}` });
		}
	}
	return rows;
}

/**
 * Which policies this provider can meaningfully take.
 *
 * @description Offering all four everywhere would let an operator set Ollama to
 *   "shared" and then hunt for the key field that never appears. The rules are
 *   the descriptor's own: something self-hosted has no account to share, and
 *   something that requires an account cannot be a free local service.
 *
 *   A provider that needs a base URL but no key is the ambiguous case — a custom
 *   gateway may be LM Studio on the same machine or a paid hosted endpoint — so
 *   it gets everything.
 * @param {object|null} provider - A provider descriptor.
 * @returns {string[]} Policy ids in presentation order. Always includes "off".
 */
export function policyOptions(provider) {
	if (!provider || typeof provider !== "object") return ["off"];

	const allowed = new Set(["off"]);
	if (provider.isLocal || (provider.requiresBaseUrl && !provider.requiresApiKey)) allowed.add("local");
	if (!provider.isLocal) {
		allowed.add("shared");
		allowed.add("byok");
	}
	return POLICY_ORDER.filter((policy) => allowed.has(policy));
}

/**
 * @description Describes what the vault holds for a provider, identifying a key
 *   by its tail and never in full. A key too short for a tail still reports as
 *   present — the operator needs to know one is there even when we will not hint
 *   at what it is.
 * @param {object|null|undefined} key - The `key` block of a provider row.
 * @returns {string} A short label for the console.
 */
export function keyStatusLabel(key) {
	if (!key?.configured) return "No key set";

	const identity = key.last4 ? `····${key.last4}` : "Key set";
	switch (key.status) {
		case "ok": return `${identity} · working`;
		case "rejected": return `${identity} · rejected by the provider`;
		default: return `${identity} · untested`;
	}
}

/**
 * Describes whether a provider can serve a game, and what is missing if not.
 *
 * @description Written for the operator rather than the player: every branch
 *   names the thing they would have to change. The unprobed local case
 *   deliberately makes no claim about reachability — saying "offline" because a
 *   probe has not run yet would send someone debugging a working server.
 * @param {object} row - A provider row.
 * @returns {string} A short status line.
 */
export function readinessLabel(row) {
	switch (row?.policy) {
		case "off":
			return "Not offered";
		case "byok":
			return "Players bring their own key";
		case "local":
			if (row.reachable === false) return "Unreachable — check the address";
			return row.reachable === true ? "Ready — answering" : "Ready — not yet probed";
		case "shared":
			return row.ready ? "Ready — this server pays" : "Needs a key before it can be shared";
		default:
			return "Not offered";
	}
}

/**
 * @description Parses a comma-separated model allowlist. A blank list means "no
 *   restriction", never an empty allowlist — the server rejects `[]` because it
 *   is `off` written in a way nobody reads correctly.
 * @param {*} raw - The field value.
 * @returns {string[]|null} The model ids, or null for no restriction.
 */
function parseAllowlist(raw) {
	if (typeof raw !== "string") return null;
	const models = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
	return models.length ? models : null;
}

/**
 * @description Parses a call cap. Sent as a number because the server rejects a
 *   string rather than coercing it, and blank means unlimited.
 * @param {*} raw - The field value.
 * @returns {number|null} A positive integer, or null for no limit.
 */
function parseCap(raw) {
	if (raw === null || raw === undefined || String(raw).trim() === "") return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Turns the form into the body the policy endpoint expects.
 *
 * @description Fields that do not apply to the chosen policy are sent as null
 *   rather than omitted or passed through. The server drops them either way, but
 *   sending a stale address alongside a `byok` policy would make the request read
 *   as though it were meant to take effect.
 * @param {object} form - The raw form values.
 * @returns {{policy: string, sharedModels: string[]|null, maxCallsPerLobby: number|null, baseUrl: string|null}}
 *   The request body.
 */
export function policyPayload(form) {
	const policy = form?.policy;
	const shared = policy === "shared";
	const local = policy === "local";

	return {
		policy,
		sharedModels: shared ? parseAllowlist(form.sharedModels) : null,
		maxCallsPerLobby: shared ? parseCap(form.maxCallsPerLobby) : null,
		baseUrl: local && typeof form.baseUrl === "string" && form.baseUrl.trim() ? form.baseUrl.trim() : null,
	};
}
