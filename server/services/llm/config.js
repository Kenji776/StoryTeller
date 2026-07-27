/**
 * LLM configuration boundary.
 *
 * Every AI configuration in this system originates in a player's browser and is
 * therefore untrusted. It passes through `normalizeLLMConfig` exactly once, at
 * the edge, and everything downstream — the adapters, the credential store, the
 * game loop — may assume the result is well-formed (CQ-6).
 *
 * The module is deliberately free of I/O and of any provider-specific knowledge:
 * the provider descriptor is injected, so the rules here can be exercised
 * against any provider without a network or a real key (CQ-5, TDD-8).
 */

/**
 * @description Error raised when a player-supplied AI configuration is invalid.
 *   Carries the offending field name so the UI can highlight the right input
 *   rather than showing a generic failure.
 */
export class LLMConfigError extends Error {
	/**
	 * @description Constructs a configuration error.
	 * @param {string} message - Human-readable explanation naming the problem.
	 * @param {string|null} [field=null] - The offending field, e.g. "apiKey".
	 * @returns {LLMConfigError} The constructed error.
	 */
	constructor(message, field = null) {
		super(message);
		this.name = "LLMConfigError";
		this.field = field;
	}
}

/** Protocols the server is willing to send a player's credentials over. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * @description Determines whether a value is a plain (non-array, non-null) object.
 * @param {*} value - The value to test.
 * @returns {boolean} True when the value is a non-null, non-array object.
 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @description Reads an optional string field, rejecting non-string values and
 *   collapsing blank strings to null.
 * @param {object} raw - The raw configuration object.
 * @param {string} field - The field name to read.
 * @returns {string|null} The trimmed value, or null when absent or blank.
 * @throws {LLMConfigError} When the field is present but is not a string.
 */
function optionalString(raw, field) {
	const value = raw[field];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new LLMConfigError(`${field} must be a string, received ${typeof value}.`, field);
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * @description Validates and canonicalises a base URL: enforces http(s) and
 *   strips trailing slashes so adapters can build paths by concatenation.
 * @param {string} value - The candidate URL.
 * @returns {string} The canonical base URL with no trailing slash.
 * @throws {LLMConfigError} When the value is unparseable or is not http(s).
 */
function canonicalBaseUrl(value) {
	const stripped = value.replace(/\/+$/, "");
	let parsed;
	try {
		parsed = new URL(stripped);
	} catch {
		throw new LLMConfigError(`baseUrl is not a valid URL: ${stripped}`, "baseUrl");
	}
	if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
		throw new LLMConfigError(
			`baseUrl must use http or https, received ${parsed.protocol.replace(":", "")}.`,
			"baseUrl"
		);
	}
	return stripped;
}

/**
 * @description Validates a raw AI configuration against a provider descriptor
 *   and returns a canonical, fully-populated config. Unknown fields are dropped
 *   so nothing unexpected can ride along into logs or persisted state.
 * @param {object} raw - The untrusted configuration, typically straight off a socket.
 * @param {object} provider - The resolved provider descriptor, supplying the id,
 *   label, credential requirements, and default base URL.
 * @returns {{ providerId: string, apiKey: string|null, model: string|null, baseUrl: string|null }}
 *   The canonical configuration.
 * @throws {LLMConfigError} When the provider descriptor is missing, when `raw`
 *   is not an object, when a field has the wrong type, when a required
 *   credential is absent, or when the base URL is malformed or non-HTTP.
 */
export function normalizeLLMConfig(raw, provider) {
	if (!isPlainObject(provider)) {
		throw new LLMConfigError("A provider descriptor is required to normalize a config.", "providerId");
	}
	if (!isPlainObject(raw)) {
		throw new LLMConfigError(
			`AI configuration must be an object, received ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}.`,
			"config"
		);
	}

	const providerId = optionalString(raw, "providerId") ?? provider.id;
	if (providerId !== provider.id) {
		throw new LLMConfigError(
			`providerId "${providerId}" does not match the resolved provider "${provider.id}".`,
			"providerId"
		);
	}

	const apiKey = optionalString(raw, "apiKey");
	if (provider.requiresApiKey && !apiKey) {
		throw new LLMConfigError(`${provider.label} requires an API key.`, "apiKey");
	}

	// A present-but-blank model means the UI failed to populate its dropdown.
	// That is a bug worth surfacing rather than a default worth guessing.
	if (typeof raw.model === "string" && raw.model.trim() === "") {
		throw new LLMConfigError("model must not be blank.", "model");
	}
	const model = optionalString(raw, "model");

	const explicitBaseUrl = optionalString(raw, "baseUrl");
	const candidateBaseUrl = explicitBaseUrl ?? provider.defaultBaseUrl ?? null;
	if (!candidateBaseUrl && provider.requiresBaseUrl) {
		throw new LLMConfigError(`${provider.label} requires a base URL.`, "baseUrl");
	}
	const baseUrl = candidateBaseUrl ? canonicalBaseUrl(candidateBaseUrl) : null;

	return { providerId, apiKey, model, baseUrl };
}

/**
 * @description Produces a log-safe copy of a configuration with the API key
 *   masked. Everything written to `server/logs/llm-*.jsonl` or to stdout passes
 *   through here first (STY-3). Keys of nine characters or more reveal only
 *   their last four so an operator can tell which key was in play; anything
 *   shorter is masked entirely.
 * @param {object|null} config - A normalized configuration, or null.
 * @returns {object|null} A new object with `apiKey` masked, or null when the
 *   input was null. The input is never mutated.
 */
export function redactLLMConfig(config) {
	if (!isPlainObject(config)) return null;
	const { apiKey } = config;
	if (!apiKey || typeof apiKey !== "string") return { ...config, apiKey: null };
	const masked = apiKey.length > 8 ? `****${apiKey.slice(-4)}` : "****";
	return { ...config, apiKey: masked };
}
