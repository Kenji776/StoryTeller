/**
 * Provider registry.
 *
 * The single place that knows which AI providers exist. Socket handlers, the
 * model-listing endpoint, and the browser configuration UI all ask the registry
 * rather than carrying their own list, so adding a provider is a one-file
 * change plus an entry here.
 */

import { normalizeLLMConfig, LLMConfigError } from "./config.js";
import { openaiProvider } from "./providers/openai.js";
import { anthropicProvider } from "./providers/anthropic.js";

/** Every provider StoryTeller can talk to, keyed by id. */
const PROVIDERS = new Map([
	[openaiProvider.id, openaiProvider],
	[anthropicProvider.id, anthropicProvider],
]);

/**
 * @description Looks up a provider adapter by id. Ids are matched
 *   case-insensitively and after trimming, because they can arrive from
 *   hand-edited browser storage.
 * @param {string} id - The provider identifier.
 * @returns {object} The provider descriptor, including its `chat` and
 *   `listModels` functions.
 * @throws {LLMConfigError} When the id is absent, not a string, or unknown.
 */
export function getProvider(id) {
	if (typeof id !== "string" || id.trim() === "") {
		throw new LLMConfigError("No AI provider was specified.", "providerId");
	}
	const provider = PROVIDERS.get(id.trim().toLowerCase());
	if (!provider) {
		const known = [...PROVIDERS.keys()].join(", ");
		throw new LLMConfigError(`Unknown AI provider "${id}". Known providers: ${known}.`, "providerId");
	}
	return provider;
}

/**
 * @description Describes every registered provider for the configuration UI.
 *   The adapter functions are deliberately excluded so the result is plain
 *   JSON: this list is sent to the browser, where functions would be silently
 *   dropped and their presence would only invite misuse.
 * @returns {Array<object>} Fresh descriptor objects, safe to serialise and to mutate.
 */
export function listProviders() {
	return [...PROVIDERS.values()].map(({ id, label, requiresApiKey, requiresBaseUrl, defaultBaseUrl, supportsImages, keyUrl }) => ({
		id,
		label,
		requiresApiKey,
		requiresBaseUrl,
		defaultBaseUrl,
		supportsImages,
		keyUrl: keyUrl ?? null,
	}));
}

/**
 * @description Resolves an untrusted configuration into the provider that will
 *   serve it and a normalized config. This is the entry point for anything
 *   arriving from a browser.
 * @param {object} raw - The untrusted configuration.
 * @returns {{ provider: object, config: object }} The adapter and its validated configuration.
 * @throws {LLMConfigError} When the provider is unknown or the configuration is
 *   invalid; `err.field` names the offending input.
 */
export function resolveLLMConfig(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new LLMConfigError("AI configuration must be an object.", "config");
	}
	const provider = getProvider(raw.providerId);
	const config = normalizeLLMConfig({ ...raw, providerId: provider.id }, provider);
	return { provider, config };
}
