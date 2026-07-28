/**
 * router — the hash routes that make a section linkable.
 *
 * The old panel held the current tab in a DOM class, so a reload always landed on
 * Players and a link to "the thing that is broken in lobby X4K2" could not be sent
 * to anyone. Routes are parsed and built here, as pure string work, so both the
 * shell and the tests can use them.
 */

/** Where a connected lobby opens. */
export const DEFAULT_SECTION = "dashboard";

/** Where the panel opens with no lobby connected. */
export const GLOBAL_SECTION = "lobbies";

/** Lobby codes as the server issues them: four or more upper-case alphanumerics. */
const CODE_PATTERN = /^[A-Z0-9]{4,12}$/;

/**
 * @description Splits a hash into its decoded path segments.
 *
 *   Leading and trailing empties are stripped, so surrounding slashes are cosmetic.
 *   An empty segment *between* two others is not: `#/lobby//party` would otherwise
 *   collapse to `#/lobby/party` and be read as a request to connect to a lobby
 *   called PARTY. That is treated as malformed and yields no segments at all.
 *
 *   Decoding is per segment and failure-tolerant: a hand-edited URL carrying a
 *   stray `%` should fall back to a usable route rather than throw out of the
 *   router and leave the shell unmounted.
 * @param {*} hash - A `window.location.hash`, with or without its leading `#`.
 * @returns {Array<string>} The segments, or an empty array when absent or malformed.
 */
function segments(hash) {
	if (typeof hash !== "string") return [];

	const parts = hash.replace(/^#/, "").split("/");
	while (parts.length && parts[0] === "") parts.shift();
	while (parts.length && parts.at(-1) === "") parts.pop();
	if (parts.some((part) => part === "")) return [];

	return parts.map((part) => {
		try {
			return decodeURIComponent(part);
		} catch {
			return part;
		}
	});
}

/**
 * @description Normalises a lobby code, or reports that it is not one.
 * @param {*} raw - The candidate code.
 * @returns {string|null} The upper-cased code, or null if it is not a valid code.
 */
function asCode(raw) {
	if (typeof raw !== "string") return null;
	const code = raw.trim().toUpperCase();
	return CODE_PATTERN.test(code) ? code : null;
}

/**
 * @description Reads a location hash into a route.
 *
 *   Anything unrecognised resolves to the global section rather than throwing: a
 *   hand-edited or stale URL should land somewhere useful, not on an error page.
 *   A malformed lobby code is discarded rather than carried, so the shell never
 *   asks the server to connect to something the server could not have issued.
 * @param {string} hash - A `window.location.hash`, with or without its leading `#`.
 * @returns {{lobby: string|null, section: string}} The parsed route.
 */
export function parseRoute(hash) {
	const parts = segments(hash);
	const fallback = { lobby: null, section: GLOBAL_SECTION };

	if (!parts.length) return fallback;

	if (parts[0] === "lobby") {
		const lobby = asCode(parts[1]);
		if (!lobby) return fallback;
		return { lobby, section: parts[2] || DEFAULT_SECTION };
	}

	// A global section is a single segment. Anything deeper is not a route this
	// version of the panel produced.
	return parts.length === 1 ? { lobby: null, section: parts[0] } : fallback;
}

/**
 * @description Builds the hash for a route.
 * @param {object} [route] - Where to go.
 * @param {string|null} [route.lobby] - Lobby code, or null for a global section.
 * @param {string} [route.section] - Section id.
 * @returns {string} A hash beginning with `#/`.
 * @throws {TypeError} When a lobby code is given that the server could not have issued.
 */
export function buildRoute({ lobby = null, section = "" } = {}) {
	if (lobby === null || lobby === undefined) {
		return `#/${encodeURIComponent(section || GLOBAL_SECTION)}`;
	}
	const code = asCode(lobby);
	if (!code) throw new TypeError(`Not a lobby code: ${JSON.stringify(lobby)}`);
	return `#/lobby/${code}/${encodeURIComponent(section || DEFAULT_SECTION)}`;
}
