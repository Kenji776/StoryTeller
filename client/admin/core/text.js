/**
 * text — string helpers with no DOM dependency.
 *
 * The old panel escaped by round-tripping through a detached `<div>`, which works
 * in a browser and cannot be unit tested anywhere else. These are pure so the
 * modules that depend on them stay testable under `node --test`.
 */

/** Characters that must not survive into markup, and what they become. */
const ESCAPES = Object.freeze({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
});

/** Matches every character in {@link ESCAPES}. */
const ESCAPABLE = /[&<>"']/g;

/** Any run of whitespace, including the newlines DM markup arrives with. */
const WHITESPACE = /\s+/g;

/**
 * @description Renders a value as a string, treating absence as empty.
 * @param {*} value - Any value.
 * @returns {string} The rendered text; `""` for null and undefined.
 */
function asString(value) {
	return value === null || value === undefined ? "" : String(value);
}

/**
 * @description Escapes a value for interpolation into HTML.
 *
 *   `&` is in the table and the expression is a single pass, so an already-escaped
 *   string is escaped again rather than being left alone. That is deliberate: this
 *   is called on model output and player input, where guessing whether something
 *   has already been through here is how double-decoding bugs start.
 * @param {*} value - Any value; non-strings are stringified first.
 * @returns {string} The escaped text.
 */
export function esc(value) {
	return asString(value).replace(ESCAPABLE, (char) => ESCAPES[char]);
}

/**
 * @description Collapses every run of whitespace to a single space and trims.
 * @param {*} value - Any value; non-strings are stringified first.
 * @returns {string} The collapsed text.
 */
export function collapseWhitespace(value) {
	return asString(value).replace(WHITESPACE, " ").trim();
}

/**
 * @description Shortens text to a maximum length, marking that it was cut.
 *
 *   The ellipsis is counted against the maximum rather than added to it, so a
 *   caller budgeting a fixed number of characters gets one.
 * @param {*} value - Any value; non-strings are stringified first.
 * @param {number} max - Longest permitted result *including* the ellipsis.
 * @returns {string} The original text, or a shortened form ending in `…`.
 * @throws {RangeError} When `max` is not a positive integer.
 */
export function truncate(value, max) {
	if (!Number.isInteger(max) || max < 1) {
		throw new RangeError(`truncate needs a positive integer maximum, received ${JSON.stringify(max)}`);
	}
	const text = asString(value);
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
