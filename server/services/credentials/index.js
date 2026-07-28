/**
 * The credential system, assembled.
 *
 * Five pieces have to know about each other — the vault, the policy document, the
 * per-lobby store, the resolver, and the capability views — and each of them is
 * deliberately ignorant of the registries so it can be tested without one. This
 * module is where that ignorance is paid for: it is the only place that knows
 * chat comes from `services/llm/`, speech from `services/tts/`, and images from
 * `services/images/`, and it hands `server.js` one object instead of six.
 *
 * It also performs the one-time import of keys already sitting in the
 * environment, so upgrading an existing install does not silently withdraw the
 * access it already had.
 */

import path from "path";
import fsDefault from "fs";

import { createVault } from "./vault.js";
import { createPolicyStore, defaultPolicyDocument, normalizePolicyDocument } from "./policy.js";
import { createSessionKeys } from "./sessionKeys.js";
import { createResolver } from "./resolve.js";
import { publicCapabilities, adminCapabilities } from "./capabilities.js";

import { listProviders as listChatProviders, getProvider as getChatProvider } from "../llm/registry.js";
import { TTS_PROVIDERS, resolveTTSProvider } from "../tts/registry.js";
import { listImageProviders, getImageProvider } from "../images/registry.js";

/** File names under the data directory. */
const VAULT_FILE = "credentials.enc";
const POLICY_FILE = "provider-policy.json";

/**
 * Environment variables an existing install may already carry, and the provider
 * each belongs to.
 *
 * `CLAUDE_API_KEY` is the legacy name: the old service called the provider
 * "claude" and the registry calls it "anthropic", so the import is also the
 * rename. Both spellings are accepted because a running deployment has the old one.
 */
const ENV_KEYS = Object.freeze([
	{ providerId: "openai", vars: ["OPENAI_API_KEY"] },
	{ providerId: "anthropic", vars: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] },
	{ providerId: "elevenlabs", vars: ["ELEVENLABS_API_KEY", "ELEVEN_API_KEY"] },
]);

/**
 * @description Strips the adapter functions off a TTS descriptor, which — unlike
 *   the other two registries — has no `list` function of its own that already
 *   does this. Everything sent to a browser has to be plain JSON.
 * @returns {Array<object>} Serialisable speech provider descriptors.
 */
function listSpeechProviders() {
	return TTS_PROVIDERS.map(({ id, label, requiresApiKey, requiresBaseUrl, defaultBaseUrl, isLocal, keyUrl }) => ({
		id,
		label,
		requiresApiKey: Boolean(requiresApiKey),
		requiresBaseUrl: Boolean(requiresBaseUrl),
		defaultBaseUrl: defaultBaseUrl ?? null,
		isLocal: Boolean(isLocal),
		keyUrl: keyUrl ?? null,
	}));
}

/**
 * @description Resolves a chat provider without the registry's habit of throwing.
 *   Callers here are asking "does this exist", and an exception is the wrong
 *   answer to that question.
 * @param {string} id - The provider id.
 * @returns {object|null} The descriptor, or null.
 */
function getChatProviderOrNull(id) {
	try {
		return getChatProvider(id);
	} catch {
		return null;
	}
}

/** How each capability finds its providers. The only registry-aware table. */
const REGISTRIES = Object.freeze({
	chat: { list: () => listChatProviders(), get: getChatProviderOrNull },
	speech: { list: listSpeechProviders, get: (id) => resolveTTSProvider(id) ?? null },
	image: { list: listImageProviders, get: getImageProvider },
});

/**
 * Assembles the whole credential system.
 *
 * @param {object} [options] - Injected dependencies and configuration.
 * @param {object} [options.fsImpl=fs] - Filesystem implementation.
 * @param {string} options.dataDir - Directory holding the vault and policy files.
 * @param {string|null} options.secret - The vault encryption secret.
 * @param {object} [options.env=process.env] - Environment to import legacy keys from.
 * @param {Function} [options.log] - Logger.
 * @param {Function} [options.now] - Clock returning a Date, injected for tests.
 * @param {Function} [options.onPurge] - Called when a host credential is dropped.
 * @returns {object} The assembled system.
 * @throws {VaultLockedError} When a vault file exists and cannot be decrypted.
 */
export function createCredentialSystem({
	fsImpl = fsDefault,
	dataDir,
	secret,
	env = process.env,
	log = () => {},
	now = () => new Date(),
	onPurge = () => {},
} = {}) {
	const vault = createVault({
		fsImpl,
		filePath: path.join(dataDir, VAULT_FILE),
		secret,
		now,
		log,
	});

	const policyStore = createPolicyStore({ fsImpl, filePath: path.join(dataDir, POLICY_FILE) });

	/**
	 * @description Imports keys already present in the environment, once, into an
	 *   empty slot. Never overwrites: a key an operator entered through the admin
	 *   console is the current one, and a stale variable in a compose file must
	 *   not win on the next restart — the same rule ADR 0006 established for the
	 *   speech server's address.
	 * @returns {string[]} Provider ids that were imported.
	 */
	function importFromEnvironment() {
		const imported = [];
		for (const { providerId, vars } of ENV_KEYS) {
			if (vault.has(providerId)) continue;
			const value = vars.map((name) => env?.[name]).find((v) => typeof v === "string" && v.trim());
			if (!value) continue;
			vault.set(providerId, value);
			imported.push(providerId);
		}
		if (imported.length) {
			log(`🔑 Imported ${imported.length} API key(s) from the environment into the credential vault: ${imported.join(", ")}. ` +
				"Those variables can now be removed.");
		}
		return imported;
	}

	importFromEnvironment();

	/**
	 * @description Lists a capability's providers, or nothing for a capability that
	 *   does not exist.
	 * @param {string} capability - The capability.
	 * @returns {Array<object>} Serialisable descriptors.
	 */
	function providersFor(capability) {
		return REGISTRIES[capability]?.list() ?? [];
	}

	/**
	 * @description Resolves one provider within one capability.
	 * @param {string} capability - The capability.
	 * @param {string} providerId - The provider id.
	 * @returns {object|null} The descriptor, or null when either is unknown.
	 */
	function providerFor(capability, providerId) {
		if (typeof providerId !== "string") return null;
		return REGISTRIES[capability]?.get(providerId) ?? null;
	}

	/** Capability → provider id → whether a live probe reached it. */
	const availability = {};

	/**
	 * The active policy document.
	 *
	 * Loaded from disk when one exists. When none does, it is derived from what
	 * the registries offer and what the vault holds — after the environment import,
	 * so a key that arrived from `.env` produces a `shared` default and an existing
	 * install keeps working exactly as it did.
	 */
	let policy = policyStore.load() ?? defaultPolicyDocument({
		known: Object.fromEntries(
			Object.keys(REGISTRIES).map((capability) => [
				capability,
				providersFor(capability).map((p) => ({ id: p.id, local: Boolean(p.isLocal) })),
			]),
		),
		configured: Object.fromEntries(
			Object.keys(REGISTRIES).map((capability) => [
				capability,
				providersFor(capability).filter((p) => vault.has(p.id)).map((p) => p.id),
			]),
		),
	});

	const sessionKeys = createSessionKeys({ now: () => now().getTime(), log, onPurge });

	// `getPolicy` is a closure over the mutable binding rather than a snapshot, so
	// an admin editing the policy takes effect on the very next resolution instead
	// of needing the resolver rebuilt.
	const resolver = createResolver({ vault, getPolicy: () => policy, sessionKeys, providerFor });

	/**
	 * @description Snapshots every capability's providers for the view builders.
	 * @returns {object} Capability → descriptors.
	 */
	function allProviders() {
		return Object.fromEntries(Object.keys(REGISTRIES).map((capability) => [capability, providersFor(capability)]));
	}

	return {
		vault,
		sessionKeys,
		resolver,

		providersFor,
		providerFor,

		/**
		 * @description Returns the active policy. The resolver reads through this
		 *   rather than holding a copy, so an admin edit applies to the next call.
		 * @returns {object} The normalized policy document.
		 */
		getPolicy() {
			return policy;
		},

		/**
		 * @description Validates, persists, and activates a policy document.
		 * @param {object} document - The document to store.
		 * @returns {object} The normalized document now in effect.
		 * @throws {PolicyError} When the document is invalid; nothing is written.
		 */
		setPolicy(document) {
			// Normalized before writing so an invalid document neither reaches disk
			// nor replaces the working one in memory.
			const normalized = normalizePolicyDocument(document);
			policyStore.save(normalized);
			policy = normalized;
			return policy;
		},

		/**
		 * @description Records what a live probe found, so the capability views can
		 *   distinguish "not configured" from "configured but not answering".
		 * @param {string} capability - The capability probed.
		 * @param {object} results - Provider id → whether it answered.
		 * @returns {void}
		 */
		setAvailability(capability, results) {
			availability[capability] = { ...availability[capability], ...results };
		},

		/**
		 * @description Describes the instance for the admin console.
		 * @returns {object} Capability → providers, including vault metadata.
		 */
		describe() {
			return adminCapabilities({ providers: allProviders(), policy, vault, availability });
		},

		/**
		 * @description Describes the instance for a player's settings window.
		 * @returns {object} Capability → providers, carrying no vault metadata.
		 */
		describeForPlayers() {
			return publicCapabilities({ providers: allProviders(), policy, vault, availability });
		},
	};
}
