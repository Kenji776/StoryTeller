/**
 * What can be seen from where, and what shelters it.
 *
 * @description The second layer of the tactical map ([ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)).
 *   Sight and cover are the facts that make a wall worth standing behind, and they are
 *   computed here so that neither the narrator nor a player agent is ever asked to judge
 *   them.
 *
 *   The geometry is exact and integer-only. Cell centres sit at half-coordinates, so every
 *   coordinate is doubled once on the way in and the whole line test runs in whole numbers —
 *   no floating point, therefore no tie-break that depends on rounding, therefore the same
 *   answer on every machine, which `TDD-8` requires of anything a test relies on.
 */

import { distanceCells, blocksSight, coverOf, sameCell, inBounds, isCell } from "./grid.js";

/** Cover words, weakest first, so "the best of these" is a maximum over indices. */
const COVER_ORDER = ["none", "half", "full"];

/**
 * @description Picks the stronger of two cover words.
 * @param {string} a - First cover word.
 * @param {string} b - Second cover word.
 * @returns {string} Whichever shelters more.
 */
function betterCover(a, b) {
	return COVER_ORDER.indexOf(a) >= COVER_ORDER.indexOf(b) ? a : b;
}

/**
 * The cells a straight line between two cell centres passes through.
 *
 * @description Both endpoints are excluded — a creature does not obstruct itself, and the
 *   target is what is being looked at rather than something in the way.
 *
 *   A cell counts as crossed when the segment touches its square at all, corners included.
 *   That makes a diagonal clip the two cells either side of it, so sight does not pass
 *   through the joint between two diagonally-placed pillars. That case is genuinely
 *   ambiguous in the source material and this is the conservative reading, chosen
 *   deliberately and stated here rather than falling out of an epsilon somewhere.
 *
 *   Implemented as a segment-against-square test over the line's bounding box rather than a
 *   traversal: a square is crossed unless all four of its corners lie strictly to one side
 *   of the line. Arenas are at most a few hundred cells and the bounding box is smaller
 *   again, so being obviously correct is worth more here than being clever.
 * @param {number[]} from - The looking cell.
 * @param {number[]} to - The cell being looked at.
 * @returns {number[][]} The cells between, nearest to `from` first, so a caller can name the
 *   first thing in the way. Empty when either cell is malformed, when they are the same, or
 *   when they are neighbours.
 */
export function cellsOnLine(from, to) {
	if (!isCell(from) || !isCell(to) || sameCell(from, to)) return [];

	// Doubled, so a centre at x + 0.5 becomes the whole number 2x + 1.
	const ax = from[0] * 2 + 1;
	const ay = from[1] * 2 + 1;
	const bx = to[0] * 2 + 1;
	const by = to[1] * 2 + 1;

	const crossed = [];
	for (let x = Math.min(from[0], to[0]); x <= Math.max(from[0], to[0]); x++) {
		for (let y = Math.min(from[1], to[1]); y <= Math.max(from[1], to[1]); y++) {
			if (sameCell([x, y], from) || sameCell([x, y], to)) continue;

			// The square, doubled: corners land on even coordinates.
			const left = x * 2;
			const top = y * 2;
			let positive = false;
			let negative = false;
			for (const [cx, cy] of [[left, top], [left + 2, top], [left, top + 2], [left + 2, top + 2]]) {
				const side = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
				if (side > 0) positive = true;
				else if (side < 0) negative = true;
				else { positive = true; negative = true; }   // a corner exactly on the line
			}
			if (positive && negative) crossed.push([x, y]);
		}
	}

	// Nearest first. Squared distance is enough to order them and keeps this in integers.
	return crossed.sort((p, q) =>
		((p[0] - from[0]) ** 2 + (p[1] - from[1]) ** 2) - ((q[0] - from[0]) ** 2 + (q[1] - from[1]) ** 2));
}

/**
 * @description Reports whether one cell can see another.
 * @param {object} map - The tactical map.
 * @param {number[]} from - The looking cell.
 * @param {number[]} to - The cell being looked at.
 * @returns {boolean} True when nothing opaque lies between. Neighbouring cells always see
 *   each other: the conservative corner rule in `cellsOnLine` would otherwise let a wall
 *   hide a creature standing directly beside you, which is absurd at the table. A cell off
 *   the map is never visible.
 */
export function hasLineOfSight(map, from, to) {
	if (!isCell(from) || !isCell(to)) return false;
	if (!inBounds(map, from) || !inBounds(map, to)) return false;
	if (distanceCells(map, from, to) <= 1) return true;
	return !cellsOnLine(from, to).some((cell) => blocksSight(map, cell));
}

/**
 * The cover a target enjoys against one particular attacker.
 *
 * @description Two ways to earn it, because scenery shelters in two different ways:
 *
 *   - **Crossed.** The line passes through it — shooting over a low wall, the sort of thing
 *     that obstructs without hiding.
 *   - **Beside, on the attacker's side.** The line passes clear, but the target is tucked
 *     against something between it and the attacker. This is what "behind a pillar" means,
 *     and it is the *only* way a pillar's cover can ever apply: a pillar blocks sight, so a
 *     line through one is no shot at all rather than a shot at half cover.
 *
 *   Cover earned from beside is capped at half, which is why a wall next to you shelters you
 *   without making you untargetable. Anything that genuinely blocked the shot would have
 *   blocked sight and been reported as full before reaching here.
 * @param {object} map - The tactical map.
 * @param {number[]} from - The attacker's cell.
 * @param {number[]} to - The target's cell.
 * @returns {string} `none`, `half`, or `full`. Full means there is no shot to roll, and is
 *   also what a blocked line of sight reports — one answer for a caller to read, rather than
 *   a modifier plus a separate untargetable flag.
 */
export function coverBetween(map, from, to) {
	if (!isCell(from) || !isCell(to) || sameCell(from, to)) return "none";
	if (!hasLineOfSight(map, from, to)) return "full";

	let best = "none";
	for (const cell of cellsOnLine(from, to)) {
		best = betterCover(best, coverOf(map, cell));
	}

	const range = distanceCells(map, from, to);
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			if (dx === 0 && dy === 0) continue;
			const beside = [to[0] + dx, to[1] + dy];
			if (!isCell(beside) || !inBounds(map, beside)) continue;
			// Only scenery the target is sheltering *behind* counts, so a pillar on the far
			// side of them does nothing.
			if (distanceCells(map, from, beside) >= range) continue;
			if (coverOf(map, beside) === "none") continue;
			best = betterCover(best, "half");
		}
	}
	return best;
}

/**
 * @description Turns cover into the number an attack roll cares about.
 * @param {string} cover - A cover word.
 * @returns {number} Two for half cover, nothing for none, and `Infinity` for full — because
 *   full cover is not a modifier, and a large finite number would invite a caller to add it
 *   to an armour class and roll anyway. An unrecognised word is worth nothing.
 */
export function coverACBonus(cover) {
	if (cover === "half") return 2;
	if (cover === "full") return Infinity;
	return 0;
}
