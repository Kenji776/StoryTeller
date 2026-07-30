/**
 * dmReply — the structural verdict on one raw Dungeon Master reply.
 *
 * This is the narrowest question in the whole evaluation, and the one that
 * decides viability: did the model emit the object the game loop consumes, and
 * did it do so *without* needing repair?
 *
 * The distinction between `parsed` and `cleanParse` is the load-bearing one.
 * `server/helpers/parseDMJson.js` will rescue a fenced or prose-prefixed reply,
 * and two of its five stages spend another model call to do it. A model that is
 * only ever rescued is playable in the sense that the game does not crash, and
 * unusable in the sense that every turn costs double and arrives late. Scoring
 * them the same would recommend models that make the table unaffordable.
 *
 * Everything here is pure and synchronous: no model call, no network, no clock.
 */

/** Top-level keys the live prompt requires in every reply (`lobbyPrompts.js`). */
export const REQUIRED_KEYS = [
	"text", "updates", "prompt", "roll", "suggestions", "spellUsed", "music", "combat_over", "sfx",
];

/**
 * Keys whose contract explicitly admits `null` as a real value rather than an omission.
 *
 * Absence is therefore not a fault: every reader in the game loop does a falsy check,
 * so a model that omits one of these produces byte-identical behaviour to a model that
 * sends `null`. Counting it marked models down for nothing.
 */
export const NULLABLE_KEYS = ["roll", "music", "illustrate"];

/** Fast membership for the above. */
const NULLABLE = new Set(NULLABLE_KEYS);

/**
 * The keys the *opening scene* prompt asks for — four, not nine.
 *
 * `lobbyPrompts.buildOpeningPrompt` sends a deliberately reduced schema: there is no
 * combat, no state to update and nothing to roll before anyone has acted. Judging the
 * opening against the turn schema charged every model for obeying its instructions.
 */
export const OPENING_KEYS = ["text", "music", "sfx", "suggestions"];

/** Fields an enemy stat block must carry for the server to maintain a roster. */
const ENEMY_FIELDS = ["name", "hp", "max_hp", "ac", "status"];

/** Fields each kind of state event must carry to be applied rather than discarded. */
const EVENT_FIELDS = {
	xp: ["player", "amount", "reason"],
	hp: ["player", "delta", "reason", "new_total"],
	inventory: ["player", "item", "change_type"],
	gold: ["player", "delta"],
	conditions: ["player"],
	abilities: ["player", "change_type", "name"],
};

/** A quoted key opening an object — how leaked JSON looks, and how HTML never does. */
const JSON_IN_TEXT = /\{\s*"/;

/**
 * Markdown a narrator is told not to emit. Each alternative is paired or
 * line-anchored so that ordinary prose punctuation does not read as markup.
 */
const MARKDOWN_IN_TEXT = /\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|^\s{0,3}#{1,6}\s|^\s{0,3}[-*+]\s+\S|\[[^\]]+\]\([^)]+\)/m;

/** A leading markdown code fence, optionally language-tagged. */
const LEADING_FENCE = /^\s*```[a-zA-Z]*\s*\n?/;

/**
 * @description Reports whether a value is a plain, non-array object.
 * @param {*} v - Any value.
 * @returns {boolean} True for `{}`-shaped values only.
 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @description Checks one top-level key against its contract.
 * @param {string} key - The key name.
 * @param {*} value - The value found under it.
 * @returns {boolean} True when the value is usable by the game loop.
 */
function keyIsWellTyped(key, value) {
	if (NULLABLE.has(key) && value === null) return true;
	switch (key) {
		// An empty narration is structurally a string and practically a blank turn:
		// the players are shown nothing and the beat is lost, so it fails here.
		case "text":        return typeof value === "string" && value.trim() !== "";
		case "prompt":      return typeof value === "string";
		case "updates":     return isPlainObject(value);
		case "roll":        return isPlainObject(value);
		case "music":       return typeof value === "string";
		case "suggestions": return Array.isArray(value);
		case "sfx":         return Array.isArray(value);
		case "spellUsed":   return typeof value === "boolean";
		case "combat_over": return typeof value === "boolean";
		default:            return true;
	}
}

/**
 * @description Finds the first balanced `{…}` block, tracking string state so a brace
 *   inside a narration does not terminate the object early.
 * @param {string} s - The text to scan.
 * @returns {string|null} The block, or null when there is no balanced object.
 */
function firstJsonBlock(s) {
	const start = s.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * @description Counts the entries of one state-event array and reports whether any
 *   entry is missing a field the applier needs.
 * @param {*} list - The value found under an event key.
 * @param {string[]} fields - Fields every entry must carry.
 * @returns {{count: number, malformed: boolean}} The tally.
 */
function tallyEvents(list, fields) {
	if (!Array.isArray(list)) return { count: 0, malformed: list !== undefined };
	const malformed = list.some((e) =>
		!isPlainObject(e) || fields.some((f) => e[f] === undefined || e[f] === null));
	return { count: list.length, malformed };
}

/**
 * Judges one raw DM reply against the contract the game loop depends on.
 *
 * @description Answers three separable questions, because a model can fail any one
 *   of them independently and the remedies differ: did it produce JSON at all, did
 *   that JSON carry the keys and types the appliers read, and did narration-only
 *   content stay out of the fields the server parses (and vice versa).
 * @param {string} raw - The reply exactly as the provider returned it.
 * @param {object} [options] - Inspection options.
 * @param {string[]} [options.requiredKeys=REQUIRED_KEYS] - The key set this reply was
 *   actually asked for. Defaults to the turn schema; pass {@link OPENING_KEYS} for an
 *   opening scene, whose prompt requests four keys rather than nine. Anything that is
 *   not a non-empty array of strings falls back to the turn schema, so a bad option
 *   cannot silently switch checking off.
 * @returns {{parsed: boolean, cleanParse: boolean, usedFence: boolean,
 *   leadingProse: boolean, missingKeys: string[], typeErrors: string[],
 *   malformedEvents: string[], jsonInText: boolean, markdownInText: boolean,
 *   text: string|null, enemies: object[], activeEnemies: number,
 *   combatOver: boolean|null, events: object}} The verdict. Never throws: a
 *   provider can return anything, including nothing, and an evaluation harness
 *   that dies on bad input cannot grade the models that produce it.
 */
export function inspectDMReply(raw, options = {}) {
	const requested = options?.requiredKeys;
	const requiredKeys = Array.isArray(requested) && requested.length && requested.every((k) => typeof k === "string")
		? requested
		: REQUIRED_KEYS;
	const verdict = {
		parsed: false,
		cleanParse: false,
		usedFence: false,
		leadingProse: false,
		missingKeys: [],
		typeErrors: [],
		malformedEvents: [],
		jsonInText: false,
		markdownInText: false,
		text: null,
		enemies: [],
		activeEnemies: 0,
		combatOver: null,
		events: { xp: 0, hp: 0, inventory: 0, gold: 0, conditions: 0, abilities: 0, enemies: 0 },
	};

	if (typeof raw !== "string" || raw.trim() === "") return verdict;

	// A direct parse of the untouched body is the only thing that counts as clean;
	// everything below is a repair the game would have had to perform.
	const trimmed = raw.trim();
	let obj = null;
	try {
		const direct = JSON.parse(trimmed);
		if (isPlainObject(direct)) { obj = direct; verdict.cleanParse = true; }
	} catch { /* fall through to the repair-shaped paths */ }

	if (!obj) {
		verdict.usedFence = LEADING_FENCE.test(trimmed);
		const body = trimmed.replace(LEADING_FENCE, "").replace(/\s*```\s*$/, "");
		const block = firstJsonBlock(body);
		if (block) {
			// Anything other than whitespace ahead of the object is the model talking
			// to us instead of to the parser.
			verdict.leadingProse = !verdict.usedFence && body.slice(0, body.indexOf("{")).trim() !== "";
			try {
				const candidate = JSON.parse(block);
				if (isPlainObject(candidate)) obj = candidate;
			} catch { /* unrecoverable at this tier — parseDMJson's later stages may still win */ }
		}
	}

	if (!obj) return verdict;
	verdict.parsed = true;

	for (const key of requiredKeys) {
		if (!Object.prototype.hasOwnProperty.call(obj, key)) {
			// An omitted nullable key is indistinguishable from an explicit null to every
			// reader downstream, so it is not a fault.
			if (!NULLABLE.has(key)) verdict.missingKeys.push(key);
			continue;
		}
		if (!keyIsWellTyped(key, obj[key])) verdict.typeErrors.push(key);
	}

	if (typeof obj.text === "string") {
		verdict.text = obj.text;
		verdict.jsonInText = JSON_IN_TEXT.test(obj.text);
		verdict.markdownInText = MARKDOWN_IN_TEXT.test(obj.text);
	}

	if (typeof obj.combat_over === "boolean") verdict.combatOver = obj.combat_over;

	const updates = isPlainObject(obj.updates) ? obj.updates : {};
	for (const [kind, fields] of Object.entries(EVENT_FIELDS)) {
		const { count, malformed } = tallyEvents(updates[kind], fields);
		verdict.events[kind] = count;
		if (malformed) verdict.malformedEvents.push(kind);
	}

	if (Array.isArray(updates.enemies)) {
		verdict.enemies = updates.enemies.filter(isPlainObject).map((e) => ({
			name: typeof e.name === "string" ? e.name : null,
			hp: Number(e.hp),
			max_hp: Number(e.max_hp),
			status: typeof e.status === "string" ? e.status.toLowerCase() : "active",
		}));
		verdict.events.enemies = updates.enemies.length;
		// A creature the model never explicitly killed is still on the roster, which
		// is how the server reads it too.
		verdict.activeEnemies = verdict.enemies.filter((e) => e.status !== "dead" && e.status !== "fled").length;
		const bad = updates.enemies.some((e) =>
			!isPlainObject(e) || ENEMY_FIELDS.some((f) => e[f] === undefined || e[f] === null));
		if (bad) verdict.malformedEvents.push("enemies");
	} else if (updates.enemies !== undefined) {
		verdict.malformedEvents.push("enemies");
	}

	return verdict;
}
