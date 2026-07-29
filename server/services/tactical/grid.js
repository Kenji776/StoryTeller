/**
 * The grid: cells, labels, distance, and what is standing on any given square.
 *
 * @description The bottom layer of the tactical map ([ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)).
 *   Everything spatial is built on this and nothing here knows about combat.
 *
 *   Two conventions carry through the whole feature. A cell is `[x, y]` with the origin at
 *   the top-left, because that is what arithmetic wants; a cell is `D7` when anybody reads
 *   it, because `[3, 6]` is not narratable. The conversion happens at the edges and nowhere
 *   in between.
 *
 *   Every reader here tolerates a malformed map. These functions run inside the turn
 *   pipeline, and a half-written map must not be able to take a turn down with it.
 */

/** Feet per cell when a map does not say. Five feet is the unit the spell ranges assume. */
export const DEFAULT_FEET_PER_CELL = 5;

/** Column letters. Generation is capped at 26 columns so a label is always one letter. */
const COLUMNS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * What each kind of scenery does, as a flat table.
 *
 * @description Three independent properties, deliberately not derived from one another: a
 *   pit stops a body without stopping an arrow, and a low wall is shot over while still
 *   being leaned behind. Adding scenery means adding a row here, never a branch elsewhere.
 *
 *   `sight` has three values rather than two, and the middle one exists because of something a
 *   rendered briefing showed:
 *
 *   - `blocked` — no shot at all, and nothing to be seen. A wall.
 *   - `obstructs` — the shot is still available, at this feature's cover. A pillar.
 *   - `clear` — no effect on sight whatsoever.
 *
 *   Pillars were `blocked` at first, which is physically true of a stone column and ruinous as a
 *   rule: eight of them in a nine-by-seven crypt meant nobody could see anybody, so ranged attacks
 *   mostly failed outright and *cover never engaged at all* — the measured crypt had nineteen
 *   full-cover cells against three of half. The single centre-line test is what turns "half cover"
 *   into "no shot"; 5e traces lines to a target's corners and grants total cover only when every
 *   one is blocked. `obstructs` is the cheap approximation of that, and it is what makes cover the
 *   common case it is supposed to be.
 *
 *   `cover` is what the feature grants to somebody sheltering at, beside, or behind it, and is
 *   read by `sight.js` — this module only reports it.
 */
export const FEATURE_RULES = {
	wall:     { movement: "blocked", sight: "blocked",   cover: "full" },
	pillar:   { movement: "blocked", sight: "obstructs", cover: "half" },
	low_wall: { movement: "blocked", sight: "clear",     cover: "half" },
	rubble:   { movement: "double",  sight: "clear",     cover: "none" },
	water:    { movement: "double",  sight: "clear",     cover: "none" },
	pit:      { movement: "blocked", sight: "clear",     cover: "none" },
};

/**
 * Open floor, and the answer for scenery nobody has heard of.
 *
 * @description The narrator invents words. Treating an unknown one as a wall would let a
 *   stray adjective seal a room and softlock the encounter, so the permissive reading is
 *   the safe one — an invented feature is decoration until somebody adds a rule for it.
 */
const OPEN = { movement: "clear", sight: "clear", cover: "none" };

/** The eight directions, as `[dx, dy]`. */
const DIRECTIONS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * @description Reports whether a value is a usable cell — a pair of non-negative whole
 *   numbers. Guards every entry point in the feature, since cells arrive from text a model
 *   wrote, from a click, and from disk.
 * @param {*} cell - Candidate.
 * @returns {boolean} True when it is a well-formed cell.
 */
export function isCell(cell) {
	return Array.isArray(cell) && cell.length === 2
		&& Number.isInteger(cell[0]) && Number.isInteger(cell[1])
		&& cell[0] >= 0 && cell[1] >= 0;
}

/**
 * @description Converts a cell to the label people and models read.
 * @param {number[]} cell - The cell as `[x, y]`.
 * @returns {string|null} A label such as `D7`, or `null` when the cell is malformed or
 *   past column Z — a breach of the 26-column cap should be visible, not wrap round to A.
 */
export function cellLabel(cell) {
	if (!isCell(cell) || cell[0] >= COLUMNS.length) return null;
	return `${COLUMNS[cell[0]]}${cell[1] + 1}`;
}

/**
 * @description Reads a label back into a cell, forgiving the case and padding a model is
 *   liable to produce.
 * @param {string} label - A label such as `D7`.
 * @returns {number[]|null} The cell, or `null` when it is not a single letter followed by a
 *   row number of at least one.
 */
export function parseCellLabel(label) {
	if (typeof label !== "string") return null;
	const match = /^\s*([A-Za-z])\s*(\d+)\s*$/.exec(label);
	if (!match) return null;
	const row = Number(match[2]);
	if (row < 1) return null;
	return [COLUMNS.indexOf(match[1].toUpperCase()), row - 1];
}

/**
 * @description Reports whether two cells are the same square.
 * @param {number[]} a - First cell.
 * @param {number[]} b - Second cell.
 * @returns {boolean} True when both coordinates match. A malformed cell matches nothing.
 */
export function sameCell(a, b) {
	return isCell(a) && isCell(b) && a[0] === b[0] && a[1] === b[1];
}

/**
 * @description Reports whether a cell lies on the map. Edges count as inside.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to test.
 * @returns {boolean} True when the cell exists.
 */
export function inBounds(map, cell) {
	if (!isCell(cell)) return false;
	return cell[0] < (Number(map?.width) || 0) && cell[1] < (Number(map?.height) || 0);
}

/**
 * @description The eight directions a token may step in.
 * @returns {number[][]} A fresh array of `[dx, dy]` pairs, so a caller may sort it.
 */
export function neighbours() {
	return DIRECTIONS.map((d) => [...d]);
}

/**
 * @description Distance in cells, Chebyshev — a diagonal step costs the same as an
 *   orthogonal one. This is 5e's own simplification, and it avoids the every-other-diagonal
 *   rule that no table applies consistently. `movement.js` charges the same way, so the
 *   distance a player is quoted is the distance they pay.
 * @param {object} map - The tactical map. Unused, but taken so the signature matches
 *   `distanceFeet` and a caller never has to remember which one needs it.
 * @param {number[]} a - First cell.
 * @param {number[]} b - Second cell.
 * @returns {number} Whole cells between them, or `Infinity` if either cell is malformed.
 */
export function distanceCells(map, a, b) {
	if (!isCell(a) || !isCell(b)) return Infinity;
	return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/**
 * @description Distance in feet, which is the unit every spell range and weapon reach is
 *   written in.
 * @param {object} map - The tactical map; its `feetPerCell` sets the scale.
 * @param {number[]} a - First cell.
 * @param {number[]} b - Second cell.
 * @returns {number} Feet between the two cells.
 */
export function distanceFeet(map, a, b) {
	const scale = Number(map?.feetPerCell);
	// A missing or nonsense scale falls back rather than collapsing to zero, which would
	// make everything on the map adjacent to everything else.
	const feet = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_FEET_PER_CELL;
	return distanceCells(map, a, b) * feet;
}

/**
 * @description Finds the scenery occupying a cell.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to inspect.
 * @returns {object|null} The feature, or `null` for open floor. A feature spanning several
 *   cells is found at every one of them.
 */
export function featureAt(map, cell) {
	if (!isCell(cell) || !Array.isArray(map?.features)) return null;
	for (const feature of map.features) {
		if (!Array.isArray(feature?.cells)) continue;
		if (feature.cells.some((c) => sameCell(c, cell))) return feature;
	}
	return null;
}

/**
 * @description Finds the token standing on a cell.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to inspect.
 * @returns {{name: string, token: object}|null} The occupant and its name, or `null`.
 */
export function tokenAt(map, cell) {
	if (!isCell(cell) || !map?.tokens || typeof map.tokens !== "object") return null;
	for (const [name, token] of Object.entries(map.tokens)) {
		if (sameCell(token?.cell, cell)) return { name, token };
	}
	return null;
}

/**
 * @description Looks up the rules for whatever occupies a cell.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to inspect.
 * @returns {object} A row of `FEATURE_RULES`, or the open-floor row.
 */
function rulesAt(map, cell) {
	const feature = featureAt(map, cell);
	return (feature && FEATURE_RULES[feature.kind]) || OPEN;
}

/**
 * @description Reports whether a body can enter a cell. Off-map counts as blocked: it is
 *   the outside of the world, not open ground, and a flood fill that leaked past the edge
 *   would offer moves that cannot be drawn.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to test.
 * @returns {boolean} True when entry is impossible.
 */
export function blocksMovement(map, cell) {
	if (!inBounds(map, cell)) return true;
	return rulesAt(map, cell).movement === "blocked";
}

/**
 * @description Reports whether a cell stops a line of sight passing through it.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to test.
 * @returns {boolean} True when sight is blocked. Off-map blocks, for the same reason as
 *   movement.
 */
export function blocksSight(map, cell) {
	if (!inBounds(map, cell)) return true;
	return rulesAt(map, cell).sight === "blocked";
}

/**
 * @description What entering a cell costs, in feet.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell being entered.
 * @returns {number} The cost, `Infinity` when the cell cannot be entered at all. Infinity
 *   rather than a large number so no shortest path ever prices a route through a wall as
 *   merely expensive.
 */
export function moveCostFeet(map, cell) {
	if (blocksMovement(map, cell)) return Infinity;
	const scale = Number(map?.feetPerCell);
	const feet = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_FEET_PER_CELL;
	return rulesAt(map, cell).movement === "double" ? feet * 2 : feet;
}

/**
 * @description The cover a cell's scenery affords.
 * @param {object} map - The tactical map.
 * @param {number[]} cell - The cell to inspect.
 * @returns {string} `none`, `half` or `full`. Whether a given attacker is actually denied
 *   by it is `sight.js`'s question, not this one's.
 */
export function coverOf(map, cell) {
	return rulesAt(map, cell).cover;
}
