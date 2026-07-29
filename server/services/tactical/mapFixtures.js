/**
 * Test-only maps. Not imported by anything that ships.
 *
 * @description A hand-drawn arena beats a generated one for testing geometry: every
 *   assertion in this directory can be checked by eye against the diagram, and a failure
 *   points at the rule rather than at the generator. Generation arrives in phase 2 and
 *   will be tested against these primitives, not the other way round.
 */

/**
 * The reference arena, 8 wide and 6 tall.
 *
 * ```
 *      A  B  C  D  E  F  G  H
 *   1  H  .  .  .  .  .  .  X     H hero      X pit        (blocks moving, not seeing)
 *   2  .  .  #  .  .  .  .  .     # wall      (blocks both, full cover)
 *   3  .  .  #  .  o  .  .  .     o pillar    (blocks both, half cover)
 *   4  .  .  .  .  .  .  .  .
 *   5  .  ~  ~  .  =  =  .  .     ~ rubble    (costs double)   = low wall (blocks moving, not seeing)
 *   6  .  .  .  .  .  .  .  G     G goblin
 * ```
 *
 * @returns {object} A fresh map; callers mutate freely.
 */
export function arena() {
	return {
		seed: 1,
		width: 8,
		height: 6,
		feetPerCell: 5,
		archetype: "crypt",
		features: [
			{ id: "w1", kind: "wall", cells: [[2, 1], [2, 2]] },
			{ id: "p1", kind: "pillar", cells: [[4, 2]] },
			{ id: "r1", kind: "rubble", cells: [[1, 4], [2, 4]] },
			{ id: "l1", kind: "low_wall", cells: [[4, 4], [5, 4]] },
			{ id: "x1", kind: "pit", cells: [[7, 0]] },
		],
		landmarks: [{ name: "the altar", cells: [[3, 3]] }],
		tokens: {
			Hero: { faction: "party", cell: [0, 0], size: 1, speedFeet: 30, reachFeet: 5 },
			Goblin: { faction: "enemy", cell: [7, 5], size: 1, speedFeet: 30, reachFeet: 5 },
		},
	};
}

/**
 * An empty room of a given size, for movement and range maths with nothing in the way.
 *
 * @param {number} [width=10] - Cells across.
 * @param {number} [height=10] - Cells down.
 * @returns {object} A featureless map holding one token at the origin.
 */
export function emptyRoom(width = 10, height = 10) {
	return {
		seed: 1,
		width,
		height,
		feetPerCell: 5,
		archetype: "room",
		features: [],
		landmarks: [],
		tokens: { Hero: { faction: "party", cell: [0, 0], size: 1, speedFeet: 30, reachFeet: 5 } },
	};
}
