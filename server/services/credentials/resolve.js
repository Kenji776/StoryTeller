/**
 * Credential resolution — the one place that decides whose key pays for a call.
 *
 * Everything upstream of here just names a lobby, a capability and a provider;
 * everything downstream receives a configuration an adapter can use, or a typed
 * refusal explaining what the person at the keyboard has to do about it.
 *
 * The order is fixed and worth stating: **the host's own key first, the
 * instance's shared key second, a local service third, and a refusal last.** A
 * host who supplied a credential is spending their own money by choice, so it
 * would be wrong to quietly bill the operator instead — and equally wrong to
 * reach for the host's key when the operator is offering theirs for free without
 * the host having supplied one.
 *
 * A refusal is not a failure of the game. `CredentialRequiredError` is the signal
 * to pause the lobby and show the host what is missing, in the same way ADR 0003
 * pauses when the host is absent, and deliberately not something the DM narrates
 * (ADR 0009).
 *
 * The module knows nothing about which registries exist: `providerFor` is
 * injected, so chat, speech and image resolution all run through this one path
 * without it importing three registries (CQ-4, CQ-5).
 */

import { policyFor } from "./policy.js";

/**
 * @description Raised when a call cannot be paid for. Carries enough structure
 *   for the UI to act — which capability, which provider, and why — rather than
 *   a string the client would have to parse.
 */
export class CredentialRequiredError extends Error {
	/**
	 * @description Constructs a credential refusal.
	 * @param {string} message - Operator-facing explanation, for logs.
	 * @param {object} details - Structured context.
	 * @param {string} details.capability - The capability that could not be served.
	 * @param {string} details.providerId - The provider that was asked for.
	 * @param {string} details.reason - Machine-readable cause; see `REASONS`.
	 * @param {string} [details.providerLabel] - Human-readable provider name.
	 * @param {string[]} [details.allowedModels] - Models the shared key permits,
	 *   when the refusal was `model_not_shared`.
	 * @returns {CredentialRequiredError} The constructed error.
	 */
	constructor(message, { capability, providerId, reason, providerLabel = null, allowedModels = null }) {
		super(message);
		this.name = "CredentialRequiredError";
		this.capability = capability;
		this.providerId = providerId;
		this.reason = reason;
		this.providerLabel = providerLabel;
		this.allowedModels = allowedModels;
	}

	/**
	 * Player-facing copy naming the provider and the corrective action.
	 *
	 * @description Every branch names something the reader can actually do. A
	 *   message is only useful to the person who can fix it, and for most of these
	 *   that person is the host rather than the operator.
	 *
	 *   No branch interpolates a credential, and a test holds that true across
	 *   every reason (STY-3).
	 * @returns {string} The message to show.
	 */
	userMessage() {
		const name = this.providerLabel || this.providerId;
		switch (this.reason) {
			case "byok":
				return `This server does not provide ${name} access. Add your own ${name} API key in Settings to start the game.`;
			case "off":
				return `${name} is not available on this server. Choose a different provider in Settings.`;
			case "expired":
				return `Your ${name} key has expired and been removed. Enter a new one in Settings to continue.`;
			case "exhausted":
				return `Your ${name} key has reached the call limit you set for this game. Raise the limit or supply a new key in Settings.`;
			case "shared_cap_reached":
				return `This game has used its share of the server's ${name} allowance. Add your own ${name} key in Settings to keep playing.`;
			case "model_not_shared":
				return this.allowedModels?.length
					? `The server shares its ${name} key only for: ${this.allowedModels.join(", ")}. Choose one of those, or add your own key in Settings.`
					: `The server does not share its ${name} key for that model. Choose another, or add your own key in Settings.`;
			case "no_server_key":
				return `${name} is set up to use this server's key, but none has been configured. The server operator needs to add one.`;
			case "no_base_url":
				return `${name} has no address configured, so there is nothing to connect to. The server operator needs to set one.`;
			case "unknown_provider":
				return `${name} is not a provider this server knows about. Choose a different one in Settings.`;
			default:
				return `${name} is unavailable. Check your settings, or choose a different provider.`;
		}
	}
}

/**
 * Creates the credential resolver.
 *
 * @param {object} options - Injected collaborators.
 * @param {object} options.vault - The operator credential vault; only `read` is used.
 * @param {Function} options.getPolicy - Returns the current normalized policy
 *   document. A getter rather than a value, so an admin editing the policy takes
 *   effect on the next call instead of needing the resolver rebuilt.
 * @param {object} options.sessionKeys - The per-lobby credential store.
 * @param {Function} options.providerFor - `(capability, providerId)` → provider
 *   descriptor or null. Injected so this module imports no registry.
 * @returns {{resolve: Function}} The resolver.
 */
export function createResolver({ vault, getPolicy, sessionKeys, providerFor }) {
	/**
	 * Decides whose credential serves one call, and records the spend.
	 *
	 * @param {object} request - What is being asked for.
	 * @param {string} request.lobbyId - The lobby making the call.
	 * @param {string} request.capability - `chat`, `speech`, or `image`.
	 * @param {string} request.providerId - The provider the lobby is configured for.
	 * @param {string|null} [request.model] - The model the lobby has chosen.
	 * @returns {{source: string, config: object, providerLabel: string}} The
	 *   credential to use and where it came from: `host`, `server`, or `local`.
	 * @throws {CredentialRequiredError} When no credential can serve the call.
	 */
	function resolve({ lobbyId, capability, providerId, model = null }) {
		const provider = providerFor(capability, providerId);
		if (!provider) {
			throw new CredentialRequiredError(
				`No ${capability} provider is registered under "${providerId}".`,
				{ capability, providerId, reason: "unknown_provider" },
			);
		}
		const label = provider.label || provider.id;

		/**
		 * @description Builds a refusal already carrying the provider's identity.
		 * @param {string} reason - The machine-readable cause.
		 * @param {string} message - The operator-facing explanation.
		 * @param {string[]|null} [allowedModels] - Permitted models, when relevant.
		 * @returns {CredentialRequiredError} The error to throw.
		 */
		const refuse = (reason, message, allowedModels = null) => new CredentialRequiredError(
			message,
			{ capability, providerId, reason, providerLabel: label, allowedModels },
		);

		// ── 1. The host's own key ────────────────────────────────────────────
		// Matched on provider as well as presence: a host holding an Anthropic key
		// must never have it sent to OpenAI because the lobby switched providers.
		const held = sessionKeys.describe(lobbyId)?.[capability];
		if (held?.configured && held.providerId === providerId) {
			const taken = sessionKeys.take(lobbyId, capability);
			if (taken.ok) {
				return {
					source: "host",
					providerLabel: label,
					config: {
						providerId,
						apiKey: taken.config.apiKey,
						// The lobby's current choice wins over whatever was stored when
						// the key was supplied; the host may have changed model since.
						model: model ?? taken.config.model ?? null,
						baseUrl: taken.config.baseUrl ?? provider.defaultBaseUrl ?? null,
					},
				};
			}
			// Expired or exhausted. Falling through to the operator's key would
			// silently move the bill to someone who did not agree to pay it.
			throw refuse(taken.reason, `The host's ${label} credential for lobby ${lobbyId} is ${taken.reason}.`);
		}

		// ── 2. What the operator permits ─────────────────────────────────────
		const entry = policyFor(getPolicy(), capability, providerId);

		if (entry.policy === "local") {
			const baseUrl = entry.baseUrl ?? provider.defaultBaseUrl ?? null;
			if (!baseUrl) {
				throw refuse("no_base_url", `${label} is configured as a local service but has no address.`);
			}
			return { source: "local", providerLabel: label, config: { providerId, apiKey: null, model, baseUrl } };
		}

		if (entry.policy === "shared") {
			// Checked before the key is read, so a refusal never touches key material.
			if (entry.sharedModels && !(model && entry.sharedModels.includes(model))) {
				throw refuse(
					"model_not_shared",
					`The shared ${label} key is restricted to ${entry.sharedModels.join(", ")}; ${model ?? "no model"} was requested.`,
					entry.sharedModels,
				);
			}
			if (entry.maxCallsPerLobby !== null && sessionKeys.sharedUse(lobbyId, capability, providerId) >= entry.maxCallsPerLobby) {
				throw refuse("shared_cap_reached", `Lobby ${lobbyId} has spent its ${entry.maxCallsPerLobby}-call share of the ${label} key.`);
			}

			const apiKey = vault.read(providerId);
			if (!apiKey) {
				throw refuse("no_server_key", `${label} is set to share this server's key, but the vault holds none.`);
			}

			sessionKeys.countSharedUse(lobbyId, capability, providerId);
			return {
				source: "server",
				providerLabel: label,
				config: { providerId, apiKey, model, baseUrl: provider.defaultBaseUrl ?? null },
			};
		}

		if (entry.policy === "byok") {
			throw refuse("byok", `${label} requires a player-supplied key and lobby ${lobbyId} has none.`);
		}

		throw refuse("off", `${label} is not offered for ${capability} on this server.`);
	}

	return { resolve };
}
