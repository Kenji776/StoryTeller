/**
 * The AI panel's logic, kept out of the DOM so it can be tested.
 *
 * `client/components/options.html` is one long inline script with no test
 * harness, so everything here is the part that could be got wrong: turning the
 * server's readiness verdict into rows, deciding whether Start is enabled, and
 * building a submission the server will accept rather than one it will reject on
 * a technicality.
 *
 * The server is the source of truth for all of it — `services/credentials/
 * readiness.js` produces the verdict and `routes/aiSetup.js` enforces it. Nothing
 * here re-decides anything; it only presents. A second opinion in the browser is
 * how a Start button ends up enabled for a game the server will refuse.
 */

import { parseRatings, annotateModels, pickRecommended } from "./modelRatings.js";

/** The order services are shown in, regardless of what order they arrive. */
const DISPLAY_ORDER = Object.freeze(["chat", "speech", "image"]);

/** What each service is called in the panel. */
const TITLES = Object.freeze({
	chat: "Story & Dungeon Master",
	speech: "Narration",
	image: "Character portraits",
});

/** Services the game runs without. Mirrors `REQUIRED_CAPABILITIES` server-side. */
const OPTIONAL = Object.freeze(["speech", "image"]);

/**
 * @description Formats an ISO instant as a date a person can read, falling back
 *   to the raw value rather than showing "Invalid Date".
 * @param {string|null} iso - The instant.
 * @returns {string} A readable date, or the empty string.
 */
function readableDate(iso) {
	if (!iso) return "";
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? String(iso) : parsed.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * Turns the server's verdict into rows the panel renders.
 *
 * @description Each row carries a tone and a `needsInput` flag rather than
 *   markup, so the renderer stays a arrangement of elements and this stays
 *   testable.
 * @param {object} state - An `ai:state` payload.
 * @returns {Array<object>} One row per service, in display order.
 */
export function panelRows(state) {
	const services = Array.isArray(state?.services) ? state.services : [];
	const blocking = new Set((state?.blocking ?? []).map((b) => b.capability));
	const held = state?.held ?? null;

	return [...services]
		.sort((a, b) => DISPLAY_ORDER.indexOf(a.capability) - DISPLAY_ORDER.indexOf(b.capability))
		.map((service) => {
			const optional = OPTIONAL.includes(service.capability);
			const heldEntry = held?.[service.capability] ?? null;

			const tone = service.state === "needs-key" ? "warn"
				: service.state === "unavailable" ? "muted"
				: "ok";

			// An optional service that wants a key is a suggestion, not a fault. Saying
			// so is what stops a host hunting for an ElevenLabs account before playing.
			const detail = service.state === "needs-key" && optional
				? `${service.message} Optional — the game plays without it.`
				: service.state === "own-key" && heldEntry
					? `${service.message} ${heldSummary(heldEntry)}`
					: service.message;

			return {
				capability: service.capability,
				title: TITLES[service.capability] ?? service.capability,
				state: service.state,
				tone,
				detail,
				optional,
				blocking: blocking.has(service.capability),
				needsInput: service.state === "needs-key",
				canWithdraw: service.state === "own-key",
				providerId: service.providerId,
				providerLabel: service.providerLabel,
				options: service.options ?? [],
			};
		});
}

/**
 * Decides whether the Start button is enabled, and what to say if not.
 *
 * @description Defaults to *not* startable when the verdict is unknown. Before
 *   the first `ai:state` arrives there is nothing to go on, and guessing
 *   optimistically would let someone press a button the server then refuses —
 *   which reads as a broken game rather than as missing configuration.
 * @param {object} state - An `ai:state` payload.
 * @returns {{canStart: boolean, reason: string}} The gate.
 */
export function startGate(state) {
	if (!state || typeof state.ready !== "boolean") return { canStart: false, reason: "Checking the AI configuration…" };
	if (state.ready) return { canStart: true, reason: "" };
	return { canStart: false, reason: state.blocking?.[0]?.message ?? "This game cannot start yet." };
}

/**
 * @description Parses the host's call limit. Sent as a number because the server
 *   rejects a string rather than coercing it, and blank means no limit.
 * @param {*} raw - The field value.
 * @returns {number|null} A positive integer, or null.
 */
function parseLimit(raw) {
	if (raw === null || raw === undefined || String(raw).trim() === "") return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Parses the host's expiry.
 *
 * @description A `<input type="date">` yields a day, and a host choosing the 5th
 *   means the key should last *through* the 5th — treating it as midnight would
 *   expire the key as that day begins, which is the opposite of what they asked
 *   for. Anything already carrying a time is passed through untouched.
 * @param {*} raw - The field value.
 * @returns {string|null} An ISO instant, or null for no expiry.
 */
function parseExpiry(raw) {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
	return `${text}T23:59:59.999Z`;
}

/**
 * @description Builds the payload for `ai:credential:set`.
 * @param {object} form - The panel's field values.
 * @returns {object} The submission.
 */
export function credentialSubmission(form = {}) {
	const baseUrl = typeof form.baseUrl === "string" ? form.baseUrl.trim() : "";
	return {
		lobbyId: form.lobbyId ?? null,
		capability: form.capability ?? null,
		providerId: form.providerId ?? null,
		apiKey: typeof form.apiKey === "string" ? form.apiKey.trim() : "",
		baseUrl: baseUrl || null,
		// Exactly true. The server refuses anything else, and coercing here would
		// mean a host could agree to nothing and have it recorded as agreement.
		consent: form.consent === true,
		maxCalls: parseLimit(form.maxCalls),
		expiresAt: parseExpiry(form.expiresAt),
	};
}

/**
 * @description Describes a held credential for the host, by its tail and its
 *   usage. Never the key itself — the server does not send it and this could not
 *   show it even if asked.
 * @param {object|null} entry - One capability's entry from `sessionKeys.describe`.
 * @returns {string} A short summary, or the empty string when nothing is held.
 */
export function heldSummary(entry) {
	if (!entry) return "";
	if (!entry.configured) return "Your key is no longer held — enter it again to continue.";

	const parts = [`Key ····${entry.last4 ?? "set"}`];
	parts.push(entry.maxCalls ? `${entry.used ?? 0} of ${entry.maxCalls} calls used` : `${entry.used ?? 0} calls used, no limit`);
	if (entry.expiresAt) parts.push(`expires ${readableDate(entry.expiresAt)}`);
	return `${parts.join(" · ")}.`;
}

/**
 * What a host may pick for the narrator, and where each provider's key comes from.
 *
 * @description Built because a game died on a provider and model that could not work together, and
 *   the host had nowhere to look: the only model picker in the project lived in the admin console,
 *   and the error told them to "pick a different model in AI Settings" — a screen that did not exist.
 *
 *   Three things it has to convey, and the middle one is the whole point of the panel:
 *
 *   - **What is running now**, so the question "what model is this?" has an answer.
 *   - **Where each provider's key comes from** — this server's, the host's own, a local install that
 *     needs none, or nowhere yet. A provider with no key is still *offered*, flagged: hiding it
 *     would leave a host unable to discover that supplying their own key is possible.
 *   - **Which models that provider takes**, including whatever the lobby is already running even if
 *     the shipped catalogue has never heard of it. Otherwise opening the panel and pressing Apply
 *     would quietly downgrade a host who had set something newer than the list, which is how a stale
 *     list turns from unhelpful into destructive.
 *   - **Which of them are known to work.** Several models a provider happily lists cannot run
 *     this game at all, and the bake-off knows which. A host had no way to find that out
 *     except by losing an evening, so every model carries a badge and the dropdown offers the
 *     good ones first.
 * @param {object} state - An `ai:state` payload.
 * @param {object} lobby - Anything carrying `llmProvider` and `llmModel`; usually lobby state.
 * @param {Array<{id: string, label: string, models: Array<object>}>} catalogue - Parsed model
 *   catalogue, used where a provider's models cannot be listed live.
 * @param {object} [ratings] - Raw `model_ratings.json`. Parsed here rather than by the caller,
 *   so a page needs no extra bridge function to use it. Absent or malformed means every model
 *   reports `untested`: the ratings arrive over the network, and a failed fetch must leave a
 *   working picker that claims nothing rather than an empty one.
 * @returns {{providers: Array<object>, current: {providerId: string|null, modelId: string|null},
 *   modelsFor: Function, freeTextFor: Function, recommendedFor: Function}} The picker's model.
 */
export function modelChoices(state, lobby, catalogue = [], ratings = null) {
	const services = Array.isArray(state?.services) ? state.services : [];
	const chat = services.find((s) => s?.capability === "chat") ?? null;
	const current = {
		providerId: lobby?.llmProvider ?? null,
		modelId: lobby?.llmModel ?? null,
	};

	const rated = parseRatings(ratings);

	/**
	 * @description Looks up a provider's models, always including the one in force, each
	 *   carrying what the bake-off found out about it.
	 * @param {string} providerId - The provider.
	 * @returns {Array<{id: string, label: string, rating: object}>} Models to offer, best
	 *   first and known failures last, so a host scanning a long dropdown meets the good
	 *   ones before the broken ones.
	 */
	const modelsFor = (providerId) => {
		const listed = (catalogue.find((p) => p.id === providerId)?.models ?? []).map((m) => ({ ...m }));
		const running = current.providerId === providerId && current.modelId
			&& !listed.some((m) => m.id === current.modelId);
		// The running model is appended even when unrated, because a stale catalogue must not
		// quietly downgrade a host who set something newer than the list.
		const all = running ? [...listed, { id: current.modelId, label: `${current.modelId} (in use)` }] : listed;
		return annotateModels(rated, providerId, all, { sort: true });
	};

	/**
	 * @description Which model this provider's dropdown should land on.
	 * @param {string} providerId - The provider.
	 * @returns {string|null} The model id to preselect, or null when it offers nothing.
	 */
	const recommendedFor = (providerId) => pickRecommended(rated, providerId, modelsFor(providerId));

	if (!chat) {
		return { providers: [], current, modelsFor, recommendedFor, freeTextFor: (id) => !catalogue.some((p) => p.id === id) };
	}

	// `options` carries only the providers that take a key, so the one actually serving the
	// capability can be missing from it — a local install, for instance. It is added back, because a
	// picker that omits what is running is worse than no picker.
	const offered = [...(Array.isArray(chat.options) ? chat.options : [])];
	if (chat.providerId && !offered.some((p) => p.id === chat.providerId)) {
		offered.unshift({ id: chat.providerId, label: chat.providerLabel ?? chat.providerId, requiresApiKey: false });
	}

	// The host's own key, if they supplied one, names a specific provider.
	const ownProviderId = state?.held?.chat?.providerId ?? null;

	const providers = offered.map((provider) => {
		// Each option's own `ready` flag is the authority on whether a key exists for it.
		//
		// The first version read `chat.providerId` instead — but that names the *first* provider that
		// could serve the capability (`readiness.js` does `providers.find(p => p.ready)`), not the one
		// this lobby uses. On a server holding both keys it marked Anthropic as needing one while the
		// game had been narrating on Anthropic all day, and disabled Apply for the provider actually in
		// use. A picker that lies about what works is worse than no picker.
		const keySource = provider.id === ownProviderId ? "own"
			: !provider.ready ? "none"
				: provider.requiresApiKey === false ? "local"
					: "server";

		return {
			id: provider.id,
			label: provider.label ?? provider.id,
			keySource,
			selectable: keySource !== "none",
			note: keySource === "server" ? "This server supplies the key."
				: keySource === "own" ? "Using your own key."
					: keySource === "local" ? "Runs locally — no key needed."
						: "Needs an API key. Add yours below to use it.",
		};
	});

	return {
		providers,
		current,
		modelsFor,
		recommendedFor,
		/**
		 * @description Whether a provider's models have to be typed rather than chosen.
		 * @param {string} providerId - The provider.
		 * @returns {boolean} True when nothing can enumerate them — a local install names its models
		 *   whatever it likes, and a fixed list would be wrong more often than right.
		 */
		freeTextFor: (providerId) => !catalogue.some((p) => p.id === providerId),
	};
}

/**
 * What the narrator panel should ask a host for, so they can use a provider this server cannot.
 *
 * @description The picker lists every provider including the ones with no key, because a host who
 *   cannot see Gemini cannot learn that bringing a Gemini key is an option. That promise has to be
 *   payable: this decides whether to ask, and for what.
 *
 *   Not every provider wants a key. `openai-compatible` and Ollama want an *address* — asking them
 *   for an API key is unanswerable, and the field that would have helped is missing. So the two are
 *   reported separately rather than as one "needs setup" flag.
 *
 *   The richer controls — call caps, expiry, withdrawing a key — live in the Game Options window and
 *   are not duplicated here. Both screens build their payload with `credentialSubmission`, which is
 *   the seam that keeps them from drifting.
 * @param {object} state - An `ai:state` payload.
 * @param {string|null} providerId - The provider the host has selected in the picker.
 * @returns {{needed: boolean, providerId: string|null, label: string, requiresKey: boolean,
 *   requiresBaseUrl: boolean, keyUrl: string|null, held: string, canReplace: boolean}} What to ask
 *   for. `needed: false` means render nothing.
 */
export function keyFormFor(state, providerId) {
	const nothing = {
		needed: false, providerId: providerId ?? null, label: "", requiresKey: false,
		requiresBaseUrl: false, keyUrl: null, held: "", canReplace: false,
	};
	if (!providerId) return nothing;

	const chat = (Array.isArray(state?.services) ? state.services : []).find((s) => s?.capability === "chat");
	const option = (chat?.options ?? []).find((p) => p?.id === providerId);
	if (!option) return nothing;

	// A key the host supplied for one provider says nothing about another, so the tail and the usage
	// are only shown against the provider they belong to.
	const heldEntry = state?.held?.chat ?? null;
	const canReplace = Boolean(heldEntry?.configured && heldEntry.providerId === providerId);

	// Ready and not theirs means this server covers it — there is nothing for a host to do, and an
	// empty form under a working provider suggests otherwise.
	if (option.ready === true && !canReplace) return nothing;

	return {
		needed: true,
		providerId,
		label: option.label ?? providerId,
		requiresKey: option.requiresApiKey !== false,
		requiresBaseUrl: option.requiresBaseUrl === true,
		keyUrl: option.keyUrl ?? null,
		held: canReplace ? heldSummary(heldEntry) : "",
		canReplace,
	};
}

/**
 * Makes a value safe to interpolate into markup, in either element or attribute position.
 *
 * @description The panel is built with template literals and `innerHTML`, and some of what it
 *   interpolates is not the server's own words: the model id is a free-text field for providers whose
 *   models cannot be enumerated, and a key's tail comes from whatever the host pasted. `setLLMSettings`
 *   now shape-checks the model id, so this is the second layer rather than the only one — but it is
 *   the layer that also covers provider labels from config and everything added here later.
 *
 *   The ampersand is replaced first. Any other order re-escapes the escapes and the page shows
 *   `&lt;` as literal text where a less-than sign belongs.
 * @param {*} value - Anything. Non-strings become the empty string rather than "undefined" or
 *   "[object Object]", which is what a missing field should look like on a page.
 * @returns {string} The escaped text.
 */
export function escapeHtml(value) {
	if (typeof value !== "string") return "";
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
