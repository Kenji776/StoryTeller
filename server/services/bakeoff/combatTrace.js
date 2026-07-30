/**
 * combatTrace — whether a sequence of DM replies behaved like a fight.
 *
 * A model can return flawless JSON on every turn and still be unable to run
 * combat, which is why this is scored apart from schema conformance. The
 * failures below are the ones `lobbyPrompts.js` spends most of its combat
 * instructions trying to prevent, and each one is separately fatal to play:
 *
 *   - **prematureEnd** — `combat_over: true` with enemies still standing. The
 *     server purges the roster on that flag, so the fight ends mid-swing and the
 *     party is never struck back at.
 *   - **oneTurnWipe** — a fight introduced and concluded inside one turn. This is
 *     the failure that made the whole adventure riskless; the prompt calls it out
 *     by name.
 *   - **rosterDrop** — enemies simply stop being listed while the fight is live.
 *     The server's roster is rebuilt from the array each turn, so the creatures
 *     cease to exist and the encounter evaporates.
 *   - **missingVerdict** — `combat_over` could not be read at all during a fight,
 *     so the server cannot tell whether to purge.
 *   - **unresolved** — the run ended with enemies up. Weakest of the five, since a
 *     truncated run produces it innocently; it is reported, not weighted heavily.
 *
 * Pure and synchronous. Never throws — a provider can return anything.
 */

/** Violation kinds, in the order a report should list them. */
export const VIOLATION_KINDS = ["prematureEnd", "oneTurnWipe", "rosterDrop", "missingVerdict", "unresolved"];

/**
 * @description Reads the three fields this analysis needs out of an inspection,
 *   defaulting anything absent to "no fight here" so a malformed entry is skipped
 *   rather than fatal.
 * @param {*} inspection - A per-turn inspection, or anything at all.
 * @returns {{active: number, over: boolean|null, listed: number, present: boolean}}
 *   The normalised turn. `present` means a fight was on the table this turn —
 *   either creatures are standing, or creatures were listed (which covers the
 *   turn a fight both starts and, wrongly, finishes).
 */
function readTurn(inspection) {
	const source = inspection && typeof inspection === "object" ? inspection : {};
	const active = Number.isFinite(source.activeEnemies) ? source.activeEnemies : 0;
	const listed = Number.isFinite(source.events?.enemies) ? source.events.enemies : 0;
	const over = typeof source.combatOver === "boolean" ? source.combatOver : null;
	return { active, over, listed, present: active > 0 || listed > 0 };
}

/**
 * Judges how a model ran combat across a whole game.
 *
 * @description Walks the turns in order, because every violation is defined
 *   relative to the turn before it — a roster that vanishes is only detectable
 *   against a fight that was live a moment ago.
 * @param {object[]} inspections - Per-turn inspections from `inspectDMReply`, in
 *   play order.
 * @returns {{encounters: number, combatTurns: number, violations: Array<{kind: string, turn: number, detail: string}>,
 *   counts: object, clean: boolean}} The analysis. `turn` is a zero-based index
 *   into `inspections`, so a finding can be traced back to the reply that caused it.
 */
export function analyseCombat(inspections) {
	const counts = Object.fromEntries(VIOLATION_KINDS.map((k) => [k, 0]));
	const violations = [];
	if (!Array.isArray(inspections) || inspections.length === 0) {
		return { encounters: 0, combatTurns: 0, violations, counts, clean: true };
	}

	/**
	 * @description Records one violation against a turn.
	 * @param {string} kind - One of {@link VIOLATION_KINDS}.
	 * @param {number} index - Zero-based turn index.
	 * @param {string} detail - Human-readable specifics for the report.
	 * @returns {void}
	 */
	const flag = (kind, index, detail) => {
		counts[kind]++;
		violations.push({ kind, turn: index, detail });
	};

	let encounters = 0;
	let combatTurns = 0;
	let prev = null;

	for (let i = 0; i < inspections.length; i++) {
		const t = readTurn(inspections[i]);

		// Checked before the `present` guard, and deliberately so: a dropped roster is
		// a turn with *no* enemies in it, so gating this on a fight being present would
		// make the one violation that is defined by absence undetectable.
		//
		// The roster is authoritative and rebuilt from the array each turn, so listing
		// nothing while a fight was live erases the creatures. The exception is the turn
		// that properly finishes a fight: nothing standing, and said so.
		const wasLive = prev && prev.active > 0 && prev.over !== true;
		const resolvesCleanly = t.over === true && t.active === 0;
		if (wasLive && t.listed === 0 && !resolvesCleanly) {
			flag("rosterDrop", i, "no enemies listed while the fight was still live");
		}

		if (!t.present) { prev = t; continue; }

		combatTurns++;
		if (!prev || !prev.present) encounters++;

		if (t.over === true && t.active > 0) {
			flag("prematureEnd", i, `combat_over: true with ${t.active} enemy(ies) still active`);
		}

		// A fight that begins and ends in the same reply. Distinguished from a
		// legitimate final blow by the fact that no earlier turn had it running.
		if (t.listed > 0 && t.active === 0 && t.over === true && (!prev || prev.active === 0)) {
			flag("oneTurnWipe", i, `${t.listed} enemy(ies) introduced and resolved in a single turn`);
		}

		if (t.over === null) {
			flag("missingVerdict", i, "combat_over was absent or not a boolean during combat");
		}

		prev = t;
	}

	// Only when the model never claimed the fight was finished. If it did claim that
	// with enemies up, the defect is the premature end already flagged above, and
	// counting both would charge one mistake twice.
	const last = readTurn(inspections[inspections.length - 1]);
	if (last.active > 0 && last.over !== true) {
		flag("unresolved", inspections.length - 1, `run ended with ${last.active} enemy(ies) still active`);
	}

	return { encounters, combatTurns, violations, counts, clean: violations.length === 0 };
}
