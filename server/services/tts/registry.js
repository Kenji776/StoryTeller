/**
 * The only list of which TTS providers exist.
 *
 * Adding an engine means writing one adapter file and adding a line here.
 * Selection policy also lives here: which provider a new lobby gets, and what
 * happens to a lobby whose chosen provider has since gone away.
 */

import { localServerProvider } from "./providers/localServer.js";
import { elevenLabsProvider } from "./providers/elevenLabs.js";

/**
 * Registered adapters, in preference order.
 *
 * Local comes first because it is free and needs no account, which is the
 * default a new lobby should get when it is running
 * ([ADR 0005](../../../docs/decisions/0005-pluggable-tts-with-a-local-server.md)).
 */
export const TTS_PROVIDERS = [localServerProvider, elevenLabsProvider];

/**
 * Looks up an adapter by id.
 *
 * @description The id arrives from persisted lobby state and from the browser, so
 *   it is untrusted: anything unrecognised resolves to null rather than throwing.
 * @param {*} id - A candidate provider id.
 * @returns {object|null} The adapter, or null if the id names no known provider.
 */
export function resolveTTSProvider(id) {
	if (typeof id !== "string" || !id) return null;
	return TTS_PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * Chooses the provider a lobby should get when it has expressed no preference.
 *
 * @description Preference order is the registry's own order, filtered by what is
 *   actually reachable. Local wins when it is up because narration then costs
 *   nothing; ElevenLabs is the fallback when it is not.
 * @param {object} availability - Map of provider id to boolean, from `probeAvailability`.
 * @returns {string|null} A provider id, or null when nothing can speak.
 */
export function pickDefaultProviderId(availability) {
	const map = availability || {};
	return TTS_PROVIDERS.find((p) => map[p.id])?.id || null;
}

/**
 * Resolves an untrusted provider choice into one that will actually work.
 *
 * @description This is the `CQ-6` boundary check for provider selection. A lobby
 *   persisted while the local server was running must still narrate after it is
 *   switched off, so an unavailable choice silently degrades to the default rather
 *   than leaving the lobby mute.
 * @param {*} id - The lobby's stored or requested provider id.
 * @param {object} availability - Map of provider id to boolean.
 * @returns {string|null} A usable provider id, or null when nothing can speak.
 */
export function normalizeProviderId(id, availability) {
	const map = availability || {};
	const provider = resolveTTSProvider(id);
	if (provider && map[provider.id]) return provider.id;
	return pickDefaultProviderId(map);
}

/**
 * Asks every provider whether it can be used right now.
 *
 * @description Run once at boot and again when a route needs to retry a provider
 *   that was down at startup. Providers are probed concurrently because a probe is
 *   a network round trip and an unreachable one waits for its own timeout.
 * @param {{providers?: Array, depsFor: Function}} opts
 *   - `providers` Adapters to probe; defaults to the whole registry.
 *   - `depsFor`   Receives a provider id, returns that provider's dependency bundle.
 * @returns {Promise<object>} Map of provider id to boolean.
 */
export async function probeAvailability({ providers = TTS_PROVIDERS, depsFor }) {
	const verdicts = await Promise.all(providers.map(async (p) => {
		try {
			return [p.id, Boolean(await p.isAvailable(depsFor(p.id)))];
		} catch {
			// isAvailable is contracted not to throw, but boot must survive one that does.
			return [p.id, false];
		}
	}));
	return Object.fromEntries(verdicts);
}
