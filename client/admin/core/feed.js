/**
 * feed — turning socket traffic into readable activity lines.
 *
 * Every formatter lives here rather than beside its socket handler, so the whole
 * vocabulary of the activity log can be read in one place and tested without a
 * socket. The handlers in `core/socket.js` do nothing but hand events over.
 *
 * Entries carry plain text, never markup. Escaping is the render layer's job, and
 * doing it here would mean every consumer had to know whether it had already
 * happened.
 */

import { collapseWhitespace, truncate } from "./text.js";

/** Longest narration excerpt kept in the feed, including its ellipsis. */
const NARRATION_MAX = 300;

/** Longest player action kept in the feed. Shorter than narration: an action is a
 *  sentence, and anything longer is a player pasting. */
const ACTION_MAX = 220;

/** The filter vocabulary, in the order the filter control offers it. */
export const FEED_TYPES = Object.freeze([
	{ id: "all", label: "All activity" },
	{ id: "xp", label: "XP / Level" },
	{ id: "hp", label: "HP" },
	{ id: "gold", label: "Gold" },
	{ id: "turn", label: "Turns" },
	{ id: "action", label: "Player actions" },
	{ id: "dm", label: "Narration" },
	{ id: "death", label: "Deaths" },
	{ id: "roll", label: "Rolls" },
	{ id: "cond", label: "Conditions" },
	{ id: "inv", label: "Inventory" },
	{ id: "music", label: "Music" },
	{ id: "sfx", label: "Sound FX" },
	{ id: "sys", label: "System" },
]);

/** Filter ids that exist, for telling "show everything" from a typo. */
const KNOWN_FILTERS = new Set(FEED_TYPES.map((type) => type.id));

/**
 * @description Renders a change with an explicit sign, so direction is never
 *   ambiguous at a glance.
 * @param {*} delta - The change.
 * @returns {string} The signed number.
 */
function signed(delta) {
	const value = Number(delta) || 0;
	return value >= 0 ? `+${value}` : String(value);
}

/**
 * @description Renders a list, or a word meaning the list is empty.
 * @param {Array<*>} items - The list.
 * @param {string} [empty="none"] - Shown when there is nothing in it.
 * @returns {string} The rendered list.
 */
function list(items, empty = "none") {
	const values = (Array.isArray(items) ? items : []).filter(Boolean);
	return values.length ? values.join(", ") : empty;
}

/**
 * @description Renders a music mood id as words.
 * @param {*} mood - A mood id such as `"tense_combat"`.
 * @returns {string|null} The mood in words, or null when nothing is playing.
 */
function moodLabel(mood) {
	return typeof mood === "string" && mood ? mood.replace(/_/g, " ") : null;
}

/**
 * One formatter per socket event. Each returns `[type, message]`, or null when the
 * event carries nothing worth showing.
 */
/**
 * Every event this module knows how to render.
 *
 * @description Exported so a test can hold it against the list the socket layer
 *   actually subscribes to. A renderer for an event nobody forwards is dead code
 *   that looks like a working feature, which is how `player:action` could have been
 *   written, tested, and still never appeared in the log.
 * @returns {string[]} The event names with formatters.
 */
export function renderableEvents() {
	return Object.keys(FORMATTERS);
}

const FORMATTERS = Object.freeze({
	"xp:update": (p) => {
		const amount = Number(p.amount) || 0;
		const reason = p.reason || "Manual adjustment";
		const verb = amount < 0 ? `lost ${Math.abs(amount)}` : `gained ${amount}`;
		return ["xp", `${p.player} ${verb} XP (${reason}) — now ${p.xp} XP`];
	},

	"player:levelup": (p) => ["xp", `Level up! Now level ${p.newLevel}`],

	"hp:update": (p) =>
		["hp", `${p.player} ${signed(p.delta)} HP (${p.reason || "Manual change"}) — now ${p.hp} HP`],

	"gold:update": (p) =>
		// Only say why when a reason was actually given. Defaulting to "Manual change"
		// labelled every DM-driven change as an admin edit — the opposite of the truth.
		["gold", `${p.player} ${signed(p.delta)} gold${p.reason ? ` (${p.reason})` : ""} — now ${p.gold}`],

	"turn:update": (p) => ["turn", `Turn: ${p.current ?? "nobody"} | Order: ${list(p.order, "empty")}`],

	// What the player actually asked to do. Without this the feed showed whose turn
	// it was and how the DM replied, with the player's own words missing from
	// between them — the one line that explains why the turn went as it did.
	"player:action": (p) => {
		if (typeof p.text !== "string" || !p.text.trim()) return null;
		const text = collapseWhitespace(p.text);
		return text ? ["action", `${p.player ? `${p.player}: ` : ""}${truncate(text, ACTION_MAX)}`] : null;
	},

	"narration": (p, { toText }) => {
		// The TTS path emits a contentless twin of every narration; rendering it
		// printed a bare "null" line in the feed for every DM beat.
		if (typeof p.content !== "string" || !p.content.trim()) return null;
		const text = collapseWhitespace(toText(p.content));
		return text ? ["dm", truncate(text, NARRATION_MAX)] : null;
	},

	"player:death": (p) => ["death", p.message || `${p.player} has died!`],

	"music:change": (p) => {
		const mood = moodLabel(p.mood);
		return ["music", mood ? `Music changed to: ${mood}` : "Music stopped"];
	},

	"sfx:play": (p) => {
		const names = (Array.isArray(p.effects) ? p.effects : []).map((fx) => fx?.name || fx?.file);
		const rendered = list(names, "");
		return rendered ? ["sfx", `SFX: ${rendered}`] : null;
	},

	"roll:required": (p) => ["roll", `${p.player} must roll d${p.sides} (${list(p.stats, "no stat")})`],

	// {player, kind, value, detail:{base, bonus, stat, outcome}} — the shape the
	// server sends. Reading {sides, roll, total} rendered every roll as "dundefined".
	"dice:result": (p) => ["roll", `${p.player}: ${p.kind ?? "roll"} = ${p.value ?? "?"}`
		+ (p.detail ? ` (${p.detail.base}${p.detail.bonus >= 0 ? "+" : ""}${p.detail.bonus})` : "")
		+ (p.detail?.outcome ? ` [${p.detail.outcome}]` : "")],

	"conditions:update": (p) => ["cond", `${p.player} conditions: ${list(p.conditions)}`],

	"inventory:update": (p) =>
		["inv", `${p.player} ${signed(p.change)} ${p.item} (now: ${p.newCount})`],

	"spellslots:update": (p) => ["sys", `${p.player} spell slots: ${p.spellSlotsUsed}/${p.maxSlots} used`],

	"player:kicked": (p) => ["sys", `Player kicked: ${p.reason || "no reason given"}`],

	"rest:vote:start": (p) => ["sys", `${p.proposer} proposed a ${p.type} rest`],

	"rest:vote:result": (p) => ["sys", `${p.type} rest vote ${p.passed ? "passed" : "failed"}`],

	"game:over": (p) => ["sys", `Game over: ${p.reason || "no reason given"}`],

	"toast": (p) => ["sys", `[${String(p.type || "info").toUpperCase()}] ${p.message}`],
});

/**
 * @description Formats one socket event as an activity entry.
 * @param {string} event - The socket event name.
 * @param {object} [payload] - The event payload.
 * @param {object} [deps] - Injected collaborators.
 * @param {function(): number} [deps.now=Date.now] - Clock, injected so tests are deterministic.
 * @param {function(string): string} [deps.toText] - Renders DM markup as plain text.
 *   Defaults to identity; the browser passes the DOM-backed implementation.
 * @returns {{type: string, message: string, at: number}|null} The entry, or null for
 *   an event with nothing worth showing — an unknown event, or a narration whose
 *   content is absent.
 */
export function toFeedEntry(event, payload = {}, deps = {}) {
	const format = typeof event === "string" ? FORMATTERS[event] : undefined;
	if (!format) return null;

	const { now = Date.now, toText = (html) => String(html) } = deps;
	const result = format(payload ?? {}, { toText });
	if (!result) return null;

	const [type, message] = result;
	return { type, message, at: now() };
}

/**
 * @description Reports whether an entry survives the active filter.
 *
 *   An unrecognised filter shows everything. Hiding the whole log because a stored
 *   filter value no longer exists would look like the feed had stopped working.
 * @param {object} entry - An entry from {@link toFeedEntry}.
 * @param {string} filter - A `FEED_TYPES` id.
 * @returns {boolean} Whether to show it.
 */
export function matchesFilter(entry, filter) {
	if (!entry) return false;
	if (typeof filter !== "string" || !KNOWN_FILTERS.has(filter) || filter === "all") return true;
	return entry.type === filter;
}
