/**
 * What a caster knows, rendered for someone deciding a turn.
 *
 * @description The character sheet reported how many spell slots remained and never what
 *   they bought. Spells were chosen at creation and then unreachable, so a caster mid-fight
 *   had to recall picks made on a screen they last saw hours before — and in a live game,
 *   two casters spent fifteen actions describing themselves *preparing* to cast without
 *   ever naming a spell.
 *
 *   The character record stores names only; the catalogue owns the mechanics
 *   ([ADR 0021](../docs/decisions/0021-a-caster-knows-a-chosen-spell-list.md)). This joins
 *   the two for display and holds no rules of its own — what a spell costs and what it does
 *   are read from the catalogue entry, never restated here.
 */

/**
 * @description Summarises what casting one entry actually does, in the terms a player
 *   weighs before spending a turn: how much, of what, and against what defence.
 * @param {object} spell - A catalogue entry.
 * @returns {string} A one-line effect summary, or an em dash when nothing is known.
 */
function effectOf(spell) {
	const hit = [spell.damage, spell.damageType].filter(Boolean).join(" ");
	switch (spell.resolution) {
		case "attack":
			return `${hit} — ${spell.range || "ranged"} attack`;
		case "save": {
			// Half-on-save and nothing-on-save are materially different bets, and the area
			// decides whether it is worth a slot at all.
			const outcome = `${String(spell.save || "").toUpperCase()} save for ${spell.onSave || "none"}`;
			return [`${hit} — ${outcome}`, spell.area].filter(Boolean).join(", ");
		}
		case "auto":
			// Saying "ranged attack" here would be a lie the player acts on: it cannot miss.
			return `${hit} — always hits`;
		case "heal":
			return `heals ${spell.healing}${spell.addCastingMod ? " + casting modifier" : ""}`;
		default:
			return spell.description || "—";
	}
}

/**
 * @description Joins the names a character knows to the catalogue that holds the
 *   mechanics, producing display rows ordered so the free options come first.
 * @param {Array<string>} names - Spell names from the character record.
 * @param {Array<object>} catalogue - Catalogue entries, as served by `/api/spells`.
 * @returns {Array<{name: string, level: number|null, cost: string, free: boolean, effect: string}>}
 *   One row per distinct known spell. A name absent from the catalogue still gets a row:
 *   dropping it would recreate the very defect this list exists to fix.
 */
export function describeKnownSpells(names, catalogue) {
	const known = Array.isArray(names) ? names : [];
	const byName = new Map((Array.isArray(catalogue) ? catalogue : []).map((s) => [s.name, s]));

	const seen = new Set();
	const rows = [];
	for (const name of known) {
		if (typeof name !== "string" || !name.trim() || seen.has(name)) continue;
		seen.add(name);

		const spell = byName.get(name);
		if (!spell) {
			rows.push({ name, level: null, cost: "—", free: false, effect: "—" });
			continue;
		}
		const free = spell.level === 0;
		rows.push({
			name,
			level: spell.level,
			cost: free ? "Cantrip" : "1 slot",
			free,
			effect: effectOf(spell),
		});
	}

	// Cantrips first: they are the turns a caster can always afford, so they are what an
	// out-of-slots player needs to find fastest. Unknown entries sort last.
	return rows.sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
}
