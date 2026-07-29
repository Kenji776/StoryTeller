/**
 * Tests for the party status block handed to the Dungeon Master.
 *
 * @description This block is labelled "authoritative — do not guess or override",
 *   so an error in it becomes an error in the fiction. A 30-turn playtest ran with
 *   the lobby configured for 3 ability uses; the DM was told every character had
 *   "slots: 0/1 ⚠️ NO SLOTS REMAINING" and duly narrated a Wizard's magic failing
 *   for lack of a resource the feasibility gate had, three seconds earlier,
 *   confirmed he still had two of. One variable was serving as both the character's
 *   level and their ability pool.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { describePartyForDM } from "./lobbyPrompts.js";

/**
 * @description Builds a lobby carrying one configurable character.
 * @param {object} [player] - Fields to override on the character.
 * @param {object} [lobby] - Fields to override on the lobby.
 * @returns {object} The lobby record.
 */
function lobbyWith(player = {}, lobby = {}) {
	return {
		abilitySlotsBase: 3,
		players: {
			Brannor: {
				name: "Brannor", class: "Fighter", level: 1, spellSlotsUsed: 0,
				stats: { hp: 12, max_hp: 12 },
				abilities: [{ name: "Second Wind" }],
				...player,
			},
		},
		...lobby,
	};
}

// ===== The pool the lobby actually configured =====

test("the ability pool reported to the DM is the one the host configured", () => {
	const line = describePartyForDM(lobbyWith());
	assert.match(line, /slots: 3\/3/);
	assert.ok(!line.includes("NO SLOTS REMAINING"), line);
});

test("spent uses are subtracted from the configured pool, not from the level", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 1 }));
	assert.match(line, /slots: 2\/3/);
});

test("the character's level is reported independently of the pool", () => {
	// The defect: one `max` variable was both the level and the pool, so raising
	// the pool would have silently promoted every character.
	const line = describePartyForDM(lobbyWith({ level: 1 }, { abilitySlotsBase: 5 }));
	assert.match(line, /Lv 1/);
	assert.match(line, /slots: 5\/5/);
});

test("a higher level widens the pool on top of the configured base", () => {
	const line = describePartyForDM(lobbyWith({ level: 3 }, { abilitySlotsBase: 3 }));
	assert.match(line, /Lv 3/);
	assert.match(line, /slots: 5\/5/);
});

test("the default pool applies when the host set nothing", () => {
	const line = describePartyForDM(lobbyWith({}, { abilitySlotsBase: undefined }));
	assert.match(line, /slots: 1\/1/);
});

// ===== Exhaustion =====

test("the exhaustion warning appears only when the pool is genuinely empty", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 3 }));
	assert.match(line, /slots: 0\/3/);
	assert.match(line, /NO SLOTS REMAINING/);
});

test("overspending past the pool still reports zero, never a negative", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 99 }));
	assert.match(line, /slots: 0\/3/);
});

test("a zero-slot lobby reports the pool as exhausted from the start", () => {
	const line = describePartyForDM(lobbyWith({}, { abilitySlotsBase: 0 }));
	assert.match(line, /slots: 0\/0/);
	assert.match(line, /NO SLOTS REMAINING/);
});

// ===== Unlimited =====

test("an unlimited pool is described in words and never as a fraction", () => {
	const line = describePartyForDM(lobbyWith({ spellSlotsUsed: 7 }, { abilitySlotsBase: "unlimited" }));
	assert.match(line, /slots: unlimited/i);
	assert.ok(!line.includes("NO SLOTS REMAINING"), line);
	assert.ok(!/Infinity|NaN/.test(line), line);
});

// ===== Health =====

test("a dead character is reported as dead rather than by hit points", () => {
	const line = describePartyForDM(lobbyWith({ dead: true, stats: { hp: 0, max_hp: 12 } }));
	assert.match(line, /DEAD/);
});

test("a badly wounded character is flagged to the DM", () => {
	const line = describePartyForDM(lobbyWith({ stats: { hp: 2, max_hp: 12 } }));
	assert.match(line, /HP: 2\/12/);
	assert.match(line, /CRITICALLY LOW HP/);
});

test("a healthy character carries no wound warning", () => {
	const line = describePartyForDM(lobbyWith());
	assert.ok(!line.includes("CRITICALLY LOW"), line);
});

// ===== Abilities and equipment =====

test("abilities are listed by name, whether objects or legacy strings", () => {
	assert.match(describePartyForDM(lobbyWith({ abilities: [{ name: "Second Wind" }] })), /\[Second Wind\]/);
	assert.match(describePartyForDM(lobbyWith({ abilities: ["Old Style"] })), /\[Old Style\]/);
});

test("a character with no abilities is described as having none", () => {
	assert.match(describePartyForDM(lobbyWith({ abilities: [] })), /\[none\]/);
});

test("unarmed and unarmored are stated rather than omitted", () => {
	const line = describePartyForDM(lobbyWith());
	assert.match(line, /weapon: unarmed/);
	assert.match(line, /armor: unarmored/);
});

// ===== Shape =====

test("every party member gets exactly one line", () => {
	const lobby = lobbyWith();
	lobby.players.Sylvie = { name: "Sylvie", class: "Rogue", level: 1, stats: { hp: 9, max_hp: 9 } };
	const lines = describePartyForDM(lobby).split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /Brannor/);
	assert.match(lines[1], /Sylvie/);
});

test("an empty or malformed lobby yields an empty block rather than throwing", () => {
	for (const bad of [null, undefined, {}, { players: null }, { players: {} }]) {
		assert.equal(describePartyForDM(bad), "");
	}
});

test("no line ever contains undefined or NaN", () => {
	const line = describePartyForDM(lobbyWith({ stats: undefined, level: undefined, abilities: undefined }));
	assert.ok(!/undefined|NaN/.test(line), line);
});

// ── The illustration instruction scales with the mode ────────────────────────

import { promptMethods } from "./lobbyPrompts.js";

/**
 * @description Builds the DM system message for a lobby in one illustration mode.
 * @param {string} illustrationMode - The lobby's setting.
 * @returns {string} The system prompt text.
 */
function systemPromptFor(illustrationMode) {
	const store = Object.create(promptMethods);
	store.index = {
		L1: {
			lobbyId: "L1", illustrationMode, abilitySlotsBase: 3,
			players: { Brannor: { name: "Brannor", class: "Fighter", level: 1, stats: { hp: 12, max_hp: 12 } } },
			history: [], enemies: {},
		},
	};
	// composeMessages leans on several sibling mixins. Stubbed to the minimum that
	// lets the system prompt be built, since the prompt text is what is under test.
	store.tail = () => [];
	store.describeParty = () => "";
	store.enemyRoster = () => "";
	store.describeEnemies = () => "";
	store.storyContext = () => "";
	store.recentHistory = () => [];
	const messages = store.composeMessages("L1", "Brannor", "I swing", null);
	return messages.map((m) => m.content).join("\n");
}

test("a sparing mode tells the DM that most turns do not warrant a picture", () => {
	const text = systemPromptFor("key-moments");
	assert.match(text, /illustrate/);
	assert.match(text, /most turns are not one of these/i);
});

test("the freest mode does not simultaneously tell the DM to hold back", () => {
	// The host has asked for pictures whenever the DM likes. Telling it "most turns
	// are not one of these" in the same breath is why the first live run produced
	// no illustrations at all across six turns.
	const text = systemPromptFor("every-scene");
	assert.match(text, /illustrate/);
	assert.doesNotMatch(text, /most turns are not one of these/i);
});

test("illustrations off tell the DM never to populate the field", () => {
	assert.match(systemPromptFor("off"), /Do not use the "illustrate" field/);
});

// ===== How many things attack =====
//
// The standing prompt is the one that shapes most fights: `encounterDirective` only
// fires when the table has gone quiet too long, but this block is on every DM turn.
// It knew the party size and spent it on level guidance alone, then told the model to
// "adjust the NUMBER of enemies rather than using single overpowered foes" with no
// ceiling — advice that is actively wrong for the 39% of games with one character in
// them. Enemy count is the sharpest lever in the engine: measured over the goblin
// archetype it carries a Hardcore party of three from 93% to 11% in three steps.

import { encounterBudget, encounterDirective } from "../encounterPacing.js";

/**
 * @description Builds the DM system message for a lobby of a given size and difficulty,
 *   which is what the encounter budget is derived from.
 * @param {number} partySize - How many living, connected characters to seat.
 * @param {string} difficulty - The lobby difficulty.
 * @returns {string} The composed prompt text.
 */
function promptForTable(partySize, difficulty) {
	const players = {};
	for (let i = 0; i < partySize; i++) {
		players[`P${i}`] = { name: `P${i}`, class: "Fighter", level: 1, stats: { hp: 12, max_hp: 12 } };
	}
	const store = Object.create(promptMethods);
	store.index = { L1: { lobbyId: "L1", difficulty, abilitySlotsBase: 3, players, history: [], enemies: {} } };
	store.tail = () => [];
	store.describeParty = () => "";
	store.enemyRoster = () => "";
	store.describeEnemies = () => "";
	store.storyContext = () => "";
	store.recentHistory = () => [];
	return store.composeMessages("L1", "P0", "I swing", null).map((m) => m.content).join("\n");
}

test("the standing prompt states the enemy count this table should face", () => {
	for (const [partySize, difficulty] of [[1, "standard"], [3, "hardcore"], [4, "merciless"]]) {
		const { max } = encounterBudget({ partySize, difficulty });
		assert.match(promptForTable(partySize, difficulty), new RegExp(`\\b${max} hostile creature`), `P${partySize} ${difficulty}`);
	}
});

test("a solo table is never told to pad the encounter out with more bodies", () => {
	// "Adjust the NUMBER of enemies rather than using single overpowered foes" is the
	// exact instruction that put two goblins in front of one level 1 character, which
	// is a 34% fight on Hardcore where one goblin is an 84% fight.
	assert.doesNotMatch(promptForTable(1, "merciless"), /adjust the number of enemies/i);
});

test("a solo table's standing prompt warns against a party-sized single monster", () => {
	// The count ceiling of one does not protect a lone character from one big thing:
	// the CR 2 ogre that is a 55% fight for a party of three is a 0% fight solo.
	assert.match(promptForTable(1, "standard"), /would be a fair fight for a party/i);
	assert.doesNotMatch(promptForTable(4, "standard"), /would be a fair fight for a party/i);
});

test("the standing prompt and the forced-encounter directive agree on the count", () => {
	// Two places holding the same number is how armour class, spell slots and the
	// condition vocabulary each drifted. Both read `encounterBudget`.
	for (const [partySize, difficulty] of [[1, "casual"], [2, "standard"], [4, "hardcore"], [6, "merciless"]]) {
		const { max } = encounterBudget({ partySize, difficulty });
		const phrase = new RegExp(`\\b${max} hostile creature`);
		assert.match(promptForTable(partySize, difficulty), phrase, `standing prompt, P${partySize} ${difficulty}`);
		assert.match(encounterDirective(difficulty, { partySize }), phrase, `directive, P${partySize} ${difficulty}`);
	}
});

// ===== The loot block =====
//
// The server decides what the party finds and hands the narrator the answer. Two
// things have to survive that handover: the item exactly as rolled, and — the harder
// one — the fact that sometimes there is nothing. Left to itself the DM describes a
// chest and hands the moment back, and the party opens a nested sequence of
// containers that never contain anything.

import { describeLootForDM } from "./lobbyPrompts.js";

/** A drop as `rollLoot` returns it. */
const DROP = {
	source: "boss",
	gold: 40,
	items: [{
		name: "+1 Chain Shirt of Warding",
		rarity: "uncommon",
		baseName: "Chain Shirt",
		effect: "Faint wards are worked into every plate.",
		attributes: { item_type: "armor", ac: 15 },
	}],
};

test("a turn that is not about loot produces no block at all", () => {
	assert.equal(describeLootForDM(null, "Sylvie"), "");
	assert.equal(describeLootForDM(undefined, "Sylvie"), "");
});

test("finding nothing is stated as an instruction, not left implied", () => {
	const block = describeLootForDM({ source: "trash", gold: 0, items: [] }, "Sylvie");

	assert.match(block, /Sylvie finds NOTHING/);
	assert.match(block, /authoritative/i);
});

test("the nothing case forbids dangling a container the party cannot open", () => {
	// The exact behaviour observed: "The chest is open. Whatever is inside has been
	// waiting in goblin-darkness for some time." — and then no contents, ever.
	const block = describeLootForDM({ source: "search", gold: 0, items: [] }, "Brannor");

	assert.match(block, /locked container|glint/i);
});

test("an item is handed over with its name, rarity, base and effect", () => {
	const block = describeLootForDM(DROP, "Sylvie");

	assert.match(block, /\+1 Chain Shirt of Warding/);
	assert.match(block, /uncommon/);
	assert.match(block, /Chain Shirt/);
	assert.match(block, /Faint wards are worked into every plate\./);
});

test("gold is stated as an exact amount", () => {
	assert.match(describeLootForDM(DROP, "Sylvie"), /Sylvie finds 40 gold/);
});

test("the narrator is told what is theirs and what is not", () => {
	const block = describeLootForDM(DROP, "Sylvie");

	assert.match(block, /where it came from/i, "the DM is not invited to invent the provenance");
	assert.match(block, /may NOT change/, "the DM is not told the stats are fixed");
});

test("the narrator is told not to duplicate what the server applied", () => {
	// Without this the party gets two of everything: the server's copy and the DM's.
	const block = describeLootForDM(DROP, "Sylvie");

	assert.match(block, /Do NOT add "inventory" or "gold" updates/);
});

test("gold with no item still produces a block", () => {
	const block = describeLootForDM({ source: "trash", gold: 12, items: [] }, "Brannor");

	assert.match(block, /Brannor finds 12 gold/);
	assert.doesNotMatch(block, /NOTHING/);
});

test("an item with no effect is still fully described", () => {
	const plain = { source: "search", gold: 0, items: [{ name: "Battleaxe", rarity: "common", baseName: "Battleaxe", effect: "", attributes: {} }] };
	const block = describeLootForDM(plain, "Brannor");

	assert.match(block, /Brannor finds: Battleaxe — a common Battleaxe\./);
});

test("every item in a multi-item drop is named", () => {
	const two = {
		source: "cache", gold: 0,
		items: [
			{ name: "Kingsbane", rarity: "legendary", baseName: "Greatsword", effect: "It bites deeper into the crowned.", attributes: {} },
			{ name: "Ring of the Veil", rarity: "rare", baseName: "Ring", effect: "The wearer may vanish once a day.", attributes: {} },
		],
	};
	const block = describeLootForDM(two, "Sylvie");

	assert.match(block, /Kingsbane/);
	assert.match(block, /Ring of the Veil/);
});

test("the DM is told not to hand out gear on its own initiative", () => {
	// The engine only fires on turns the detector recognises. On every other turn the
	// old behaviour leaks straight through: a probed quest-reward turn had the model
	// hand over a hand axe, a potion and 25 gold entirely off its own bat.
	const text = systemPromptFor("off");

	assert.match(text, /do not invent .*(weapons?|armou?r)/i);
	assert.match(text, /server/i);
});

test("giving a player something in a shop or as a reward is still allowed", () => {
	// A blanket ban would break buying a sword, which is a thing players do.
	const text = systemPromptFor("off");

	assert.match(text, /buys|purchases|shop|reward|gives/i);
});

test("a reward for a completed job is no longer the DM's to size", () => {
	// The carve-out used to name "the agreed reward for a completed job" alongside
	// shops and wagers, which is now false: `detectLootMoment` emits a `quest` source
	// and the server rolls it. Leaving the old wording in place invites the model to
	// pay the party twice — once from the block, once from its own imagination.
	const text = systemPromptFor("off");

	assert.doesNotMatch(text, /agreed reward for a completed job/i);
	assert.match(text, /completed job/i);
	assert.match(text, /LOOT THIS TURN/);
});

test("the DM is told player damage is not its arithmetic to do", () => {
	// ENEMY TRACKING still said "when an enemy takes damage, reduce their hp", which
	// now contradicts the resolved-attack block handed to it on the same turn.
	const text = systemPromptFor("off");

	assert.match(text, /do not decide|not yours to decide|already resolved/i);
	assert.match(text, /attack/i);
});

test("the DM is still told to report enemies it introduces", () => {
	// Taking damage away from the model must not take away enemy creation, which is
	// the only way a fight starts at all.
	const text = systemPromptFor("off");

	assert.match(text, /introduce/i);
	assert.match(text, /stat block/i);
});

test("the difficulty instruction tells the DM what the dial actually did", () => {
	// The dial now moves real numbers. A narrator told only "enemies are relentless"
	// will describe a fight that does not match the one the dice are running.
	const store = Object.create(promptMethods);

	const merciless = store._difficultyInstruction("merciless");
	assert.match(merciless, /\+9/, "the enemy attack bonus is not stated");
	assert.match(merciless, /100%/, "the damage scaling is not stated");

	const casual = store._difficultyInstruction("casual");
	assert.match(casual, /-3/);
});

test("the difficulty instruction still tells the DM how to pitch the fiction", () => {
	// The mechanical facts are additions, not a replacement — DCs for non-combat
	// checks are still the narrator's, and they should move with the setting.
	const store = Object.create(promptMethods);

	assert.match(store._difficultyInstruction("casual"), /DC/i);
	assert.match(store._difficultyInstruction("hardcore"), /DC/i);
});

test("the DM is told the combat modifiers are already applied", () => {
	// Otherwise it stacks them: a narrator told "enemies hit 50% harder" may inflate
	// the damage it describes on top of damage the server already scaled.
	const store = Object.create(promptMethods);

	assert.match(store._difficultyInstruction("merciless"), /already applied|do not apply|server/i);
});
