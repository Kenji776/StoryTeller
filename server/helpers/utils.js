/**
 * Normalizes a name string by converting underscores to spaces,
 * collapsing consecutive whitespace, and trimming leading/trailing whitespace.
 *
 * @param {string} [name=""] - The raw name string to normalize.
 * @returns {string} The normalized name string.
 */
export function normalizeName(name = "") {
	return String(name || "")
		.replace(/_/g, " ") // Convert underscores to spaces
		.replace(/\s+/g, " ") // Collapse duplicate spaces
		.trim();
}

/**
 * Reduces a name to a comparable form: lower case, punctuation flattened to spaces,
 * whitespace collapsed.
 *
 * @description The answer to "did the player type this name?", shared by ability
 *   matching in `actionFeasibility.js` and spell matching in `spellbook.js`. Players
 *   write "magic-missile", "Magic Missile" and `"MAGIC MISSILE"` interchangeably.
 *
 *   One function rather than a copy per consumer, for the reason `armourClass.js`
 *   exists: the same rule implemented twice drifts, and the drift is silent. Distinct
 *   from {@link normalizeName}, which prepares a name for *display* and so preserves
 *   case and punctuation — the two are not interchangeable.
 * @param {*} value - Raw name or phrase; any type, since callers pass untrusted input.
 * @returns {string} The comparable form, or "" when there is nothing comparable.
 */
export function normaliseForMatch(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Whether a phrase appears in a text as whole words.
 *
 * @description Substring matching is not good enough for names: "I delight in the chaos"
 *   must not cast Light, and "I always cast cure wounds" must not target a companion
 *   called Al. Both sides are normalised through {@link normaliseForMatch} first, so
 *   "magic-missile" finds "Magic Missile".
 *
 *   One implementation because there are three callers — spell names, ally names, and
 *   ability names — and hand-escaping a regex correctly in each is exactly the kind of
 *   thing that is wrong in one place and nowhere else.
 * @param {*} text - The haystack.
 * @param {*} phrase - The name or phrase to find.
 * @returns {boolean} True when the phrase appears as whole words.
 */
export function containsPhrase(text, phrase) {
	const key = normaliseForMatch(phrase);
	const haystack = normaliseForMatch(text);
	if (!key || !haystack) return false;
	// The normalised form is alphanumerics and spaces only, so nothing here can be a
	// regex metacharacter — but escaping anyway costs nothing and survives that changing.
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\b${escaped}\\b`).test(haystack);
}
