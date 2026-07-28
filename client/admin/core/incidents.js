/**
 * incidents — ordering and describing the problems the server could not fix itself.
 *
 * The server records these (`server/services/incidents.js`) and collapses repeats
 * into a single record with a count. What the console adds is an order: an admin
 * opening Health is looking for what still needs doing, not for a history, so
 * unresolved comes first and the worst of it comes first within that.
 */

/** How severities rank when ordering. Lower sorts first. */
const SEVERITY_RANK = Object.freeze({ error: 0, warning: 1, info: 2 });

/**
 * Rank for a severity this build does not recognise. Between error and info
 * deliberately: the server can add one without the console being redeployed, and
 * both burying it under everything and floating it above a genuine error are wrong.
 */
const UNKNOWN_RANK = 1.5;

/**
 * @description Ranks a severity for ordering.
 * @param {*} severity - The server's severity.
 * @returns {number} The rank.
 */
function rank(severity) {
	return SEVERITY_RANK[severity] ?? UNKNOWN_RANK;
}

/**
 * @description Orders incidents for display: unresolved first, then by severity,
 *   then most recently seen.
 * @param {Array<object>} incidents - Incidents from the server.
 * @returns {Array<object>} A new array, ordered. The input is left alone.
 */
export function sortIncidents(incidents) {
	if (!Array.isArray(incidents)) return [];
	return [...incidents].sort((a, b) =>
		(Number(!!a?.resolved) - Number(!!b?.resolved))
		|| (rank(a?.severity) - rank(b?.severity))
		|| ((b?.lastAt ?? 0) - (a?.lastAt ?? 0)));
}

/**
 * @description Counts what still needs attention, which is what the nav badge shows.
 *
 *   A record with no `resolved` flag counts as unresolved: absent is not the same
 *   as handled, and assuming otherwise hides a problem.
 * @param {Array<object>} incidents - Incidents from the server.
 * @returns {number} The number unresolved.
 */
export function unresolvedCount(incidents) {
	if (!Array.isArray(incidents)) return 0;
	return incidents.filter((incident) => !incident?.resolved).length;
}

/**
 * @description Maps a severity onto the console's tone vocabulary.
 * @param {string} severity - The server's severity.
 * @returns {string} A tone for `chip()`: `"danger"`, `"warn"`, or `"info"`.
 */
export function severityTone(severity) {
	if (severity === "error") return "danger";
	if (severity === "info") return "info";
	return "warn";
}
