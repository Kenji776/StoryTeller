/**
 * The battle map, as the browser understands it.
 *
 * @description The client half of phase 4 ([ADR 0026](../docs/decisions/0026-tactical-combat-happens-on-a-grid.md)).
 *   Everything up to now worked for agents and could not be used by a person at all.
 *
 *   This holds the state and the decisions; the drawing lives beside it in `uiComponents.js`. The
 *   split is what makes any of it testable — a canvas assertion pins pixels and teaches nobody
 *   anything, while "which squares are offered" and "what does a click do" are the parts that can be
 *   wrong in ways a player would notice.
 *
 *   **The reachable squares arrive from the server and are never computed here.** That is the same
 *   rule the player agents are held to, and for the same reason: one authority on distance. A page
 *   that worked out its own reach would eventually disagree with the server about a legal move, and
 *   the player would watch a click be refused for no visible reason.
 */

/**
 * @description Reports whether a value is a usable cell.
 * @param {*} cell - Candidate.
 * @returns {boolean} True for a pair of non-negative whole numbers.
 */
function isCell(cell) {
	return Array.isArray(cell) && cell.length === 2
		&& Number.isInteger(cell[0]) && Number.isInteger(cell[1])
		&& cell[0] >= 0 && cell[1] >= 0;
}

/**
 * @description Turns a cell into the label the server speaks in.
 * @param {number[]} cell - The cell.
 * @returns {string|null} A label such as `D7`, or `null` when the cell is unusable.
 */
function labelOf(cell) {
	if (!isCell(cell) || cell[0] > 25) return null;
	return `${String.fromCharCode(65 + cell[0])}${cell[1] + 1}`;
}

/**
 * Builds the view model for one lobby's battle map.
 *
 * @returns {object} The view: `setMap`, `setOptions`, `clickCell`, `pendingMove`, `takeMove`,
 *   `offered`, `hasMap`, `tokenAtCell`.
 */
/**
 * @description Identifies an arena, so a redundant push can be told from a new room.
 * @param {object|null} map - The map.
 * @returns {string} A signature. Deliberately excludes token positions: creatures move constantly
 *   within one arena, and that is not a change of room.
 */
function signatureOf(map) {
	if (!map) return "none";
	return [map.seed, map.width, map.height, map.archetype].join("|");
}

export function createMapView() {
	let map = null;
	let reachable = new Set();
	let standing = null;
	let pending = null;

	/**
	 * @description Reports whether a map is worth drawing.
	 * @param {*} candidate - The payload from `state:update` or `map:update`.
	 * @returns {boolean} True when it has real dimensions and a token table.
	 */
	const usable = (candidate) =>
		!!candidate && typeof candidate === "object"
		&& Number.isFinite(Number(candidate.width)) && Number(candidate.width) > 0
		&& Number.isFinite(Number(candidate.height)) && Number(candidate.height) > 0
		&& !!candidate.tokens;

	return {
		/**
		 * @description Takes a new map, or `null` when combat has ended.
		 * @param {object|null} next - The map.
		 * @returns {void} Clears the pending move: the arena that move referred to is gone, and a
		 *   stale one would ride the next action.
		 */
		setMap(next) {
			const before = signatureOf(map);
			map = usable(next) ? next : null;
			const after = signatureOf(map);

			if (!map) {
				reachable = new Set();
				standing = null;
			}
			// Only a genuinely different room forgets the square you clicked. `state:update` carries
			// the map and fires several times a turn — on damage, on conditions, when somebody else
			// moves — and treating each push as a new arena silently wiped the pending move, so the
			// click never rode along with the action typed after it. A new encounter is a new room and
			// does clear it, because a square chosen in the last one means nothing here.
			if (before !== after) pending = null;
		},

		/**
		 * @description Takes this turn's options, as sent by `tactical:menu`.
		 * @param {object} options - `{reachable: string[], standing: string}`.
		 * @returns {void} Also clears any pending move, because the options belong to a new turn and
		 *   last turn's click must not attach itself to this turn's action.
		 */
		setOptions(options) {
			const labels = Array.isArray(options?.reachable) ? options.reachable : [];
			reachable = new Set(labels.filter((label) => typeof label === "string"));
			standing = typeof options?.standing === "string" ? options.standing : null;
			pending = null;
		},

		/**
		 * @description Handles a click on a square.
		 * @param {number[]} cell - The square clicked.
		 * @returns {boolean} True when the click changed anything. A square that was not offered is
		 *   inert rather than an error: the tint is the whole legality conversation, so there is
		 *   nothing to explain to somebody who clicked elsewhere.
		 */
		clickCell(cell) {
			const label = labelOf(cell);
			if (!map || !label || !reachable.has(label)) return false;

			// Clicking where you already are, or the square you already chose, means "never mind".
			// Standing still is legal, so this needs no error state.
			pending = (label === pending || label === standing) ? null : label;
			return true;
		},

		/**
		 * @description The square chosen but not yet acted on.
		 * @returns {string|null} A label, or `null`.
		 */
		pendingMove() {
			return pending;
		},

		/**
		 * @description Hands the pending move to the action being submitted, and forgets it.
		 * @returns {string|null} The label, or `null`. Consumed rather than read, because a move that
		 *   stayed behind would be re-sent with the next action and move the character again.
		 */
		takeMove() {
			const taken = pending;
			pending = null;
			return taken;
		},

		/**
		 * @description The squares this character may finish its move on.
		 * @returns {string[]} Labels, empty when it is not their turn — which is the ordinary state
		 *   for most of a fight rather than a fault.
		 */
		offered() {
			return [...reachable];
		},

		/**
		 * @description Whether there is a fight to draw.
		 * @returns {boolean} True when a usable map is loaded.
		 */
		hasMap() {
			return !!map;
		},

		/**
		 * @description Finds who is standing on a square, for drawing and for hit-testing.
		 * @param {number[]} cell - The square.
		 * @returns {{name: string, token: object}|null} The occupant, or `null`.
		 */
		tokenAtCell(cell) {
			const label = labelOf(cell);
			if (!map || !label) return null;
			for (const [name, token] of Object.entries(map.tokens ?? {})) {
				if (labelOf(token?.cell) === label) return { name, token };
			}
			return null;
		},

		/**
		 * @description The map itself, for the renderer.
		 * @returns {object|null} The map.
		 */
		current() {
			return map;
		},
	};
}
