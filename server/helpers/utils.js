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
