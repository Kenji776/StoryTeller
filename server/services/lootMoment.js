/**
 * Does this turn call for a loot roll, and against what?
 *
 * @description The reward has to be decided *before* the model is called, or the
 *   narration cannot describe the thing that was found — and a second call to add it
 *   afterwards costs money and arrives as an awkward postscript. So the signal has to
 *   come from something the server already has, and it does: the player's own words.
 *
 *   They are unambiguous far more often than not. The probed sessions said "I search
 *   the goblin bodies", "I work the lock on the iron-bound chest", "I look for
 *   treasure among the grave-goods". A heuristic over that text is not perfect, but
 *   the cost of both mistakes is small — a missed roll is a turn where nothing was
 *   found, which is the common case anyway, and a spurious roll usually finds nothing
 *   too.
 */

/** Verbs that mean "I am going through this for valuables". */
const LOOTING = /\b(loot|looting|plunder|pillage|ransack|rifling|rifle|scavenge|plunder|strip|plundering)\b/i;

/** Softer phrasings that only count when aimed at something worth taking. */
const SEEKING = /\b(search|searching|examine|examining|check|checking|investigate|investigating|look|looking|take|taking|grab|collect)\b/i;

/** What makes a search a search *for treasure*. */
const VALUABLES = /\b(treasure|valuables?|loot|coin|coins|gold|silver|jewel|jewels|jewell?ery|riches|hoard|spoils|anything useful|anything valuable|anything hidden|whatever (?:he|she|they|it) (?:was|were) carrying|what(?:ever)? (?:is|was) inside)\b/i;

/** The dead, and the things they leave behind. */
const REMAINS = /\b(bod(?:y|ies)|corpses?|remains|the fallen|the dead|carcass|pockets)\b/i;

/** Containers and hoards. Naming one of these outranks naming a corpse. */
const CONTAINERS = /\b(chest|coffer|strongbox|lockbox|safe|vault|cache|crate|casket|reliquary|footlocker|grave-?goods|hoard|treasury|trove|urn|sarcophagus|barrow)\b/i;

/** Opening one. */
const OPENING = /\b(open|opening|pry|prying|force|forcing|unlock|unlocking|pick|picking|lever|break|breaking|lift|lifting|smash)\b/i;

/**
 * Things you search that are not places treasure lives. Without these, "I search the
 * crowd for my brother" and "I search my memory" both read as payouts.
 */
const NOT_A_CONTAINER = /\b(crowd|memory|memories|mind|soul|heart|sky|horizon|faces?|feelings?|conscience)\b/i;

/**
 * @description Reads a challenge rating, including the fractional forms the model
 *   writes for rabble.
 * @param {*} cr - The rating as stored, e.g. "1/4", "7", 2.
 * @returns {number} The rating, or 0 when it cannot be read.
 */
function ratingOf(cr) {
	if (typeof cr === "number") return Number.isFinite(cr) ? cr : 0;
	if (typeof cr !== "string") return 0;

	const fraction = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(cr);
	if (fraction) {
		const denominator = Number(fraction[2]);
		return denominator ? Number(fraction[1]) / denominator : 0;
	}

	const whole = Number(cr);
	return Number.isFinite(whole) ? whole : 0;
}

/**
 * @description The tier of the strongest thing lying dead. Living enemies are not
 *   lootable, however keenly the player would like them to be.
 * @param {object} enemies - The lobby's enemy roster.
 * @returns {string|null} "boss", "elite" or "trash", or null when nothing is dead.
 */
function tierOfTheDead(enemies) {
	const dead = Object.values(enemies || {}).filter((e) => e?.status === "dead");
	if (!dead.length) return null;

	const strongest = Math.max(...dead.map((e) => ratingOf(e.cr)));
	if (strongest >= 5) return "boss";
	if (strongest >= 2) return "elite";
	return "trash";
}

/**
 * Decides whether this turn is one where treasure could appear.
 *
 * @param {object} [opts] - The turn.
 * @param {string} [opts.action] - What the player said they are doing.
 * @param {object} [opts.enemies] - The lobby's enemy roster, for what lies dead.
 * @returns {{source: string}|null} The loot source for `rollLoot`, or null when this
 *   is not a looting turn at all.
 */
export function detectLootMoment({ action, enemies } = {}) {
	if (typeof action !== "string" || !action.trim()) return null;

	// A named container outranks everything else — the player has told us what they
	// are interested in, and it is not the goblin on the floor.
	const namesContainer = CONTAINERS.test(action);
	if (namesContainer && (OPENING.test(action) || SEEKING.test(action) || LOOTING.test(action))) {
		return { source: "cache" };
	}

	if (NOT_A_CONTAINER.test(action)) return null;

	const looting = LOOTING.test(action);
	const seekingValuables = SEEKING.test(action) && (VALUABLES.test(action) || REMAINS.test(action));
	if (!looting && !seekingValuables) return null;

	// Going through the dead pays according to what died. Everything else — turning
	// over a study, a storeroom, a wagon — is an ordinary search.
	const aimedAtRemains = REMAINS.test(action) || looting;
	const dead = aimedAtRemains ? tierOfTheDead(enemies) : null;

	return { source: dead ?? "search" };
}
