/**
 * Tests for the two briefings the map produces.
 *
 * @description These are the strings a model reads, which makes them behaviour rather than
 *   presentation. Two defects in `describeSpell` were invisible in code and obvious the moment
 *   anybody rendered it — a doubled verb and an unnamed saving throw — so the grammar is asserted
 *   here too, not just the facts.
 *
 *   The assertions are on *what is said*, not on exact sentences: pinning whole paragraphs would
 *   break on every wording change while telling nobody anything. The exceptions are the phrases
 *   that carry a rule — the instruction not to move anyone, and the offer of a specific cell —
 *   because those are the contract.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { narratorBlock, moveMenu, refusalBlock, intentRequest } from "./briefing.js";
import { TACTICAL_SETTING, ensureArena } from "./session.js";
import { canReach } from "./movement.js";
import { cellLabel, parseCellLabel } from "./grid.js";

/**
 * @description A lobby mid-fight, with its arena already laid out.
 * @param {object} [over] - Lobby overrides.
 * @returns {object} The lobby.
 */
function fighting(over = {}) {
	const lobby = {
		lobbyId: "lob1",
		[TACTICAL_SETTING]: true,
		players: {
			"Dorn Hammerfall": { name: "Dorn Hammerfall", race: "Dwarf", level: 1, stats: { hp: 10, max_hp: 10 } },
			"Sister Almath": { name: "Sister Almath", race: "Human", level: 2, stats: { hp: 4, max_hp: 12 } },
		},
		enemies: {
			"Ghoul 1": { name: "Ghoul 1", hp: 11, max_hp: 11, ac: 12, cr: "1", status: "active" },
			"Ghoul 2": { name: "Ghoul 2", hp: 3, max_hp: 11, ac: 12, cr: "1", status: "active" },
		},
		...over,
	};
	ensureArena(lobby);
	return lobby;
}

/** @description Puts two tokens at known cells on a cleared map, so distances are predictable. */
function staged(features = []) {
	const lobby = fighting();
	lobby.map.width = 12;
	lobby.map.height = 5;
	lobby.map.features = features;
	lobby.map.landmarks = [{ name: "the altar", cells: [[5, 2]] }];
	lobby.map.tokens = {
		"Dorn Hammerfall": { faction: "party", cell: [1, 2], size: 1, speedFeet: 25, reachFeet: 5 },
		"Sister Almath": { faction: "party", cell: [0, 2], size: 1, speedFeet: 30, reachFeet: 5 },
		"Ghoul 1": { faction: "enemy", cell: [2, 2], size: 1, speedFeet: 30, reachFeet: 5 },
		"Ghoul 2": { faction: "enemy", cell: [6, 2], size: 1, speedFeet: 30, reachFeet: 5 },
	};
	return lobby;
}

// ── When there is nothing to brief ──────────────────────────────────────────

test("no briefing when the feature is off", () => {
	// The guarantee the toggle rests on: a block injected while the feature is off would change
	// narration in every existing game, quietly.
	const lobby = fighting();
	lobby[TACTICAL_SETTING] = false;
	assert.equal(narratorBlock(lobby), null);
	assert.equal(moveMenu(lobby, "Dorn Hammerfall"), null);
});

test("no briefing when there is no map", () => {
	const lobby = { lobbyId: "x", [TACTICAL_SETTING]: true, players: {}, enemies: {} };
	assert.equal(narratorBlock(lobby), null);
	assert.equal(moveMenu(lobby, "Dorn Hammerfall"), null);
});

test("no menu for somebody who is not on the map", () => {
	assert.equal(moveMenu(staged(), "Nobody"), null);
});

// ── The narrator's block ────────────────────────────────────────────────────

test("the block tells the narrator the layout is settled and not to move anyone", () => {
	// The load-bearing sentence in the whole feature. Without it the narrator repositions
	// creatures in prose and becomes a second source of truth about the one thing the map owns.
	const block = narratorBlock(staged());
	assert.match(block, /settled/i);
	assert.match(block, /do not move/i);
});

test("the block names the room and its size", () => {
	const block = narratorBlock(staged());
	assert.match(block, /12 by 5/);
	assert.match(block, /crypt|room|corridor|cavern|ruin/);
});

test("the block places every living creature by cell", () => {
	const block = narratorBlock(staged());
	for (const [name, label] of [["Dorn Hammerfall", "B3"], ["Sister Almath", "A3"], ["Ghoul 1", "C3"], ["Ghoul 2", "G3"]]) {
		assert.match(block, new RegExp(name), name);
		assert.match(block, new RegExp(`${name}[^\\n]*${label}`), `${name} at ${label}`);
	}
});

test("the block gives the narrator something to name a position by", () => {
	// "Dorn at B3" is not narratable. A landmark is.
	const block = narratorBlock(staged());
	assert.match(block, /the altar/);
});

test("the block says who is already within reach of whom", () => {
	// So melee is narrated as melee. Dorn at B3 is adjacent to Ghoul 1 at C3.
	const block = narratorBlock(staged());
	assert.match(block, /Dorn Hammerfall[^\n]*Ghoul 1|Ghoul 1[^\n]*Dorn Hammerfall/);
});

test("the block reports movement it is being asked to describe", () => {
	const block = narratorBlock(staged(), { moved: [{ name: "Dorn Hammerfall", from: [0, 2], to: [1, 2], costFeet: 5 }] });
	assert.match(block, /Dorn Hammerfall[^\n]*A3[^\n]*B3/);
});

test("the block says nothing about movement when nobody moved", () => {
	assert.doesNotMatch(narratorBlock(staged()), /moved/i);
});

// ── The player's menu ───────────────────────────────────────────────────────

test("the menu says where you are and what you can spend", () => {
	const menu = moveMenu(staged(), "Dorn Hammerfall");
	assert.match(menu, /B3/);
	assert.match(menu, /25 feet|5 cells/);
});

test("the menu lists what is already in reach", () => {
	const menu = moveMenu(staged(), "Dorn Hammerfall");
	assert.match(menu, /Ghoul 1/);
});

test("the menu offers a cell to move to for a target out of reach", () => {
	// Naming the cell is what makes the agent's answer extractable: it is repeating an option it
	// was given rather than inventing a coordinate.
	const menu = moveMenu(staged(), "Dorn Hammerfall");
	assert.match(menu, /Ghoul 2/);
	assert.match(menu, /\b[A-L]\d\b/, "and names at least one cell");
});

test("every cell the menu offers is genuinely reachable", () => {
	// The property that matters most. A menu that offers an illegal move teaches an agent to
	// submit one, and the refusal would look like an engine fault rather than a bad suggestion.
	const lobby = staged();
	const menu = moveMenu(lobby, "Dorn Hammerfall");
	const offered = [...menu.matchAll(/move to ([A-Z]\d+)/g)].map((m) => m[1]);
	assert.ok(offered.length, "the menu must offer something");
	for (const label of offered) {
		assert.ok(canReach(lobby.map, "Dorn Hammerfall", parseCellLabel(label)),
			`${label} was offered but cannot be reached`);
	}
});

test("the menu reports the cover you are standing in", () => {
	const lobby = staged([{ id: "l", kind: "low_wall", cells: [[5, 1]] }]);
	lobby.map.tokens["Dorn Hammerfall"].cell = [5, 2];
	const menu = moveMenu(lobby, "Dorn Hammerfall");
	assert.match(menu, /cover/i);
});

test("the menu names an ally who is in trouble", () => {
	// Almath is on 4 of 12. Knowing that is what makes a party behave like one.
	const menu = moveMenu(staged(), "Dorn Hammerfall");
	assert.match(menu, /Sister Almath/);
	assert.match(menu, /4/);
});

test("the menu says when a target cannot be seen at all", () => {
	const lobby = staged([{ id: "w", kind: "wall", cells: [[5, 0], [5, 1], [5, 2], [5, 3], [5, 4]] }]);
	const menu = moveMenu(lobby, "Dorn Hammerfall");
	assert.match(menu, /Ghoul 2/);
	assert.match(menu, /cannot see|no line of sight|out of sight/i);
});

// ── Grammar, because a model writes prose from these ────────────────────────

test("neither briefing leaks a placeholder or a broken number", () => {
	// The class of defect that only shows on a render. `describeSpell` shipped "strikes
	// unerringly HITS for 10 force damage" until somebody read it.
	for (const text of [narratorBlock(staged()), moveMenu(staged(), "Dorn Hammerfall")]) {
		assert.doesNotMatch(text, /undefined|NaN|null|\[object/, text);
		assert.doesNotMatch(text, /  +/, "no doubled spaces");
		assert.doesNotMatch(text, /,\s*,|—\s*—|:\s*$/m, "no empty clauses");
	}
});

test("every line of both briefings carries something", () => {
	for (const text of [narratorBlock(staged()), moveMenu(staged(), "Dorn Hammerfall")]) {
		for (const line of text.split("\n")) {
			assert.notEqual(line.trim(), "", "a blank line wastes a token and reads as a gap");
			assert.doesNotMatch(line, /\s$/, "no trailing whitespace");
		}
	}
});

test("a lone creature on the map does not produce a briefing about nobody", () => {
	// Boundary: the last enemy dies mid-turn and sync has not run yet.
	const lobby = staged();
	lobby.map.tokens = { "Dorn Hammerfall": lobby.map.tokens["Dorn Hammerfall"] };
	const block = narratorBlock(lobby);
	assert.match(block, /Dorn Hammerfall/);
	assert.doesNotMatch(block, /Ghoul/);
	const menu = moveMenu(lobby, "Dorn Hammerfall");
	assert.doesNotMatch(menu, /Ghoul/);
});

test("both briefings stay short enough to send every turn", () => {
	// They ride in the prompt on every combat turn, so length is a running cost rather than a
	// one-off. Twenty-five lines is roughly the budget a beat can spare.
	assert.ok(narratorBlock(staged()).split("\n").length <= 25);
	assert.ok(moveMenu(staged(), "Dorn Hammerfall").split("\n").length <= 15);
});

// ── Telling the narrator an attempt was impossible ──────────────────────────

test("a refused attempt is described to the narrator, not omitted", () => {
	// Found live, and it is the failure this whole feature exists to prevent. The server refused
	// a swing at something 35 feet away; nothing told the narrator, so it saw the intent, saw no
	// resolution block, and wrote "the blade cleaves clean through" — then syncTokens removed the
	// creature the DM had just killed. A refusal is a settled fact exactly as a hit is.
	const block = refusalBlock("Dorn Hammerfall", "Hobgoblin Raider 1", "35 feet away, beyond 5 feet");
	assert.match(block, /Dorn Hammerfall/);
	assert.match(block, /Hobgoblin Raider 1/);
	assert.match(block, /35 feet away, beyond 5 feet/);
});

test("the refusal forbids the narrator describing a hit", () => {
	// The instruction has to be explicit. Stating only that the attempt failed leaves the model
	// free to narrate a graze, which is how it granted the kill in the first place.
	const block = refusalBlock("Dorn Hammerfall", "Hobgoblin Raider 1", "too far");
	assert.match(block, /did not|was not|no attack/i);
	assert.match(block, /do not/i);
});

test("a refusal reads as a sentence, whatever the reason says", () => {
	for (const reason of ["too far", "There is no clear line of sight to X.", ""]) {
		const block = refusalBlock("A", "B", reason);
		assert.doesNotMatch(block, /undefined|null|\.\./);
		assert.doesNotMatch(block, /  +/);
	}
});

test("a refusal with nobody named still says something safe", () => {
	const block = refusalBlock(null, null, null);
	assert.ok(block.length > 0);
	assert.doesNotMatch(block, /undefined|null/);
});

// ── Asking the narrator for orders ──────────────────────────────────────────

test("the request names every verb the server will accept", () => {
	// A closed set, quoted in full, because a verb the narrator invents is discarded — and a model
	// told only "choose an intent" invents constantly.
	const block = intentRequest(staged());
	for (const verb of ["close", "hold", "ranged", "seek_cover", "withdraw", "regroup"]) {
		assert.match(block, new RegExp(verb), verb);
	}
});

test("the request names the creatures awaiting orders", () => {
	const block = intentRequest(staged());
	assert.match(block, /Ghoul 1/);
	assert.match(block, /Ghoul 2/);
});

test("the request does not name the party as things to give orders to", () => {
	// Only the enemies take orders. Offering the characters would invite the narrator to play them.
	const block = intentRequest(staged());
	const orders = block.slice(block.indexOf("awaiting orders"));
	assert.doesNotMatch(orders, /Dorn Hammerfall/);
});

test("the request states the field name the parser reads", () => {
	assert.match(intentRequest(staged()), /enemy_intents/);
});

test("the request forbids squares and distances explicitly", () => {
	// The one rule that keeps ADR 0027's split intact: the model chooses who, never where.
	const block = intentRequest(staged());
	assert.match(block, /never|do not/i);
	assert.match(block, /square|cell|coordinate|distance/i);
});

test("no request when the feature is off or there is no fight", () => {
	const off = staged();
	off[TACTICAL_SETTING] = false;
	assert.equal(intentRequest(off), null);

	const noFoes = staged();
	noFoes.map.tokens = { "Dorn Hammerfall": noFoes.map.tokens["Dorn Hammerfall"] };
	assert.equal(intentRequest(noFoes), null, "nobody to give orders to");
});

test("the request is short enough to send every turn", () => {
	assert.ok(intentRequest(staged()).split("\n").length <= 8);
});
