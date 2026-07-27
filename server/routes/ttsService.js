/**
 * HTTP routes for TTS: which engines exist, what voices they offer, and previews.
 *
 * Everything engine-specific lives in `services/tts/`; this file only translates
 * between HTTP and the adapter contract. It used to hold the ElevenLabs key, the
 * wire format, the chunking rules, and the Socket.IO emission as well — see
 * [ADR 0005](../../docs/decisions/0005-pluggable-tts-with-a-local-server.md).
 */

import { TTS_PROVIDERS, resolveTTSProvider, normalizeProviderId } from "../services/tts/registry.js";

/**
 * Registers the TTS HTTP routes.
 *
 * Routes:
 *   - `GET /api/tts/providers` — which engines exist and which are reachable.
 *   - `GET /api/voices?provider=<id>` — that engine's voices, for the dropdown.
 *   - `GET /api/voice-preview/:id?provider=<id>` — a spoken sample of one voice.
 *
 * @description Voice lists are memoised per provider in a closure rather than a
 *   module global, so two servers in one process do not share a cache and tests do
 *   not have to reset one. An empty list is never cached: a provider that was down
 *   at boot is retried on the next request, which is how a Docker container whose
 *   network came up late recovers without a restart.
 * @param {object} app - Express application instance.
 * @param {{providerDepsFor: Function, availability: object, devMode: boolean, log: Function}} deps
 *   - `providerDepsFor` Receives a provider id, returns that provider's dependency bundle.
 *   - `availability`    Live map of provider id to boolean; mutated by the caller's boot probe.
 *   - `devMode`         When true, previews return 204 and spend nothing.
 * @returns {void}
 */
export function registerTTSRoutes(app, deps) {
	const { providerDepsFor, availability, devMode, log } = deps;

	/** Memoised voice lists, keyed by provider id. Empty results are not cached. */
	const voiceCache = new Map();

	/**
	 * Resolves the provider a request is asking about.
	 *
	 * @description An absent or unusable `provider` falls back to whatever is
	 *   actually available, so an out-of-date client still gets a working answer.
	 *
	 *   When *nothing* is marked available the request is not refused: the boot
	 *   probe runs once, and a provider that started late — the usual case for a
	 *   container whose network was not up yet — must be able to recover without a
	 *   restart. Asking it is the only way to find out, and `voicesFor` promotes it
	 *   back to available if it answers.
	 * @param {object} req - Express request.
	 * @returns {object|null} The adapter to try, or null if the registry is empty.
	 */
	const providerFor = (req) => resolveTTSProvider(normalizeProviderId(req.query.provider, availability))
		|| resolveTTSProvider(req.query.provider)
		|| TTS_PROVIDERS[0]
		|| null;

	/**
	 * Fetches a provider's voices, using the memo when it holds a non-empty list.
	 *
	 * @param {object} provider - The adapter.
	 * @returns {Promise<Array>} The voice list.
	 * @throws {Error} Whatever the adapter throws.
	 */
	const voicesFor = async (provider) => {
		const cached = voiceCache.get(provider.id);
		if (cached?.length) return cached;
		const voices = await provider.listVoices(providerDepsFor(provider.id));
		if (voices.length) {
			voiceCache.set(provider.id, voices);
			// A provider that answers with voices is reachable, whatever the boot
			// probe concluded. Recording that here is what lets a late-starting
			// service recover without a restart.
			if (!availability[provider.id]) {
				availability[provider.id] = true;
				log(`✅ ${provider.label} recovered on retry — voices now available`);
			}
		}
		return voices;
	};

	app.get("/api/tts/providers", (req, res) => {
		res.json({
			ok: true,
			providers: TTS_PROVIDERS.map((p) => ({
				id: p.id,
				label: p.label,
				audioFormat: p.audioFormat,
				available: Boolean(availability[p.id]),
			})),
			// What a lobby with no stored choice will actually narrate with.
			defaultProvider: normalizeProviderId(null, availability),
		});
	});

	app.get("/api/voices", async (req, res) => {
		const provider = providerFor(req);
		if (!provider) {
			return res.json({ ok: false, voices: [], error: "No TTS provider is available" });
		}
		try {
			const voices = await voicesFor(provider);
			if (!voices.length) {
				return res.json({ ok: false, provider: provider.id, voices: [], error: `${provider.label} returned no voices` });
			}
			res.json({ ok: true, provider: provider.id, voices });
		} catch (err) {
			log(`💥 Failed to fetch ${provider.label} voice list: ${err.message}`);
			res.status(500).json({ ok: false, provider: provider.id, voices: [], error: `Failed to fetch voices: ${err.message}` });
		}
	});

	app.get("/api/voice-preview/:id", async (req, res) => {
		if (devMode) {
			return res.status(204).json({ ok: true, message: "Voice preview disabled in developer mode." });
		}
		const provider = providerFor(req);
		if (!provider) return res.status(503).send("No TTS provider is available");

		try {
			const { contentType, body } = await provider.preview(req.params.id, providerDepsFor(provider.id));
			res.setHeader("Content-Type", contentType);
			res.send(body);
		} catch (err) {
			log(`💥 ${provider.label} preview failed for voice ${req.params.id}: ${err.message}`);
			res.status(500).send("Preview unavailable");
		}
	});
}
