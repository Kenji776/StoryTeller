/**
 * lobbyMaintenance — which stored lobbies are safe to remove.
 *
 * @description The landing page lists every lobby in `waiting`, `running`, `hibernating`,
 *   `wiped` or `completed`, which in practice is all of them. 66 had accumulated, and
 *   profiling them showed the cause was not players: the median age was **one day** and
 *   12 had never been played at all. They are integration-probe artifacts. Every probe
 *   creates a lobby through the real socket path and none of them clean up.
 *
 *   The decision is separated from the deletion so it can be unit tested and so the CLI
 *   in `server/tools/` stays a thin shell — `CQ-5`. Nothing here touches the filesystem.
 */

/** A lobby untouched for longer than this is a candidate, whatever else is true of it. */
export const STALE_DAYS = 30;

/** Turns below which a lobby was never really played — a create, a join, and nothing. */
export const UNPLAYED_TURNS = 2;

/**
 * @description Reads a lobby's last-touched time, tolerating either field or neither.
 * @param {object} lobby - A parsed lobby record.
 * @returns {number|null} Epoch milliseconds, or null when the record carries no time.
 */
function lastTouched(lobby) {
	const value = Number(lobby?.lastActivity ?? lobby?.createdAt);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Decides whether one lobby can be removed, and says why.
 *
 * @description Deliberately conservative, because this deletes somebody's game. A lobby
 *   is only a candidate when it is *demonstrably* disposable:
 *
 *   - it holds no characters at all, or
 *   - it was never played beyond the opening turns **and** nobody is in it, or
 *   - nothing has touched it for {@link STALE_DAYS} days.
 *
 *   A record with no timestamp is **kept**. Treating an unreadable date as "very old" is
 *   the failure mode that deletes the thing you cared about, and an unparseable record is
 *   exactly the one worth keeping for inspection.
 * @param {object} lobby - A parsed lobby record.
 * @param {number} now - Epoch milliseconds to measure age against; injected so the
 *   decision is deterministic (`TDD-8`).
 * @returns {{prune: boolean, reason: string}} The verdict and a line for the report.
 */
export function pruneVerdict(lobby, now) {
	// An array passes a bare `typeof === "object"` check and would then read as a lobby
	// with no characters, which is a *prune* verdict — the dangerous direction.
	if (!lobby || typeof lobby !== "object" || Array.isArray(lobby)) {
		return { prune: false, reason: "unreadable record — kept for inspection" };
	}

	const players = Object.keys(lobby.players ?? {}).length;
	const turns = Array.isArray(lobby.history) ? lobby.history.length : 0;
	const touched = lastTouched(lobby);
	const ageDays = touched === null ? null : (now - touched) / 86_400_000;

	if (players === 0) return { prune: true, reason: "no characters" };
	if (turns <= UNPLAYED_TURNS) {
		return { prune: true, reason: `never played (${turns} turn${turns === 1 ? "" : "s"})` };
	}
	if (ageDays !== null && ageDays > STALE_DAYS) {
		return { prune: true, reason: `untouched for ${Math.floor(ageDays)} days` };
	}

	if (ageDays === null) return { prune: false, reason: "no timestamp — kept" };
	return { prune: false, reason: `active ${Math.floor(ageDays)}d ago, ${turns} turns` };
}

/**
 * Sorts a set of lobbies into what may go and what stays.
 *
 * @param {Array<{id: string, lobby: object}>} entries - Parsed lobbies with their ids.
 * @param {number} now - Epoch milliseconds to measure age against.
 * @returns {{prune: Array<object>, keep: Array<object>}} Each entry with its reason.
 * @throws {never} Malformed entries are reported as kept rather than throwing.
 */
export function planPrune(entries, now) {
	const prune = [];
	const keep = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		const verdict = pruneVerdict(entry?.lobby, now);
		(verdict.prune ? prune : keep).push({ id: entry?.id ?? "(unknown)", ...verdict });
	}
	return { prune, keep };
}
