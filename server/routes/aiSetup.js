/**
 * AI setup — the surface a lobby host uses to get their game playable.
 *
 * Three questions, answered in one place so the settings window, the Start
 * button and the server's own start check cannot disagree:
 *
 * - What can this server do, and what would I have to supply? (`capabilities`)
 * - Is this lobby ready to start, and if not, why? (`readiness`)
 * - Here is my key. (`setCredential`)
 *
 * Everything here is host-gated. A joining player neither supplies nor sees a
 * credential: ADR 0001 made the host's key the one a lobby runs on, and letting
 * anyone else write to that slot would let a player spend the host's money.
 */

import { lobbyReadiness } from "../services/credentials/readiness.js";
import { normalizeLLMConfig, LLMConfigError } from "../services/llm/config.js";

/**
 * The disclosure a host agrees to.
 *
 * Kept here as one string so the server's refusal and the browser's checkbox say
 * the same thing. A host agreeing to something worded differently from what was
 * enforced is the shape of a complaint nobody can answer.
 */
export const CONSENT_TERMS =
	"This key pays for every player in this game, for every call that is not to a local service.";

/**
 * Creates the AI setup surface.
 *
 * @param {object} options - Injected collaborators.
 * @param {object} options.credentials - The assembled credential system.
 * @param {Function} options.isHost - `(lobbyId, socketId)` → boolean.
 * @param {Function} options.emitToLobby - `(lobbyId, event, payload)`.
 * @param {Function} [options.fetchImpl] - Fetch handed to provider adapters.
 * @param {Function} [options.log] - Logger.
 * @returns {object} The handlers, plus `register` and `registerSocket`.
 */
export function createAiSetup({ credentials, isHost, emitToLobby, fetchImpl, log = () => {} }) {
	/**
	 * @description Refusal shaped like every other answer here, so a caller never
	 *   has to tell a thrown error from a returned one.
	 * @param {string} error - What went wrong, in the host's terms.
	 * @param {string|null} [field] - The offending input, for highlighting.
	 * @returns {object} The refusal.
	 */
	const refuse = (error, field = null) => ({ ok: false, error, field });

	/**
	 * @description Describes what this server offers, for the settings window.
	 * @returns {object} The player-facing capability view.
	 */
	function capabilities() {
		return credentials.describeForPlayers();
	}

	/**
	 * @description Reports whether a lobby can start and what each service is doing.
	 * @param {string} lobbyId - The lobby.
	 * @returns {object} The readiness verdict, safe to send to a browser.
	 */
	function readiness(lobbyId) {
		return lobbyReadiness({
			capabilities: credentials.describeForPlayers(),
			session: credentials.sessionKeys.describe(lobbyId),
		});
	}

	/**
	 * @description Pushes the current state to everyone in the lobby, so a second
	 *   browser the host has open does not sit on a stale Start button.
	 * @param {string} lobbyId - The lobby.
	 * @returns {object} What was sent.
	 */
	function broadcast(lobbyId) {
		const state = { ...readiness(lobbyId), held: credentials.sessionKeys.describe(lobbyId) };
		emitToLobby(lobbyId, "ai:state", state);
		return state;
	}

	/**
	 * @description Finds a provider in the player-facing view, which is also the
	 *   check that it is actually offered — the registry knowing a provider is not
	 *   the same as the operator offering it.
	 * @param {string} capability - The capability.
	 * @param {string} providerId - The provider id.
	 * @returns {object|null} The row, or null when it is not on offer.
	 */
	function offeredProvider(capability, providerId) {
		return capabilities()[capability]?.providers.find((p) => p.id === providerId) ?? null;
	}

	return {
		capabilities,
		readiness,

		/**
		 * Stores a host's own credential for one service.
		 *
		 * @description Consent is checked before anything is read from the payload,
		 *   so a submission that was never agreed to cannot even be parsed into a
		 *   config. The key is normalised through the same boundary every other
		 *   credential passes (`CQ-6`), and never appears in the reply.
		 * @param {string} socketId - Who is asking.
		 * @param {object} payload - The submission.
		 * @returns {Promise<object>} `{ok: true, state}` or a refusal.
		 */
		async setCredential(socketId, payload = {}) {
			const { lobbyId, capability, providerId, apiKey, baseUrl, consent, maxCalls, expiresAt } = payload;

			if (!isHost(lobbyId, socketId)) return refuse("Only the game host can set the AI keys for this lobby.");
			if (consent !== true) return refuse(`Please confirm you understand: ${CONSENT_TERMS}`, "consent");

			const provider = offeredProvider(capability, providerId);
			if (!provider) return refuse(`${providerId} is not offered for that service on this server.`, "providerId");
			if (typeof apiKey !== "string" || !apiKey.trim()) return refuse("Enter an API key.", "apiKey");

			let config;
			try {
				config = normalizeLLMConfig(
					{ providerId, apiKey, baseUrl: baseUrl ?? null, model: null },
					{ id: providerId, label: provider.label, requiresApiKey: provider.requiresApiKey, requiresBaseUrl: provider.requiresBaseUrl },
				);
			} catch (err) {
				if (err instanceof LLMConfigError) return refuse(err.message, err.field);
				throw err;
			}

			try {
				credentials.sessionKeys.put(lobbyId, {
					capability, config, ownerSid: socketId, consent: true,
					maxCalls: maxCalls ?? null, expiresAt: expiresAt ?? null,
				});
			} catch (err) {
				// The store's own validation — a limit of zero, an expiry in the past.
				return refuse(err.message);
			}

			log(`🔑 Host supplied their own ${capability} key (${providerId}) for lobby ${lobbyId}`);
			return { ok: true, state: broadcast(lobbyId) };
		},

		/**
		 * @description Withdraws a credential the host supplied.
		 * @param {string} socketId - Who is asking.
		 * @param {object} payload - `{lobbyId, capability}`.
		 * @returns {object} `{ok: true, state}` or a refusal.
		 */
		clearCredential(socketId, { lobbyId, capability } = {}) {
			if (!isHost(lobbyId, socketId)) return refuse("Only the game host can change the AI keys for this lobby.");
			credentials.sessionKeys.dropSecrets(lobbyId, "host-withdrew");
			log(`🔑 Host withdrew their ${capability ?? "AI"} credential for lobby ${lobbyId}`);
			return { ok: true, state: broadcast(lobbyId) };
		},

		/**
		 * Lists the models a service may use.
		 *
		 * @description Two very different paths, and the distinction matters. When
		 *   the operator restricts a shared key to an allowlist, that list *is* the
		 *   answer — asking the provider would spend a call to produce a superset we
		 *   would then have to throw away.
		 *
		 *   Otherwise the credential is resolved and the provider asked. Listing
		 *   deliberately does not go through `sessionKeys.take`: browsing models is
		 *   not playing the game, and charging a host's self-imposed turn budget for
		 *   opening a dropdown would be indefensible.
		 * @param {string} socketId - Who is asking.
		 * @param {object} payload - `{lobbyId, capability, providerId}`.
		 * @returns {Promise<object>} `{ok: true, models}` or a refusal.
		 */
		async listModels(socketId, { lobbyId, capability, providerId } = {}) {
			if (!isHost(lobbyId, socketId)) return refuse("Only the game host can browse models for this lobby.");

			const provider = offeredProvider(capability, providerId);
			if (!provider) return refuse(`${providerId} is not offered for that service on this server.`);

			if (provider.sharedModels?.length) {
				return { ok: true, models: provider.sharedModels.map((id) => ({ id, label: id })) };
			}

			const held = credentials.sessionKeys.describe(lobbyId)?.[capability];
			const adapter = credentials.providerFor(capability, providerId);
			if (!adapter?.listModels) return { ok: true, models: [] };

			// Peeked rather than taken: no budget is spent, and a lobby with no
			// credential at all gets a refusal instead of an empty dropdown it cannot
			// explain.
			let config;
			if (held?.configured && held.providerId === providerId) {
				const peeked = credentials.sessionKeys.peek(lobbyId, capability);
				if (!peeked.ok) return refuse(`Your ${provider.label} key is ${peeked.reason}.`);
				config = peeked.config;
			} else {
				const apiKey = credentials.vault.read(providerId);
				if (!apiKey && provider.requiresApiKey) return refuse(`No ${provider.label} key is available yet.`);
				config = { providerId, apiKey, model: null, baseUrl: adapter.defaultBaseUrl ?? null };
			}

			try {
				return { ok: true, models: await adapter.listModels({ config, fetchImpl }) };
			} catch (err) {
				const message = typeof err?.userMessage === "function" ? err.userMessage() : err?.message ?? String(err);
				return refuse(message);
			}
		},

		/**
		 * @description Mounts the read-only capability endpoint. It is public: a
		 *   player deciding whether to build a character needs to know they will be
		 *   asked for a key, and the view carries nothing sensitive.
		 * @param {object} app - The Express application.
		 * @returns {void}
		 */
		register(app) {
			app.get("/api/capabilities", (req, res) => res.json({ capabilities: capabilities(), consentTerms: CONSENT_TERMS }));
		},

		/**
		 * @description Wires the host-only socket handlers.
		 * @param {object} socket - The connected socket.
		 * @returns {void}
		 */
		registerSocket(socket) {
			socket.on("ai:state:request", ({ lobbyId } = {}) => {
				if (lobbyId) socket.emit("ai:state", { ...readiness(lobbyId), held: credentials.sessionKeys.describe(lobbyId) });
			});
			socket.on("ai:credential:set", async (payload, ack) => {
				const result = await this.setCredential(socket.id, payload);
				if (typeof ack === "function") ack(result);
			});
			socket.on("ai:credential:clear", (payload, ack) => {
				const result = this.clearCredential(socket.id, payload);
				if (typeof ack === "function") ack(result);
			});
			socket.on("ai:models", async (payload, ack) => {
				const result = await this.listModels(socket.id, payload);
				if (typeof ack === "function") ack(result);
			});
		},
	};
}
