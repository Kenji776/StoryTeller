/**
 * generations — group models into release "rungs" and order them newest first.
 *
 * The descending sweep walks generations from newest to oldest and stops once an entire
 * generation fails, on the reasoning that nothing older than a dead generation is going
 * to do better. The ordering is therefore not cosmetic: get it wrong and the sweep
 * either abandons models that work or grinds through ancient ones it should have skipped.
 *
 * Recency comes from the **catalogue's own dated snapshots** rather than from reading
 * version numbers. That matters because version numbers lie about recency across
 * families: `gpt-4.1` (April 2025) is newer than `gpt-4o` (November 2024) despite the
 * smaller-looking number, and the `o` series interleaves with both. The dates are
 * already published — `gpt-4.1-2025-04-14`, `o3-2025-04-16` — so they are used.
 *
 * Version numbers are only the tie-breaker, for a generation that publishes no dated
 * snapshot at all. `gpt-5.6-sol` is such a case, and it is plainly newer than the dated
 * `gpt-5.5`, so an undated generation is slotted just above the newest dated generation
 * of its family that it outranks numerically.
 *
 * Pure and synchronous.
 */

/** Suffixes that denote a size, tier or flavour of one generation, not a new one. */
const VARIANT_SUFFIX = /-(?:sol|luna|terra|pro|mini|nano|chat-latest|latest|turbo-\d+k?|preview)$/;

/** A dated snapshot suffix, in both published forms. */
const DATE_SUFFIX = /-(\d{4})-(\d{2})-(\d{2})$|-(\d{4})(\d{2})(\d{2})$/;

/** A bare four-digit snapshot tag, as the 3.5 line uses (`-0125`, `-1106`). */
const SHORT_SNAPSHOT = /-\d{4}$/;

/** Restricted-access prefixes that do not change which generation a model belongs to. */
const ACCESS_PREFIX = /^ra-/;

/** Families whose ids can safely have variant suffixes stripped. */
const KNOWN_FAMILY = /^(?:gpt-\d|o\d|claude-)/;

/**
 * Release dates for generations that predate ISO-dated snapshots.
 *
 * @description These publish only a bare `-MMDD` tag (`gpt-4-0613`, `gpt-3.5-turbo-0125`)
 * whose year is implicit, so there is nothing in the catalogue to sort them by. Without
 * an entry here an undated rung is treated as *newest* — correct for `gpt-5.6`, which
 * genuinely has no snapshot yet, and badly wrong for `gpt-4`, which sorted to the top of
 * the sweep. Hand-maintained, and short by design: a generation missing from it lands
 * wherever its version number puts it.
 */
const LEGACY_RELEASES = {
	"gpt-4-turbo": "2024-04-09",
	"gpt-4": "2023-06-13",
	"gpt-3.5": "2023-03-01",
};

/**
 * @description Extracts an ISO date from a dated snapshot id, if it carries one.
 * @param {string} id - A model id.
 * @returns {string|null} `YYYY-MM-DD`, or null.
 */
function dateOf(id) {
	const m = DATE_SUFFIX.exec(id);
	if (!m) return null;
	const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
	return `${y}-${mo}-${d}`;
}

/**
 * Reduces a model id to the generation it belongs to.
 *
 * @description Strips access prefixes, dated snapshots and variant suffixes, so every
 *   size and flavour of one release lands in a single rung. `gpt-4-turbo` is deliberately
 *   kept apart from `gpt-4`: they are eleven months apart and behave nothing alike.
 * @param {string} id - The model id as the provider published it.
 * @returns {string} The rung key. Unrecognised ids become their own rung rather than
 *   being lumped in with something else. Never throws.
 */
export function rungKeyOf(id) {
	if (typeof id !== "string" || id.trim() === "") return "(unknown)";
	let key = id.trim().toLowerCase().replace(ACCESS_PREFIX, "");

	key = key.replace(DATE_SUFFIX, "");

	// The 3.5 line names its snapshots with a bare four-digit tag.
	if (/^gpt-3\.5/.test(key)) return "gpt-3.5";
	key = key.replace(SHORT_SNAPSHOT, "");

	// Turbo is its own release, so it is matched before variant stripping would eat it.
	if (/^gpt-4-turbo/.test(key)) return "gpt-4-turbo";

	// Only strip variants from ids that carry a family we recognise. `chat-latest` is
	// *entirely* variant suffix, and stripping it left the meaningless rung "chat".
	if (!KNOWN_FAMILY.test(key)) return key;

	// Strip repeatedly: `gpt-5-chat-latest` carries two.
	let previous;
	do { previous = key; key = key.replace(VARIANT_SUFFIX, ""); } while (key !== previous);

	// Anthropic publishes its generation as hyphenated parts (`claude-haiku-4-5`).
	const claude = /^(claude-[a-z]+(?:-\d+)*)/.exec(key);
	if (claude) return claude[1];

	const gpt = /^(gpt-\d+(?:\.\d+)?o?)/.exec(key);
	if (gpt) return gpt[1];

	const oSeries = /^(o\d+)/.exec(key);
	if (oSeries) return oSeries[1];

	return key;
}

/**
 * @description Reads a comparable version number out of a rung key, for tie-breaking
 *   generations that publish no dated snapshot.
 * @param {string} rung - A rung key.
 * @returns {number|null} A numeric version, or null when it has none.
 */
function versionOf(rung) {
	const gpt = /^gpt-(\d+(?:\.\d+)?)/.exec(rung);
	if (gpt) return Number(gpt[1]);
	const oSeries = /^o(\d+)/.exec(rung);
	// The `o` series is a parallel line; its numbers are not comparable with the gpt
	// numbers, so it only ever tie-breaks against its own siblings.
	if (oSeries) return Number(oSeries[1]);
	return null;
}

/**
 * Groups candidates into generations, newest first.
 *
 * @description Dates every rung from the newest dated snapshot the catalogue publishes
 *   for any member of it, then sorts on that. A rung with no date is placed immediately
 *   above the newest dated rung of the same family that it outranks numerically, so an
 *   unreleased-looking generation such as `gpt-5.6` still leads the sweep.
 * @param {Array<{provider: string, model: string}>} candidates - Models to be evaluated.
 * @param {string[]} catalogue - The provider's full catalogue, dated snapshots included.
 *   This is the evidence for recency, so pass it before `selectCandidates` strips it.
 * @returns {Array<{rung: string, releasedAt: string|null, dated: boolean,
 *   models: Array<{provider: string, model: string}>}>} Rungs, newest first. Never throws.
 */
export function orderRungsNewestFirst(candidates, catalogue) {
	if (!Array.isArray(candidates) || candidates.length === 0) return [];
	const ids = Array.isArray(catalogue) ? catalogue : [];

	// Newest published date per rung, across the whole catalogue.
	const dateByRung = new Map();
	for (const id of ids) {
		if (typeof id !== "string") continue;
		const date = dateOf(id);
		if (!date) continue;
		const rung = rungKeyOf(id);
		if (!dateByRung.has(rung) || date > dateByRung.get(rung)) dateByRung.set(rung, date);
	}

	const grouped = new Map();
	for (const candidate of candidates) {
		const model = typeof candidate === "string" ? candidate : candidate?.model;
		if (typeof model !== "string") continue;
		const entry = typeof candidate === "string" ? { provider: null, model } : candidate;
		const rung = rungKeyOf(model);
		if (!grouped.has(rung)) grouped.set(rung, []);
		grouped.get(rung).push(entry);
	}

	const rungs = [...grouped.entries()].map(([rung, models]) => {
		const released = dateByRung.get(rung) ?? LEGACY_RELEASES[rung] ?? null;
		return {
			rung,
			releasedAt: released,
			dated: released !== null,
			version: versionOf(rung),
			models,
		};
	});

	// Give each undated rung an effective date: one day after the newest dated rung it
	// outranks numerically. Without this an undated generation sorts to the bottom, and
	// the sweep would open on the oldest models rather than the newest.
	const dated = rungs.filter((r) => r.dated);
	for (const r of rungs) {
		if (r.dated) { r.effective = r.releasedAt; continue; }
		const beaten = dated
			.filter((d) => d.version !== null && r.version !== null && d.version < r.version)
			.map((d) => d.releasedAt)
			.sort();
		// No numeric evidence at all: treat it as an alias for the newest thing there is.
		r.effective = beaten.length ? `${beaten.at(-1)}~` : "9999-99-99";
	}

	rungs.sort((a, b) => {
		if (a.effective !== b.effective) return a.effective < b.effective ? 1 : -1;
		// Same effective date: the higher version is the newer release.
		return (b.version ?? 0) - (a.version ?? 0);
	});

	return rungs.map(({ rung, releasedAt, dated: isDated, models }) => ({ rung, releasedAt, dated: isDated, models }));
}
