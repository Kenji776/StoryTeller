/**
 * A random source you can ask for the same answers twice.
 *
 * @description Arena generation needs randomness that survives being written to disk and
 *   read back. `Math.random` cannot: a lobby reloaded from a file would rearrange its own
 *   furniture, `TDD-8` forbids unseeded randomness in anything tested, and a badly generated
 *   room could never be reported in a way anybody could reproduce.
 *
 *   The output is a plain function returning a float in `[0, 1)`, because that is the shape
 *   the rest of the project already passes around — `loot.js` and `dice.js` both take an
 *   `rng` parameter of exactly this kind, so a seeded source drops straight into them.
 *
 *   The generator is mulberry32: thirty-two bits of state, four operations, and a period long
 *   enough that an arena will never see the end of it. Chosen for being short enough to read
 *   and verify rather than for statistical excellence, which an eight-by-twelve room does not
 *   need.
 */

/** Where a nonsense seed lands. Any constant would do; this one is just not zero. */
const FALLBACK_SEED = 0x9e3779b9;

/**
 * @description Builds a deterministic random source.
 * @param {number} seed - The seed. A missing, fractional or non-finite value falls back to a
 *   constant rather than throwing: the seed arrives from a stored lobby, and a corrupt one
 *   should cost the room's layout, not the encounter.
 * @returns {Function} A function returning a float in `[0, 1)`.
 */
export function createRng(seed) {
	const clean = Number(seed);
	let state = (Number.isFinite(clean) ? Math.floor(Math.abs(clean)) : FALLBACK_SEED) || FALLBACK_SEED;
	return function next() {
		state = (state + 0x6D2B79F5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		// `>>> 0` makes it unsigned before dividing, so the result cannot come out negative.
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * @description Turns a string into a seed, so an archetype name or a lobby id can stand in
 *   for a number nobody chose.
 * @param {string} text - Anything nameable.
 * @returns {number} A stable non-negative integer. Different strings very nearly always give
 *   different numbers; a collision would only mean two rooms share a layout.
 */
export function seedFrom(text) {
	let hash = 0x811c9dc5;
	for (const character of String(text ?? "")) {
		hash ^= character.codePointAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0);
}

/**
 * @description Chooses one member of a list.
 * @param {Function} rng - A random source.
 * @param {Array} list - The options.
 * @returns {*} A member, or `null` when there is nothing to choose from.
 */
export function pick(rng, list) {
	if (!Array.isArray(list) || !list.length) return null;
	// Multiplying by the full length is what lets the last element be chosen; the familiar
	// `length - 1` version can never reach it.
	return list[Math.floor(rng() * list.length)];
}

/**
 * @description Chooses one member of a list, favouring the heavier entries.
 * @param {Function} rng - A random source.
 * @param {Array<{weight?: number}>} list - Options, each optionally carrying a `weight`.
 * @returns {*} A member, or `null` for an empty list. An entry with no weight counts as one,
 *   and a list whose weights are all zero falls back to an even choice — a palette somebody
 *   forgot to weight should still furnish the room, because an empty arena looks like a
 *   working one.
 */
export function weightedPick(rng, list) {
	if (!Array.isArray(list) || !list.length) return null;

	const weights = list.map((entry) => {
		const weight = Number(entry?.weight);
		return Number.isFinite(weight) && weight > 0 ? weight : (entry?.weight === undefined ? 1 : 0);
	});
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total <= 0) return pick(rng, list);

	let target = rng() * total;
	for (let i = 0; i < list.length; i++) {
		target -= weights[i];
		if (target < 0) return list[i];
	}
	return list[list.length - 1];
}

/**
 * @description Copies a list into a new order.
 * @param {Function} rng - A random source.
 * @param {Array} list - The list to shuffle.
 * @returns {Array} A new array. The input is left alone, because callers pass archetype
 *   palettes and spawn candidates that are reused across generation attempts.
 */
export function shuffled(rng, list) {
	const copy = Array.isArray(list) ? [...list] : [];
	// Fisher-Yates, downward, so every permutation is equally likely.
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}
