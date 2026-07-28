/**
 * Image provider registry.
 *
 * The single place that knows which image generators exist, mirroring
 * `services/llm/registry.js` and `services/tts/registry.js`. Adding a generator
 * is one file and one line here; the policy layer, the capability view, and the
 * admin console all read from this list rather than carrying their own.
 */

import { localImageProvider } from "./providers/localImageServer.js";
import { openaiImageProvider } from "./providers/openaiImages.js";

/**
 * Every image provider StoryTeller can drive.
 *
 * The local server comes first because it is the one that costs nothing and
 * needs no account, and first is what a UI built from this list will offer as
 * the obvious choice.
 */
export const IMAGE_PROVIDERS = Object.freeze([localImageProvider, openaiImageProvider]);

/** Providers by id, built once. */
const BY_ID = new Map(IMAGE_PROVIDERS.map((provider) => [provider.id, provider]));

/**
 * @description Looks up an image provider by id. Ids are matched case-insensitively
 *   and after trimming, because they arrive from stored configuration and from
 *   hand-edited policy files.
 * @param {string} id - The provider identifier.
 * @returns {object|null} The provider descriptor, or null when unknown.
 */
export function getImageProvider(id) {
	if (typeof id !== "string") return null;
	return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

/**
 * @description Describes every registered provider for the policy layer and the
 *   browser. The adapter functions are deliberately excluded so the result is
 *   plain JSON: functions would be silently dropped in transit, and their
 *   presence would only invite misuse.
 * @returns {Array<object>} Fresh descriptor objects, safe to serialise and mutate.
 */
export function listImageProviders() {
	return IMAGE_PROVIDERS.map(({ id, label, requiresApiKey, requiresBaseUrl, defaultBaseUrl, isLocal, keyUrl, styles }) => ({
		id,
		label,
		requiresApiKey,
		requiresBaseUrl,
		defaultBaseUrl: defaultBaseUrl ?? null,
		isLocal,
		keyUrl: keyUrl ?? null,
		styles: [...(styles ?? [])],
	}));
}
