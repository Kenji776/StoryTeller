/**
 * LLM request errors.
 *
 * Once players supply their own keys, an AI failure stops being an operator
 * problem and becomes a player problem: they are the only one who can fix a
 * rejected key or an exhausted quota. These errors carry enough structure for
 * the game loop to decide whether to retry and for the UI to tell the player
 * what to do, without ever echoing the key itself back to the screen.
 */

/** HTTP statuses with a more specific meaning than "it failed". */
const KIND_BY_STATUS = {
	400: "bad_request",
	401: "auth",
	402: "quota",
	403: "auth",
	404: "not_found",
	422: "bad_request",
	429: "rate_limit",
};

/** Failure kinds where trying the same request again may succeed. */
const RETRYABLE_KINDS = new Set(["rate_limit", "server", "network"]);

/** Display names for provider ids, used in player-facing copy. */
const PROVIDER_LABELS = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google Gemini",
	ollama: "Ollama",
	"openai-compatible": "the custom endpoint",
	test: "the test provider",
};

/**
 * @description Removes token-shaped substrings from provider error text.
 *   Provider error bodies sometimes echo the submitted credential back, and
 *   that text can reach a player's screen or a log file (STY-3).
 * @param {string} text - Raw provider error text.
 * @returns {string} The text with long unbroken tokens replaced by "***".
 */
function scrubTokens(text) {
	return String(text ?? "").replace(/\S{20,}/g, "***");
}

/**
 * @description Maps an HTTP status onto a coarse failure kind.
 * @param {number|null} status - The HTTP status of a failed response.
 * @returns {string} One of "bad_request", "auth", "quota", "not_found",
 *   "rate_limit", "server", or "unknown".
 */
export function classifyHttpStatus(status) {
	if (!Number.isFinite(status)) return "unknown";
	if (KIND_BY_STATUS[status]) return KIND_BY_STATUS[status];
	if (status >= 500 && status <= 599) return "server";
	return "unknown";
}

/**
 * @description Error raised when a call to an AI provider fails. Attribution to
 *   a specific provider is mandatory because a lobby may have a chat provider
 *   and a separate image provider configured at once.
 */
export class LLMRequestError extends Error {
	/**
	 * @description Constructs a provider request error.
	 * @param {string} message - The underlying failure text, often from the provider.
	 * @param {object} options - Error metadata.
	 * @param {string} options.provider - The provider id that failed. Required.
	 * @param {number|null} [options.status=null] - HTTP status, when there was a response.
	 * @param {string|null} [options.kind=null] - Explicit failure kind; derived
	 *   from `status` when omitted.
	 * @param {Error|null} [options.cause=null] - The underlying error, if any.
	 * @returns {LLMRequestError} The constructed error.
	 * @throws {Error} When no provider is supplied.
	 */
	constructor(message, { provider, status = null, kind = null, cause = null } = {}) {
		super(message, cause ? { cause } : undefined);
		if (!provider) throw new Error("LLMRequestError requires a provider id for attribution.");
		this.name = "LLMRequestError";
		this.provider = provider;
		this.status = status;
		this.kind = kind || classifyHttpStatus(status);
		if (cause) this.cause = cause;
	}

	/**
	 * @description Whether retrying the identical request could plausibly succeed.
	 * @returns {boolean} True for transient failures, false for ones the player must fix.
	 */
	get retryable() {
		return RETRYABLE_KINDS.has(this.kind);
	}

	/**
	 * @description Renders a player-facing explanation of the failure, naming
	 *   the provider and the corrective action where one exists.
	 * @returns {string} A message safe to display in the UI.
	 */
	userMessage() {
		const label = PROVIDER_LABELS[this.provider] || this.provider;
		switch (this.kind) {
			case "auth":
				return `${label} rejected the API key. Check the key in AI Settings and try again.`;
			case "quota":
				return `${label} reports this API key is out of credit or has exhausted its quota.`;
			case "rate_limit":
				return `${label} is receiving too many requests from this key. Wait a moment and try again.`;
			case "not_found":
				return `${label} does not recognise that model or endpoint. Pick a different model in AI Settings.`;
			case "network":
				return `Could not reach ${label} at the configured address. Check that it is running and reachable.`;
			case "server":
				return `${label} is having server trouble right now. This is usually temporary.`;
			case "bad_request":
				return `${label} rejected the request: ${scrubTokens(this.message)}`;
			default:
				return scrubTokens(this.message);
		}
	}
}
