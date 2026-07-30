/**
 * Provider administration — the operator's control surface for credentials.
 *
 * Everything here is gated on a **password admin session and nothing else**. The
 * admin console also issues lobby-scoped host tokens, and a host is emphatically
 * not an operator: they run one game, not the instance, and must never reach the
 * keys that pay for every game. `client/admin/core/capabilities.js` decides what
 * is *drawn* and is not a security boundary; this file is.
 *
 * The second rule is that a key travels in one direction. It arrives in a request
 * body and is never in a response — every handler answers with the vault's
 * metadata view (`configured`, `last4`, `status`) instead.
 */

import { validatePrivateServiceUrl } from "../services/net/privateUrl.js";
import { PolicyError } from "../services/credentials/policy.js";

/** How an operator is told what each capability's local service is called. */
const SERVICE_NAMES = Object.freeze({
	chat: "model server",
	speech: "speech server",
	image: "image server",
});

/**
 * How to prove a provider actually works, per capability.
 *
 * The three registries disagree about their probe signatures: chat and image
 * adapters take `{config, fetchImpl}`, while the TTS adapters predate the
 * credential layer entirely and take a bundle of loose environment values. The
 * adaptation is here, in one visible place, rather than being smeared across the
 * caller — and it is a wart that should be closed by giving the TTS adapters the
 * same shape as the other two.
 */
const TESTERS = Object.freeze({
	/**
	 * @description Proves a chat credential by listing models with it.
	 * @param {object} provider - The adapter.
	 * @param {object} config - The resolved configuration.
	 * @param {Function} fetchImpl - Injected fetch.
	 * @returns {Promise<void>} Resolves when the credential worked.
	 */
	chat: async (provider, config, fetchImpl) => {
		await provider.listModels({ config, fetchImpl });
	},

	/**
	 * @description Proves an image credential by probing the provider.
	 * @param {object} provider - The adapter.
	 * @param {object} config - The resolved configuration.
	 * @param {Function} fetchImpl - Injected fetch.
	 * @returns {Promise<void>} Resolves when the provider answered.
	 * @throws {Error} When the provider did not answer.
	 */
	image: async (provider, config, fetchImpl) => {
		if (!(await provider.probe({ config, fetchImpl }))) {
			throw new Error(`${provider.label} did not answer.`);
		}
	},

	/**
	 * @description Proves a speech credential, translating the resolved config
	 *   into the loose deps bundle the TTS adapters still expect.
	 * @param {object} provider - The adapter.
	 * @param {object} config - The resolved configuration.
	 * @param {Function} fetchImpl - Injected fetch.
	 * @returns {Promise<void>} Resolves when the provider answered.
	 * @throws {Error} When the provider did not answer.
	 */
	speech: async (provider, config, fetchImpl) => {
		const deps = provider.isLocal
			? { LOCAL_TTS_URL: config.baseUrl, fetchImpl }
			: { ELEVEN_API_KEY: config.apiKey, fetchImpl };
		if (!(await provider.isAvailable(deps))) {
			throw new Error(`${provider.label} did not answer.`);
		}
	},
});

/**
 * Builds the provider administration handlers.
 *
 * @description Handlers are returned individually as well as registered, so they
 *   can be exercised with plain request and response doubles rather than through
 *   an HTTP server (`TDD-8`).
 * @param {object} options - Injected collaborators.
 * @param {object} options.credentials - The assembled credential system.
 * @param {Function} options.isAdminAuthenticated - Predicate over a request.
 * @param {Function} [options.lookup] - DNS resolver for the private-network guard.
 * @param {Function} [options.fetchImpl] - Fetch used when testing a provider.
 * @param {Function} [options.log] - Logger.
 * @returns {object} The handlers plus a `register(app)`.
 */
export function createProviderAdminRoutes({ credentials, isAdminAuthenticated, lookup, fetchImpl, characterKeys = null, log = () => {} }) {
	/**
	 * @description Rejects anything without a password admin session. Deliberately
	 *   does not consult the host-token check: there is no version of this surface
	 *   a lobby host should reach, so the check is absent rather than negated.
	 * @param {object} req - The request.
	 * @param {object} res - The response.
	 * @returns {boolean} True when the caller may proceed.
	 */
	function requireAdmin(req, res) {
		if (isAdminAuthenticated(req)) return true;
		res.status(401).json({ error: "Provider configuration requires an administrator session." });
		return false;
	}

	/**
	 * @description Resolves the capability and provider a route is addressing,
	 *   answering 404 when either is unknown.
	 * @param {object} req - The request.
	 * @param {object} res - The response.
	 * @returns {{capability: string, providerId: string, provider: object}|null}
	 *   The target, or null when a response has already been sent.
	 */
	function resolveTarget(req, res) {
		const capability = String(req.params?.capability ?? "");
		const providerId = String(req.params?.providerId ?? "");
		const provider = credentials.providerFor(capability, providerId);
		if (!provider) {
			res.status(404).json({ error: `No ${capability || "capability"} provider called "${providerId}".` });
			return null;
		}
		return { capability, providerId, provider };
	}

	/**
	 * @description Finds one provider's row in the operator view, which is the
	 *   shape every mutating handler answers with.
	 * @param {string} capability - The capability.
	 * @param {string} providerId - The provider id.
	 * @returns {object|null} The row.
	 */
	function describeOne(capability, providerId) {
		return credentials.describe()[capability]?.providers.find((p) => p.id === providerId) ?? null;
	}

	return {
		/**
		 * @description Describes every provider of every capability, for the console.
		 * @param {object} req - The request.
		 * @param {object} res - The response.
		 * @returns {Promise<void>} Resolves once answered.
		 */
		async list(req, res) {
			if (!requireAdmin(req, res)) return;
			res.status(200).json({ capabilities: credentials.describe() });
		},

		/**
		 * @description Stores an operator key for one provider.
		 * @param {object} req - The request, with `apiKey` in the body.
		 * @param {object} res - The response.
		 * @returns {Promise<void>} Resolves once answered.
		 */
		async setKey(req, res) {
			if (!requireAdmin(req, res)) return;
			const target = resolveTarget(req, res);
			if (!target) return;

			const apiKey = req.body?.apiKey;
			if (typeof apiKey !== "string" || !apiKey.trim()) {
				res.status(400).json({ error: "Enter an API key.", field: "apiKey" });
				return;
			}

			credentials.vault.set(target.providerId, apiKey);
			log(`🔑 Operator stored an API key for ${target.providerId}`);
			res.status(200).json({ ok: true, provider: describeOne(target.capability, target.providerId) });
		},

		/**
		 * @description Forgets the operator key for one provider.
		 * @param {object} req - The request.
		 * @param {object} res - The response.
		 * @returns {Promise<void>} Resolves once answered.
		 */
		async clearKey(req, res) {
			if (!requireAdmin(req, res)) return;
			const target = resolveTarget(req, res);
			if (!target) return;

			const removed = credentials.vault.clear(target.providerId);
			if (removed) log(`🔑 Operator cleared the API key for ${target.providerId}`);
			res.status(200).json({ ok: true, removed, provider: describeOne(target.capability, target.providerId) });
		},

		/**
		 * Saves one provider's policy, merged into the current document.
		 *
		 * @description A local provider's address is resolved and required to land
		 *   on a private network before it is stored. The server dials that address,
		 *   so an unvalidated one is a server-side request forgery vector — and for
		 *   the image server, which has no authentication of its own, the stakes are
		 *   higher than anywhere else in the system.
		 *
		 *   The guard runs only for a `local` policy. On any other policy the address
		 *   is discarded by the policy model anyway, and refusing the save over a
		 *   field about to be dropped would be a confusing failure.
		 * @param {object} req - The request, carrying the policy entry in its body.
		 * @param {object} res - The response.
		 * @returns {Promise<void>} Resolves once answered.
		 */
		async setPolicy(req, res) {
			if (!requireAdmin(req, res)) return;
			const target = resolveTarget(req, res);
			if (!target) return;

			const { policy, sharedModels, maxCallsPerLobby, baseUrl } = req.body ?? {};
			const entry = { policy, sharedModels, maxCallsPerLobby, baseUrl };

			if (policy === "local" && typeof baseUrl === "string" && baseUrl.trim()) {
				try {
					entry.baseUrl = await validatePrivateServiceUrl(baseUrl, {
						lookup,
						serviceName: `${target.provider.label} ${SERVICE_NAMES[target.capability] ?? "service"}`,
					});
				} catch (err) {
					res.status(400).json({ error: err.message, field: `${target.capability}.${target.providerId}.baseUrl` });
					return;
				}
			}

			const current = credentials.getPolicy();
			const next = {
				...current,
				[target.capability]: { ...current[target.capability], [target.providerId]: entry },
			};

			try {
				credentials.setPolicy(next);
			} catch (err) {
				if (err instanceof PolicyError) {
					res.status(400).json({ error: err.message, field: err.field });
					return;
				}
				throw err;
			}

			log(`⚙️  Operator set ${target.capability}/${target.providerId} to "${policy}"`);
			res.status(200).json({ ok: true, provider: describeOne(target.capability, target.providerId) });
		},

		/**
		 * Tests a provider against its real endpoint and records the outcome.
		 *
		 * @description The credential comes from the vault or, for a local service,
		 *   from the policy's address — deliberately not from the request, so this
		 *   cannot be used to probe arbitrary keys through the server.
		 * @param {object} req - The request.
		 * @param {object} res - The response.
		 * @returns {Promise<void>} Resolves once answered.
		 */
		async testProvider(req, res) {
			if (!requireAdmin(req, res)) return;
			const target = resolveTarget(req, res);
			if (!target) return;

			const { capability, providerId, provider } = target;
			const entry = credentials.getPolicy()[capability]?.[providerId] ?? {};
			const apiKey = credentials.vault.read(providerId);

			if (provider.requiresApiKey && !apiKey) {
				res.status(400).json({ error: `Add an API key for ${provider.label} before testing it.` });
				return;
			}

			const config = {
				providerId,
				apiKey,
				model: null,
				baseUrl: entry.baseUrl ?? provider.defaultBaseUrl ?? null,
			};

			try {
				await TESTERS[capability](provider, config, fetchImpl);
				credentials.vault.recordValidation(providerId, { ok: true });
				res.status(200).json({ ok: true, provider: describeOne(capability, providerId) });
			} catch (err) {
				credentials.vault.recordValidation(providerId, { ok: false });
				// `userMessage` scrubs token-shaped substrings, which matters because
				// provider error bodies sometimes echo the submitted key back.
				const message = typeof err?.userMessage === "function" ? err.userMessage() : err?.message ?? String(err);
				res.status(200).json({ ok: false, error: message, provider: describeOne(capability, providerId) });
			}
		},

		/**
		 * @description Reports which character signing key is in force, by fingerprint. Enough for an
		 *   operator to confirm a rotation took effect, and useless to anyone who intercepts it.
		 * @param {object} req - The request.
		 * @param {object} res - The response.
		 * @returns {void}
		 */
		characterKey(req, res) {
			if (!requireAdmin(req, res)) return;
			if (!characterKeys) return res.status(501).json({ error: "Character signing keys are not configured on this server." });
			res.status(200).json({ fingerprint: characterKeys.fingerprint() });
		},

		/**
		 * Replaces the character signing key.
		 *
		 * @description Operator-only, for the same reason as everything else here: a lobby host runs
		 *   one game, and this invalidates every exported character on the whole instance. Gated by
		 *   `requireAdmin`, which consults password sessions and never host tokens.
		 *
		 *   The response carries fingerprints and nothing else — key material travels in one
		 *   direction on this surface, and this route has no reason to be the exception.
		 * @param {object} req - The request.
		 * @param {object} res - The response.
		 * @returns {void}
		 */
		rotateCharacterKey(req, res) {
			if (!requireAdmin(req, res)) return;
			if (!characterKeys) return res.status(501).json({ error: "Character signing keys are not configured on this server." });

			const { previous, current } = characterKeys.rotate();
			log(`🔑 Character signing key rotated by an operator (${previous} → ${current})`);
			res.status(200).json({
				previous,
				current,
				// Said here as well as in the UI, so it lands in the operator's logs too.
				consequence: "Character files exported before now will no longer import, and a host holding one "
					+ "must export again to reach the DM tools. Games in progress are unaffected.",
			});
		},

		/**
		 * @description Mounts every handler on the Express app.
		 * @param {object} app - The Express application.
		 * @returns {void}
		 */
		register(app) {
			const base = "/api/admin/providers";
			app.get(base, (req, res) => this.list(req, res));
			app.put(`${base}/:capability/:providerId/key`, (req, res) => this.setKey(req, res));
			app.delete(`${base}/:capability/:providerId/key`, (req, res) => this.clearKey(req, res));
			app.put(`${base}/:capability/:providerId/policy`, (req, res) => this.setPolicy(req, res));
			app.post(`${base}/:capability/:providerId/test`, (req, res) => this.testProvider(req, res));
			// Not a provider, but the same audience and the same gate: an instance secret only the
			// operator may touch.
			app.get("/api/admin/character-key", (req, res) => this.characterKey(req, res));
			app.post("/api/admin/character-key/rotate", (req, res) => this.rotateCharacterKey(req, res));
		},
	};
}
