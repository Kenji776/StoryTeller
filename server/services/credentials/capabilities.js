/**
 * What this instance can actually do, described for the two audiences that ask.
 *
 * A player needs to know what they can pick and what they must supply. An
 * operator needs to know what exists and what to change. Those are different
 * questions and they get different answers here, which is the point of the module
 * — one shared builder producing one shape would inevitably leak vault detail
 * into the player's view or omit the controls from the operator's.
 *
 * | | Player | Operator |
 * |---|---|---|
 * | Providers switched off | omitted | listed, because that is the control |
 * | Vault metadata | never | `configured`, `last4`, `status` |
 * | Policy knobs | the shared-model restriction only | all of them |
 *
 * The registry is the source of truth for what exists: a policy naming a provider
 * with no adapter is ignored rather than offered. Both builders are pure — plain
 * data in, plain data out — so neither can reach a key it was not handed.
 */

import { CAPABILITIES, policyFor } from "./policy.js";

/**
 * @description Reads the live reachability of a provider, if anything has probed it.
 * @param {object} availability - Capability → provider id → boolean.
 * @param {string} capability - The capability.
 * @param {string} providerId - The provider.
 * @returns {boolean|null} True, false, or null when nothing has probed it yet.
 */
function reachabilityOf(availability, capability, providerId) {
	const known = availability?.[capability]?.[providerId];
	return typeof known === "boolean" ? known : null;
}

/**
 * Decides whether a provider can serve a game right now with nobody supplying anything.
 *
 * @description An unprobed local service counts as ready. Reporting it broken
 *   because a boot probe has not finished would show "no AI available" on a fresh
 *   start, which is both wrong and the most alarming possible first impression;
 *   readiness is withheld only when we actually know it is unreachable.
 * @param {string} policy - The provider's policy.
 * @param {boolean} hasServerKey - Whether the vault holds a key for it.
 * @param {boolean|null} reachable - Live reachability, or null when unprobed.
 * @returns {boolean} True when the provider needs nothing from the player.
 */
function isReady(policy, hasServerKey, reachable) {
	if (reachable === false) return false;
	if (policy === "local") return true;
	if (policy === "shared") return hasServerKey;
	return false;
}

/**
 * @description Walks every registered provider of every capability, pairing it
 *   with its policy, so both builders share one traversal and cannot drift.
 * @param {object} args - The inputs both builders take.
 * @param {Function} shape - `(provider, entry, context)` → the output entry, or
 *   null to omit it.
 * @returns {object} Capability → `{providers, anyUsableWithoutPlayerKey}`.
 */
function build({ providers = {}, policy, vault, availability = {} }, shape) {
	const out = {};

	for (const capability of CAPABILITIES) {
		const registered = Array.isArray(providers[capability]) ? providers[capability] : [];
		const rows = [];
		let anyReady = false;

		for (const provider of registered) {
			const entry = policyFor(policy, capability, provider.id);
			const hasServerKey = Boolean(vault?.has?.(provider.id));
			const reachable = reachabilityOf(availability, capability, provider.id);
			const ready = isReady(entry.policy, hasServerKey, reachable);
			if (ready) anyReady = true;

			const row = shape(provider, entry, { capability, hasServerKey, reachable, ready, vault });
			if (row) rows.push(row);
		}

		out[capability] = { providers: rows, anyUsableWithoutPlayerKey: anyReady };
	}

	return out;
}

/**
 * Describes the instance to a player choosing how to run their game.
 *
 * @description Providers that are switched off are omitted entirely — offering
 *   something unpickable only invites the question of why it is there. Nothing
 *   from the vault appears in this shape at all, not even whether a key was
 *   validated; `ready` already carries everything a player can act on.
 * @param {object} args - The instance's state.
 * @param {object} args.providers - Capability → registry descriptors.
 * @param {object} args.policy - A normalized policy document.
 * @param {object} args.vault - The operator vault; only `has` is consulted.
 * @param {object} [args.availability] - Capability → provider id → reachable.
 * @returns {object} Capability → `{providers, anyUsableWithoutPlayerKey}`.
 */
export function publicCapabilities(args) {
	return build(args, (provider, entry, { reachable, ready }) => {
		if (entry.policy === "off") return null;
		return {
			id: provider.id,
			label: provider.label,
			needsPlayerKey: entry.policy === "byok",
			requiresApiKey: Boolean(provider.requiresApiKey),
			requiresBaseUrl: Boolean(provider.requiresBaseUrl),
			keyUrl: provider.keyUrl ?? null,
			sharedModels: entry.sharedModels,
			reachable,
			ready,
		};
	});
}

/**
 * Describes the instance to the operator configuring it.
 *
 * @description Every registered provider appears, including those switched off
 *   and those with no policy yet, because this view *is* the control surface and
 *   a provider you cannot see is one you cannot turn on. Vault metadata is
 *   included but never key material: `last4` identifies which key is in place,
 *   which is the most that may leave the server (ADR 0013).
 * @param {object} args - The instance's state.
 * @param {object} args.providers - Capability → registry descriptors.
 * @param {object} args.policy - A normalized policy document.
 * @param {object} args.vault - The operator vault; `has` and `describe` are used.
 * @param {object} [args.availability] - Capability → provider id → reachable.
 * @returns {object} Capability → `{providers, anyUsableWithoutPlayerKey}`.
 */
export function adminCapabilities(args) {
	const described = args.vault?.describe?.() ?? {};

	return build(args, (provider, entry, { reachable, ready }) => {
		const record = described[provider.id];
		return {
			id: provider.id,
			label: provider.label,
			policy: entry.policy,
			requiresApiKey: Boolean(provider.requiresApiKey),
			requiresBaseUrl: Boolean(provider.requiresBaseUrl),
			defaultBaseUrl: provider.defaultBaseUrl ?? null,
			keyUrl: provider.keyUrl ?? null,
			sharedModels: entry.sharedModels,
			maxCallsPerLobby: entry.maxCallsPerLobby,
			baseUrl: entry.baseUrl,
			reachable,
			ready,
			key: {
				configured: Boolean(record?.configured),
				last4: record?.last4 ?? null,
				status: record?.status ?? null,
				lastValidated: record?.lastValidated ?? null,
			},
		};
	});
}
