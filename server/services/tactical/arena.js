/**
 * Laying out a room to fight in.
 *
 * @description Phase 2 of the tactical map ([ADR 0026](../../../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)).
 *   Takes who is fighting and produces the arena they fight in, reproducibly from a seed.
 *
 *   Two invariants are worth more than any amount of interesting scenery, and both are checked
 *   before an arena is returned rather than hoped for:
 *
 *   - **Everyone is in one walkable region.** A party that cannot reach the enemy has a
 *     softlock, and no in-game action gets them out of it. A boring room is strictly better.
 *   - **Nobody starts in melee**, unless an ambush was explicitly asked for. Spawning adjacent
 *     means the first enemy round lands before anybody has chosen anything, which reads as the
 *     engine cheating rather than as a hard fight.
 *
 *   Both are guaranteed structurally rather than by luck: spawn zones sit at opposite ends and
 *   scenery is never placed in them, so separation falls out of the layout, and the connectivity
 *   check reduces the scenery density on each retry until — at zero — an empty room is
 *   trivially connected. Generation cannot fail to produce a playable arena.
 */

import { createRng, seedFrom, weightedPick, shuffled } from "./random.js";
import { cellLabel, DEFAULT_FEET_PER_CELL } from "./grid.js";
import { walkableRegion } from "./movement.js";

/** Default movement and reach for a generated token, in feet. */
const DEFAULT_SPEED_FEET = 30;
const DEFAULT_REACH_FEET = 5;

/** Labels run out at Z, so an arena wider than 26 could not be described or clicked. */
const MAX_WIDTH = 26;

/** How many times to retry before giving up on scenery entirely. */
const MAX_ATTEMPTS = 12;

/**
 * Floors and ceilings on scenery.
 *
 * @description The first draft applied `density` to the middle ground alone, and an 8×6 crypt
 *   came out with two pillars in it. Every test passed — the room was connected, nobody started
 *   in melee — and the result was useless, because cover is the entire point of the feature and
 *   there was nothing to take cover behind. Rendering the arenas as ASCII is what showed it.
 *
 *   So the count is a fraction of the *whole* arena while placement is still restricted to the
 *   middle, with a floor so even the smallest room has something to hide behind, and a ceiling
 *   so the middle never becomes a maze that sends generation into retries.
 */
const MIN_FEATURES = 3;
const MAX_MIDDLE_FRACTION = 0.45;

/**
 * The kinds of room, as data.
 *
 * @description Adding a room type is meant to be a row here and nothing else — no new branch
 *   in the placement code. `density` is the fraction of the middle ground that gets scenery;
 *   `palette` is what that scenery is drawn from, weighted; `aspect` is the only thing that
 *   changes the proportions.
 */
export const ARCHETYPES = {
	room: {
		aspect: "square", density: 0.08,
		palette: [{ kind: "pillar", weight: 2 }, { kind: "rubble", weight: 1 }],
		landmarks: ["the hearth", "the long table"],
	},
	crypt: {
		aspect: "square", density: 0.13,
		palette: [{ kind: "pillar", weight: 4 }, { kind: "rubble", weight: 1 }],
		landmarks: ["the altar", "the sealed door", "the collapsed stair"],
	},
	corridor: {
		aspect: "long", density: 0.10,
		palette: [{ kind: "low_wall", weight: 3 }, { kind: "rubble", weight: 2 }],
		landmarks: ["the far archway", "the guttering sconce"],
	},
	cavern: {
		aspect: "square", density: 0.18,
		palette: [{ kind: "rubble", weight: 3 }, { kind: "water", weight: 2 }, { kind: "pillar", weight: 1 }],
		landmarks: ["the stalagmite cluster", "the black pool"],
	},
	ruin: {
		aspect: "square", density: 0.16,
		palette: [{ kind: "low_wall", weight: 3 }, { kind: "rubble", weight: 2 }, { kind: "wall", weight: 1 }],
		landmarks: ["the fallen statue", "the broken gate"],
	},
};

/** Where an unrecognised archetype lands. The narrator is allowed to hint, and it invents words. */
const FALLBACK_ARCHETYPE = "crypt";

/**
 * @description Clamps a number into a range.
 * @param {number} value - The value.
 * @param {number} low - Minimum.
 * @param {number} high - Maximum.
 * @returns {number} The clamped value.
 */
function clamp(value, low, high) {
	return Math.max(low, Math.min(high, value));
}

/**
 * @description Chooses the arena's proportions from how many creatures have to fit in it.
 * @param {number} partySize - How many characters.
 * @param {number} enemyCount - How many enemies.
 * @param {object} archetype - A row of `ARCHETYPES`; only its `aspect` is read.
 * @returns {{width: number, height: number}} Cells across and down. Width is capped at 26
 *   because `cellLabel` runs out at Z, and an unlabelable column would break every prompt and
 *   every click — the cap belongs here, where the width is chosen, rather than as a surprise
 *   `null` later.
 */
export function arenaSize(partySize, enemyCount, archetype) {
	const creatures = Math.max(2, (Number(partySize) || 0) + (Number(enemyCount) || 0));
	// Roughly a dozen cells a creature, floored so even a duel has room to manoeuvre. The
	// first draft allowed seven, which produced rooms a party crossed in two turns.
	const area = Math.max(80, creatures * 12);

	if (archetype?.aspect === "long") {
		const height = clamp(Math.round(Math.sqrt(area / 2)), 4, 12);
		return { width: clamp(Math.round(height * 2), 10, MAX_WIDTH), height };
	}
	const width = clamp(Math.round(Math.sqrt(area)), 8, MAX_WIDTH);
	return { width, height: clamp(Math.round(width * 0.75), 6, 20) };
}

/**
 * @description Reads a distance in feet, falling back when it is absent or unusable.
 * @param {*} value - Candidate.
 * @param {number} fallback - What to use instead.
 * @returns {number} A usable number of feet.
 */
function feetOr(value, fallback) {
	const feet = Number(value);
	return Number.isFinite(feet) ? feet : fallback;
}

/**
 * @description Normalises the creature lists into `{name, speedFeet, reachFeet}`, accepting
 *   either bare names or objects so phase 4 can pass real sheets without changing this
 *   signature.
 * @param {Array<string|object>} entries - Names, or objects carrying a `name`.
 * @param {string} faction - `party` or `enemy`.
 * @param {Set<string>} taken - Names already used, so a duplicate is dropped rather than
 *   silently overwriting the first of its name.
 * @returns {Array<object>} Usable creature descriptors.
 */
function creatures(entries, faction, taken) {
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		const name = typeof entry === "string" ? entry : entry?.name;
		if (typeof name !== "string" || !name.trim() || taken.has(name)) continue;
		taken.add(name);
		out.push({
			name,
			faction,
			speedFeet: feetOr(entry?.speedFeet, DEFAULT_SPEED_FEET),
			reachFeet: feetOr(entry?.reachFeet, DEFAULT_REACH_FEET),
		});
	}
	return out;
}

/**
 * @description Lists the cells of a column range, top to bottom.
 * @param {number} fromColumn - First column, inclusive.
 * @param {number} toColumn - Last column, exclusive.
 * @param {number} height - Rows.
 * @returns {number[][]} Cells.
 */
function columnCells(fromColumn, toColumn, height) {
	const cells = [];
	for (let x = fromColumn; x < toColumn; x++) {
		for (let y = 0; y < height; y++) cells.push([x, y]);
	}
	return cells;
}

/**
 * @description Builds one candidate arena. May be disconnected; the caller checks.
 * @param {object} plan - Everything the layout needs.
 * @returns {object} A map.
 */
function attempt({ width, height, archetypeName, archetype, party, foes, density, rng, seed, ambush }) {
	// Zones wide enough to hold their occupants, so a crowd does not overflow into the middle.
	const partyColumns = Math.max(2, Math.ceil(party.length / height));
	const enemyColumns = Math.max(2, Math.ceil(foes.length / height));

	const partyZone = columnCells(0, partyColumns, height);
	// An ambush puts them immediately alongside; otherwise at the far end, which is what makes
	// the no-melee-at-the-start invariant structural rather than something to check and retry.
	const enemyZone = ambush
		? columnCells(partyColumns, partyColumns + enemyColumns, height)
		: columnCells(width - enemyColumns, width, height);

	const reserved = new Set([...partyZone, ...enemyZone].map(cellLabel));

	// Scenery goes in the middle ground only. Keeping the spawn zones clear is what guarantees
	// nobody begins the fight standing inside a pillar.
	const middle = [];
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			if (!reserved.has(cellLabel([x, y]))) middle.push([x, y]);
		}
	}

	// Counted against the whole arena but placed only in the middle: the middle is a handful of
	// columns wide, so sizing the count by it alone furnished a crypt with two pillars.
	const wanted = clamp(
		Math.round(width * height * density),
		density > 0 ? MIN_FEATURES : 0,
		Math.floor(middle.length * MAX_MIDDLE_FRACTION));

	const features = [];
	const scenery = shuffled(rng, middle).slice(0, Math.max(0, wanted));
	scenery.forEach((cell, index) => {
		const choice = weightedPick(rng, archetype.palette);
		if (choice) features.push({ id: `f${index}`, kind: choice.kind, cells: [cell] });
	});

	const sceneryCells = new Set(features.flatMap((f) => f.cells.map(cellLabel)));
	const landmarkCell = shuffled(rng, middle).find((cell) => !sceneryCells.has(cellLabel(cell)));
	const landmarkName = weightedPick(rng, (archetype.landmarks ?? []).map((name) => ({ name })));

	const tokens = {};
	const partySeats = shuffled(rng, partyZone);
	const enemySeats = shuffled(rng, enemyZone);
	party.forEach((creature, index) => {
		tokens[creature.name] = { ...creature, cell: partySeats[index], size: 1 };
	});
	foes.forEach((creature, index) => {
		tokens[creature.name] = { ...creature, cell: enemySeats[index], size: 1 };
	});

	return {
		seed,
		width,
		height,
		feetPerCell: DEFAULT_FEET_PER_CELL,
		archetype: archetypeName,
		ambush,
		features,
		landmarks: landmarkCell && landmarkName ? [{ name: landmarkName.name, cells: [landmarkCell] }] : [],
		tokens,
	};
}

/**
 * Generates the arena an encounter is fought in.
 *
 * @description Retries on a disconnected layout, thinning the scenery each time. The last
 *   attempt runs at zero density, and an empty room is connected by construction — so this
 *   cannot fail to return a playable arena, which matters because it is called from the turn
 *   pipeline with a fight already under way.
 * @param {object} options - Options.
 * @param {Array<string|object>} options.party - The characters.
 * @param {Array<string|object>} options.enemies - The opposition.
 * @param {number} [options.seed] - The seed. Defaults to one derived from the names, so an
 *   omitted seed is still reproducible — deriving it from a clock would breach `TDD-8` and make
 *   a reloaded lobby rearrange its own furniture.
 * @param {string} [options.archetype] - A room type; an unrecognised one falls back rather than
 *   throwing, because the narrator may hint it and invents words.
 * @param {boolean} [options.ambush=false] - Allow the opposition to start alongside the party.
 * @returns {object|null} The map, or `null` when there is no fight to lay out — no enemies, or
 *   nobody to face them.
 */
export function generateArena({ party, enemies, seed, archetype, ambush = false } = {}) {
	const taken = new Set();
	const friends = creatures(party, "party", taken);
	const foes = creatures(enemies, "enemy", taken);
	if (!friends.length || !foes.length) return null;

	const archetypeName = ARCHETYPES[archetype] ? archetype : FALLBACK_ARCHETYPE;
	const chosen = ARCHETYPES[archetypeName];
	const resolvedSeed = Number.isFinite(Number(seed))
		? Number(seed)
		: seedFrom([...friends, ...foes].map((c) => c.name).join("|"));

	const { width, height } = arenaSize(friends.length, foes.length, chosen);

	let candidate = null;
	for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
		// A fresh generator per attempt, keyed off the attempt number, so the sequence is
		// reproducible and a retry is not correlated with the layout that just failed.
		const rng = createRng(resolvedSeed + tries * 7919);
		// Thin the scenery as attempts go on; the final pass places none at all.
		const density = chosen.density * (1 - tries / (MAX_ATTEMPTS - 1));
		candidate = attempt({
			width, height, archetypeName, archetype: chosen,
			party: friends, foes, density: Math.max(0, density), rng, seed: resolvedSeed, ambush,
		});

		const region = walkableRegion(candidate, candidate.tokens[friends[0].name].cell);
		const allConnected = Object.values(candidate.tokens)
			.every((token) => region.has(cellLabel(token.cell)));
		if (allConnected) return candidate;
	}

	// Unreachable in practice: the last attempt has no scenery in it. Returned rather than
	// thrown so a fight already in progress gets a room regardless.
	return candidate;
}
