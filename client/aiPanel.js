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
