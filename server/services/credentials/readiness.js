/**
 * Whether a lobby can start, and what a host would have to do about it.
 *
 * One function serves three callers that must never disagree: the settings
 * window drawing the AI panel, the client disabling the Start button, and the
 * server refusing `game:start`. If those three answered the question separately
 * they would drift, and the failure mode is the worst kind — a Start button that
 * looks enabled and then does nothing.
 *
 * **Only the story service blocks a game.** Narration and portraits degrade to
 * silence and a blank frame, which is a game; a Dungeon Master that cannot answer
 * is not. Refusing to start because nobody has an ElevenLabs key would be
 * hostile, and it is the sort of gate that gets added by accident when every
 * capability is treated uniformly.
 *
 * Pure: capability view in, verdict out. No I/O, no clock, no registry.
 */

import { CAPABILITIES } from "./policy.js";

/** The capabilities without which there is no game. */
export const REQUIRED_CAPABILITIES = Object.freeze(["chat"]);

/** What each service is called where a player can see it. */
const SERVICE_LABELS = Object.freeze({
	chat: "the Dungeon Master",
	speech: "narration",
	image: "character portraits",
});

/**
 * @description Reads what a host has supplied for one capability, if anything.
 * @param {object|null} session - `sessionKeys.describe(lobbyId)` output.
 * @param {string} capability - The capability.
 * @returns {object|null} The entry, only when a credential is actually held.
 */
function hostEntryFor(session, capability) {
	const entry = session?.[capability];
	return entry?.configured ? entry : null;
}

/**
 * Works out the state of one service.
 *
 * @description The order matters. A host who supplied their own key has made a
 *   deliberate choice and it is reported as theirs even if the instance would
 *   also have served it — anything else would tell them their key is unused when
 *   it is about to be spent.
 * @param {string} capability - The capability being described.
 * @param {object} view - That capability's slice of the player-facing view.
 * @param {object|null} session - What the host has supplied.
 * @returns {object} The service's state.
 */
function describeService(capability, view, session) {
	const providers = Array.isArray(view?.providers) ? view.providers : [];
	const label = SERVICE_LABELS[capability] ?? capability;

	const host = hostEntryFor(session, capability);
	// Matched against what is offered: a key for a provider the operator has since
	// withdrawn cannot satisfy anything, and saying otherwise would produce a lobby
	// that passes its own start check and then fails on the first turn.
	const hostProvider = host && providers.find((p) => p.id === host.providerId);

	if (hostProvider) {
		return {
			capability, label, state: "own-key", actionable: false,
			providerId: hostProvider.id, providerLabel: hostProvider.label,
			options: providers.filter((p) => p.needsPlayerKey || p.requiresApiKey),
			message: `Using your own ${hostProvider.label} key.`,
		};
	}

	// `ready` already folds in "shared and the vault has a key" and "local and not
	// known to be unreachable" — see capabilities.js.
	const served = providers.find((p) => p.ready);
	if (served) {
		const local = !served.requiresApiKey;
		return {
			capability, label, state: local ? "local" : "server", actionable: false,
			providerId: served.id, providerLabel: served.label,
			options: providers.filter((p) => p.needsPlayerKey || p.requiresApiKey),
			message: local
				? `Running on ${served.label} — free, on this network.`
				: `Provided by this server (${served.label}).`,
		};
	}

	const options = providers.filter((p) => p.needsPlayerKey || p.requiresApiKey);
	if (!options.length) {
		return {
			capability, label, state: "unavailable", actionable: false,
			providerId: null, providerLabel: null, options: [],
			message: `${label[0].toUpperCase()}${label.slice(1)} is not available on this server.`,
		};
	}

	return {
		capability, label, state: "needs-key", actionable: true,
		providerId: null, providerLabel: null, options,
		message: `Add your own API key to use ${label}.`,
	};
}

/**
 * Decides whether a lobby can start.
 *
 * @param {object} [input] - What is known about the instance and the lobby.
 * @param {object} [input.capabilities] - `credentials.describeForPlayers()`.
 * @param {object} [input.session] - `credentials.sessionKeys.describe(lobbyId)`.
 * @returns {{ready: boolean, services: Array<object>, blocking: Array<object>}}
 *   Every service's state, and the subset that stops the game starting.
 */
export function lobbyReadiness({ capabilities, session } = {}) {
	const services = CAPABILITIES.map((capability) =>
		describeService(capability, capabilities?.[capability], session ?? null));

	const blocking = services
		.filter((service) => REQUIRED_CAPABILITIES.includes(service.capability))
		.filter((service) => service.state === "needs-key" || service.state === "unavailable")
		.map((service) => ({
			capability: service.capability,
			message: service.state === "unavailable"
				? `This server offers no AI provider for ${service.label}, so a game cannot be started.`
				: `Add an API key for ${service.label} before starting the game.`,
		}));

	return { ready: blocking.length === 0, services, blocking };
}
