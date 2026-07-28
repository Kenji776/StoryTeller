/**
 * repairs — reading the server's repair catalogue into the shapes the console needs.
 *
 * The catalogue (`server/services/adminRepairs.js`) describes each repair as a
 * label, a note and a list of field names. The old panel rendered that literally:
 * a row of bare text boxes per repair, including one you typed a character's name
 * into. Getting the name wrong was the most likely way to use it and produced a
 * refusal rather than a fix.
 *
 * Splitting the catalogue by whether a repair names a character lets the player
 * inspector offer the player-scoped ones with the name already filled in, and the
 * lobby-wide ones live where they belong instead.
 */

/** The catalogue field naming a character. */
export const PLAYER_FIELD = "player";

/**
 * @description Reads a catalogue entry's field list defensively.
 * @param {object} repair - A catalogue entry.
 * @returns {Array<string>} The fields, or an empty list.
 */
function fieldsOf(repair) {
	return Array.isArray(repair?.fields) ? repair.fields : [];
}

/**
 * @description Reports whether a repair acts on one named character.
 * @param {object} repair - A catalogue entry.
 * @returns {boolean} Whether it takes a player.
 */
export function isPlayerRepair(repair) {
	return fieldsOf(repair).includes(PLAYER_FIELD);
}

/**
 * @description Selects the repairs that act on a named character.
 * @param {Array<object>} catalogue - The server's repair catalogue.
 * @returns {Array<object>} The player-scoped repairs, in catalogue order.
 */
export function playerRepairs(catalogue) {
	return (Array.isArray(catalogue) ? catalogue : []).filter(isPlayerRepair);
}

/**
 * @description Selects the repairs that act on the lobby as a whole.
 * @param {Array<object>} catalogue - The server's repair catalogue.
 * @returns {Array<object>} The lobby-scoped repairs, in catalogue order.
 */
export function lobbyRepairs(catalogue) {
	return (Array.isArray(catalogue) ? catalogue : []).filter((repair) => !isPlayerRepair(repair));
}

/**
 * @description Lists a repair's fields with the player omitted.
 *
 *   Used where the character is already chosen — the inspector knows who is
 *   selected, so asking again invites a typo and nothing else.
 * @param {object} repair - A catalogue entry.
 * @returns {Array<string>} The remaining field names, in order.
 */
export function fieldsExcludingPlayer(repair) {
	return fieldsOf(repair).filter((field) => field !== PLAYER_FIELD);
}
