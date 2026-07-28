/**
 * coerce — turning repair form text into the payload the server expects.
 *
 * The repair catalogue (`server/services/adminRepairs.js`) describes each repair as
 * a list of field *names*, so the browser has to decide what type each value is.
 * The old panel did that inline and skipped every empty box, which meant the one
 * repair documented as "an empty list clears them" could never be given an empty
 * list — `conditions:set` refused with "Conditions must be a list" instead.
 *
 * Blank now means two different things depending on the field, which is exactly why
 * it belongs in a tested function rather than inline in a click handler.
 */

/** Fields the server expects as an array rather than a scalar. */
export const LIST_FIELDS = Object.freeze(new Set(["conditions"]));

/**
 * Fields whose value is a number, so that a character named "7" is not silently
 * turned into the integer 7 and matched against nothing.
 */
const NUMBER_FIELDS = Object.freeze(new Set(["hp", "used"]));

/**
 * @description Converts one field's raw text into its payload value.
 *
 *   A blank scalar is absent — the admin left the box alone and the server should
 *   not receive a key at all. A blank *list* is present and empty, because clearing
 *   a list is a real instruction and there is no other way to express it.
 * @param {string} field - The field name from the repair catalogue.
 * @param {string} raw - The raw input value.
 * @returns {{present: boolean, value: *}} Whether to send the key, and its value.
 */
export function coerceField(field, raw) {
	const text = typeof raw === "string" ? raw.trim() : "";

	if (LIST_FIELDS.has(field)) {
		return {
			present: true,
			value: text.split(",").map((item) => item.trim()).filter(Boolean),
		};
	}

	if (text === "") return { present: false, value: null };

	if (NUMBER_FIELDS.has(field)) {
		const numeric = Number(text);
		return { present: true, value: Number.isNaN(numeric) ? text : numeric };
	}

	return { present: true, value: text };
}

/**
 * @description Assembles the payload for one repair.
 * @param {Array<string>} fields - Field names, from the catalogue entry.
 * @param {function(string): string} read - Returns the raw text for a field name.
 * @returns {object} A null-prototype payload carrying only the fields that are
 *   present, so a field name colliding with `Object.prototype` cannot smuggle an
 *   inherited value into the socket frame.
 * @throws {TypeError} When `read` is not a function.
 */
export function buildRepairPayload(fields, read) {
	if (typeof read !== "function") {
		throw new TypeError(`buildRepairPayload needs a read function, received ${typeof read}`);
	}
	const payload = Object.create(null);
	for (const field of Array.isArray(fields) ? fields : []) {
		const { present, value } = coerceField(field, read(field));
		if (present) payload[field] = value;
	}
	return payload;
}
