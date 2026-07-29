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
 *
 *   A quest reward is the exception, on both counts. It is the only source the player's
 *   words cannot identify alone — "I hand over the amulet to the elder" and "I hand over
 *   my sword to the guard" are the same sentence, and only what the narrator said last
 *   turn separates them. And it is the only source that pays an item every single time,
 *   so a false positive here is not a wasted turn, it is a free legendary. So it is
 *   detected from *both* sides: the narrator must have offered a reward on its previous
 *   turn, and the player must be collecting or delivering rather than refusing, paying,
 *   or looting a corpse. Missing one is the cheap mistake and the design prefers it.
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

// ── The quest reward, read from both sides of the table ──────────────────────

/**
 * The narrator putting a reward on the table, matched against its *previous* narration.
 * This is the necessary half: without it there is no quest reward, whatever the player
 * types. Kept to language about being owed for work done — "treasure" and "gold" are
 * absent on purpose, because a narration mentioning gold is every other loot source.
 */
const OFFERED = /\b(?:rewards?|rewarded|payment|wages|bounty|recompense|compensation|earned|as\s+(?:we\s+)?(?:agreed|promised)|for\s+your\s+(?:trouble|help|service|services|aid|efforts?)|owes?\s+you|owed\s+you|promised\s+you|your\s+pay)\b/i;

/** Verbs that mean "something is being given to me and I am taking it". */
const ACCEPTING = /\b(?:accepts?|accepting|takes?|taking|claims?|claiming|collects?|collecting|receives?|receiving|pockets?|pocketing)\b/i;

/**
 * What is being handed over. Narrow on purpose: a reward is a thing you are owed, not a
 * thing you found, so "treasure", "loot" and "gold" are deliberately not here — they
 * belong to `cache` and `search`, which already cover them.
 */
const REWARD = /\b(?:rewards?|payments?|wages|bounty|bounties|recompense|compensation|prize|boon|purse|(?:my|our|the|his|her|their)\s+pay\b|(?:my|our)\s+(?:share|cut)\b|what\s+(?:i\s+was|we\s+were)\s+(?:owed|promised)|what\s+(?:he|she|they)\s+promised)\b/i;

/**
 * Delivering the thing the job was about. `return` and `present` are absent by
 * deliberate choice — "I return to the tavern" and "I present myself to the guard"
 * are not turn-ins, and no amount of context in a regex separates them from ones
 * that are.
 */
const TURNING_IN = new RegExp([
	// "I turn in the quest", "I turn the amulet in" — but not "I turn into a wolf".
	String.raw`\bturn(?:s|ing)?\s+(?:(?:it|them|this|that|the\s+[\w'-]+)\s+)?in\b`,
	// "I hand over the amulet", "I hand the letter over", "I hand her my report".
	String.raw`\bhand(?:s|ing)?\s+(?:over|in|it|them|(?:the|my|our|his|her|their)\s+[\w'-]+)\b`,
	// "I deliver the letter" — but not "I deliver a kick to its ribs".
	String.raw`\bdeliver(?:s|ing)?\s+(?:the|it|them|my|our|his|her|their)\b`,
	String.raw`\bcomplet(?:e|es|ed|ing)\s+the\s+(?:quest|job|contract|task|errand|bounty)\b`,
].join("|"), "i");

/** Saying no. "I refuse to take the reward" names a reward and a taking verb, and is not one. */
const REFUSING = /\b(?:refus(?:e|es|ed|ing)|declin(?:e|es|ed|ing)|reject(?:s|ed|ing)?|turn(?:s|ing)?\s+down|wo(?:n['’]t|uld\s+not)\s+take|will\s+not\s+take|no\s+thank\s+you)\b/i;

/**
 * The player is the one paying. Without this, "I hand over the payment to the smith"
 * reads as collecting one, and the party is paid for buying something.
 */
const PAYING_OUT = /\b(?:pay|pays|paying|paid)\s+(?:the|him|her|them|for|my|our|it|up|out)\b|\bhand(?:s|ing)?\s+(?:over\s+)?(?:the\s+|my\s+|our\s+)?(?:payment|coins?|gold|silver|money|purse|fee)\b|\bmy\s+own\s+(?:coin|gold|purse|money)\b/i;

/** Rewarding yourself is buying a drink. It names a reward and it is not one. */
const SELF_REWARD = /\breward(?:s|ing)?\s+(?:myself|ourselves|himself|herself|themselves|itself)\b/i;

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
 * @description What the narrator last said, still in whatever form it was stored. The
 *   player's own action has already been appended by `appendUser` when this runs, so the
 *   newest assistant entry is the turn the player is answering — never the last entry.
 * @param {*} history - The lobby's `history` array, or anything at all.
 * @returns {string} The stored content, or "" when there is no readable DM turn.
 */
function newestDMTurn(history) {
	if (!Array.isArray(history)) return "";

	const entry = [...history].reverse().find((e) => e?.role === "assistant");
	return typeof entry?.content === "string" ? entry.content.trim() : "";
}

/**
 * @description Unwraps the prose from a stored DM turn. `appendDM` writes the model's
 *   raw JSON reply, so the narration sits in a `text` property rather than being the
 *   entry itself — the same unwrapping `autoSummarize` does for the same reason. Older
 *   lobbies and the opening scene hold bare prose, and a reply cut off mid-stream holds
 *   neither but is still readable behind a JSON prefix. None of the three throws: this
 *   runs inside the action handler, and an entry nobody will ever read must not cost a
 *   player their turn.
 * @param {string} stored - A turn as `newestDMTurn` returns it.
 * @returns {string} The narration, or the raw text when it cannot be unwrapped.
 */
function narrationOf(stored) {
	if (!stored.startsWith("{")) return stored;

	try {
		const parsed = JSON.parse(stored);
		return typeof parsed?.text === "string" ? parsed.text : stored;
	} catch {
		return stored;
	}
}

/**
 * Is the player collecting a reward the narrator has just offered?
 *
 * @description Both sides have to agree, and the asymmetry of the mistakes is why. A
 *   quest reward pays an item on every single roll — `SOURCE_PROFILE.quest` is 100% —
 *   so a false positive conjures a rarity-biased item out of a sentence, where a false
 *   positive on `search` usually finds nothing. A miss just leaves the turn as it was.
 * @param {string} action - What the player said they are doing.
 * @param {*} history - The lobby's `history` array.
 * @returns {boolean} True when this is a quest hand-over.
 */
function isQuestReward(action, history) {
	if (!OFFERED.test(narrationOf(newestDMTurn(history)))) return false;

	// Going through a corpse pays what the corpse is worth, however warmly the elder
	// was speaking last turn. Without this, every post-fight search on a turn-in scene
	// would be promoted from `trash` to a guaranteed item.
	if (REMAINS.test(action)) return false;

	if (REFUSING.test(action) || PAYING_OUT.test(action) || SELF_REWARD.test(action)) return false;

	return (ACCEPTING.test(action) && REWARD.test(action)) || TURNING_IN.test(action);
}

/**
 * Decides whether this turn is one where treasure could appear.
 *
 * @param {object} [opts] - The turn.
 * @param {string} [opts.action] - What the player said they are doing.
 * @param {object} [opts.enemies] - The lobby's enemy roster, for what lies dead.
 * @param {Array<object>} [opts.history] - The lobby's history, read only for the
 *   narrator's most recent turn. Omitted, no quest reward is ever detected — every
 *   other source is decided from `action` alone and is unaffected.
 * @returns {{source: string}|null} The loot source for `rollLoot`, or null when this
 *   is not a looting turn at all.
 */
export function detectLootMoment({ action, enemies, history } = {}) {
	if (typeof action !== "string" || !action.trim()) return null;

	// A named container outranks everything else — the player has told us what they
	// are interested in, and it is not the goblin on the floor.
	const namesContainer = CONTAINERS.test(action);
	if (namesContainer && (OPENING.test(action) || SEEKING.test(action) || LOOTING.test(action))) {
		return { source: "cache" };
	}

	// Checked ahead of the search path because a reward being handed over is a stronger
	// reading than a room being turned over, and checked ahead of `NOT_A_CONTAINER`
	// because "I accept the reward with a full heart" is not a search of anyone's heart.
	if (isQuestReward(action, history)) return { source: "quest" };

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
