import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCapability, remainingSlots, slotCapacity } from "./characterCapability.js";

/**
 * Builds a lobby containing one player, merged over a realistic baseline.
 *
 * @description Mirrors the persisted shape in server/data/lobbies/*.json. Tests
 *   override only the field under examination, so a change to the baseline does not
 *   silently weaken unrelated cases.
 * @param {object} [player] - Player fields to merge over the baseline.
 * @param {object} [lobby] - Lobby fields to merge over the baseline.
 * @returns {object} A lobby object suitable for buildCapability.
 */
function makeLobby(player = {}, lobby = {}) {
	return {
		lobbyId: "lob1",
		phase: "running",
		initiative: ["Ayla"],
		turnIndex: 0,
		round: 1,
		enemies: {},
		players: {
			Ayla: {
				name: "Ayla",
				class: "Fighter",
				race: "Human",
				level: 3,
				xp: 900,
				gold: 25,
				spellSlotsUsed: 1,
				dead: false,
				stats: { hp: 18, max_hp: 24, str: 16, dex: 12, con: 14, int: 10, wis: 11, cha: 9 },
				abilities: [{ name: "Second Wind", description: "Regain hit points.", details: { uses: 1 } }],
				inventory: [{ name: "Healing Potion", count: 2, description: "Restores health.", attributes: { healing: "2d4" } }],
				weapon: { name: "Longsword", damage: "1d8", damageType: "slashing" },
				armor: { name: "Chain Mail", ac: 16, type: "heavy" },
				conditions: [],
				...player,
			},
		},
		...lobby,
	};
}

// ── Basic shape ──────────────────────────────────────────────────────────────

test("buildCapability reports success for a well-formed player", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").ok, true);
});

test("buildCapability reports failure rather than throwing for an unknown player", () => {
	const cap = buildCapability(makeLobby(), "Nobody");
	assert.equal(cap.ok, false);
	assert.match(cap.reason, /not found/i);
});

test("buildCapability does not throw on a null lobby", () => {
	assert.doesNotThrow(() => buildCapability(null, "Ayla"));
	assert.equal(buildCapability(null, "Ayla").ok, false);
});

test("buildCapability does not throw on a player record that is an empty object", () => {
	const lobby = makeLobby();
	lobby.players.Ayla = {};
	assert.doesNotThrow(() => buildCapability(lobby, "Ayla"));
});

test("buildCapability does not throw when stats is a string instead of an object", () => {
	assert.doesNotThrow(() => buildCapability(makeLobby({ stats: "broken" }), "Ayla"));
});

// ── The shared resource pool ─────────────────────────────────────────────────

test("remaining slots is level minus slots used", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").resources.slots.remaining, 2); // level 3, used 1
});

test("the slot pool maximum is the character level", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").resources.slots.max, 3);
});

test("remaining slots never goes negative when more were spent than exist", () => {
	assert.equal(buildCapability(makeLobby({ level: 2, spellSlotsUsed: 5 }), "Ayla").resources.slots.remaining, 0);
});

test("the slot pool is described as covering every ability, not only spells", () => {
	// A level-1 Fighter has exactly one activation of anything. The model must say so
	// plainly, because an advisor that assumes martial abilities are free would
	// recommend actions the character cannot pay for.
	const cap = buildCapability(makeLobby({ level: 1, spellSlotsUsed: 1, class: "Fighter" }), "Ayla");
	assert.equal(cap.resources.slots.remaining, 0);
	assert.match(cap.resources.slots.note, /every ability/i);
});

test("remainingSlots is exported so the five inline copies can converge on it", () => {
	assert.equal(remainingSlots({ level: 4, spellSlotsUsed: 1 }), 3);
});

test("remainingSlots treats a missing level as level one", () => {
	assert.equal(remainingSlots({}), 1);
});

// ── Things the engine genuinely does not model ───────────────────────────────

test("per-ability use counts are reported as untracked even when the ability declares one", () => {
	// Second Wind carries details.uses = 1, but nothing in the engine decrements it.
	const cap = buildCapability(makeLobby(), "Ayla");
	assert.equal(cap.abilities[0].usesTracked, false);
});

test("item charges are reported as untracked because no charges field exists", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").inventory[0].chargesTracked, false);
});

// ── Legacy and malformed shapes ──────────────────────────────────────────────

test("a bare string ability is normalised into an object", () => {
	const cap = buildCapability(makeLobby({ abilities: ["Power Attack"] }), "Ayla");
	assert.equal(cap.abilities[0].name, "Power Attack");
	assert.equal(cap.abilities[0].description, "");
});

test("a bare string inventory entry is normalised into a counted object", () => {
	const cap = buildCapability(makeLobby({ inventory: ["Rope"] }), "Ayla");
	assert.deepEqual(
		{ name: cap.inventory[0].name, count: cap.inventory[0].count },
		{ name: "Rope", count: 1 },
	);
});

test("null and numeric ability entries are dropped and recorded as warnings", () => {
	const cap = buildCapability(makeLobby({ abilities: [null, 42, { name: "Real" }] }), "Ayla");
	assert.deepEqual(cap.abilities.map((a) => a.name), ["Real"]);
	assert.ok(cap.warnings.length > 0);
});

test("a non-array inventory is treated as empty and recorded as a warning", () => {
	const cap = buildCapability(makeLobby({ inventory: "a pile of things" }), "Ayla");
	assert.deepEqual(cap.inventory, []);
	assert.ok(cap.warnings.some((w) => /inventory/i.test(w)));
});

test("a comma joined conditions string is parsed into an array", () => {
	const cap = buildCapability(makeLobby({ conditions: "poisoned, prone" }), "Ayla");
	assert.deepEqual(cap.conditions, ["poisoned", "prone"]);
});

test("the None sentinel is discarded because it is a display string, not a condition", () => {
	assert.deepEqual(buildCapability(makeLobby({ conditions: "None" }), "Ayla").conditions, []);
});

test("the Dead sentinel is discarded because it is a status, not a condition", () => {
	assert.deepEqual(buildCapability(makeLobby({ conditions: "Dead" }), "Ayla").conditions, []);
});

// ── Honesty about unknowns ───────────────────────────────────────────────────

test("hit points are reported as null rather than defaulting to ten", () => {
	const cap = buildCapability(makeLobby({ stats: {} }), "Ayla");
	assert.equal(cap.health.hp, null);
});

test("maximum hit points are reported as null rather than picking one of the existing fallbacks", () => {
	// Four consumers currently disagree on the fallback (1, 1, 10, 10). Inventing a
	// fifth would make the model authoritative about something it does not know.
	assert.equal(buildCapability(makeLobby({ stats: { hp: 5 } }), "Ayla").health.maxHp, null);
});

test("armour class is reported as null when nothing is equipped", () => {
	assert.equal(buildCapability(makeLobby({ armor: null }), "Ayla").equipped.armorClass, null);
});

test("an unequipped weapon is null rather than undefined", () => {
	assert.equal(buildCapability(makeLobby({ weapon: undefined }), "Ayla").equipped.weapon, null);
});

test("a class outside the progression table is flagged as unknown", () => {
	const cap = buildCapability(makeLobby({ class: "Adventurer" }), "Ayla");
	assert.equal(cap.classKnown, false);
});

test("a recognised class is not flagged", () => {
	assert.equal(buildCapability(makeLobby({ class: "Fighter" }), "Ayla").classKnown, true);
});

// ── Action-blocking state ────────────────────────────────────────────────────

test("a dead character is reported as unable to act", () => {
	assert.equal(buildCapability(makeLobby({ dead: true }), "Ayla").canAct, false);
});

test("a character at zero hit points is reported as unable to act", () => {
	assert.equal(buildCapability(makeLobby({ stats: { hp: 0, max_hp: 10 } }), "Ayla").canAct, false);
});

test("a healthy character is reported as able to act", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").canAct, true);
});

test("whether it is the character's turn is reported", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").isMyTurn, true);
});

test("a character who is not the active player is told so", () => {
	const lobby = makeLobby();
	lobby.initiative = ["Brom", "Ayla"];
	assert.equal(buildCapability(lobby, "Ayla").isMyTurn, false);
});

// ── Isolation ────────────────────────────────────────────────────────────────

test("the capability is a copy that cannot be used to mutate the lobby", () => {
	const lobby = makeLobby();
	const cap = buildCapability(lobby, "Ayla");
	cap.inventory[0].count = 999;
	cap.abilities[0].name = "Hacked";
	assert.equal(lobby.players.Ayla.inventory[0].count, 2);
	assert.equal(lobby.players.Ayla.abilities[0].name, "Second Wind");
});

test("prototype polluting keys are stripped from an attributes bag", () => {
	const evil = JSON.parse('{"name":"Trap","count":1,"attributes":{"__proto__":{"polluted":true}}}');
	const cap = buildCapability(makeLobby({ inventory: [evil] }), "Ayla");
	assert.equal({}.polluted, undefined);
	assert.equal(cap.inventory[0].name, "Trap");
});

test("every persisted lobby on disk builds a capability without throwing", async () => {
	// The 18 saved lobbies are the closest thing to production data available, and
	// they are where legacy shapes actually live.
	const fs = await import("node:fs");
	const path = await import("node:path");
	const dir = path.join(process.cwd(), "server", "data", "lobbies");
	if (!fs.existsSync(dir)) return;
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		let lobby;
		try { lobby = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { continue; }
		for (const name of Object.keys(lobby.players || {})) {
			assert.doesNotThrow(() => buildCapability(lobby, name), `${file} / ${name}`);
		}
	}
});

// ── Configurable ability pool ────────────────────────────────────────────────

test("the pool defaults to one activation at level one, matching the previous behaviour", () => {
	const cap = buildCapability(makeLobby({ level: 1, spellSlotsUsed: 0 }), "Ayla");
	assert.equal(cap.resources.slots.max, 1);
	assert.equal(cap.resources.slots.remaining, 1);
});

test("the host can raise the base, and it applies from level one", () => {
	// The default of one activation for a whole level-1 game is punishing; a host
	// running a combat-heavy session needs to open it up.
	const lobby = makeLobby({ level: 1, spellSlotsUsed: 0 }, { abilitySlotsBase: 5 });
	assert.equal(buildCapability(lobby, "Ayla").resources.slots.max, 5);
});

test("levelling still adds one activation per level on top of the base", () => {
	const lobby = makeLobby({ level: 3, spellSlotsUsed: 0 }, { abilitySlotsBase: 5 });
	assert.equal(buildCapability(lobby, "Ayla").resources.slots.max, 7); // 5 + (3 - 1)
});

test("a base of zero means abilities cost something the character does not have", () => {
	const lobby = makeLobby({ level: 1, spellSlotsUsed: 0 }, { abilitySlotsBase: 0 });
	assert.equal(buildCapability(lobby, "Ayla").resources.slots.max, 0);
	assert.equal(buildCapability(lobby, "Ayla").resources.slots.remaining, 0);
});

test("an unlimited pool never runs out", () => {
	const lobby = makeLobby({ level: 1, spellSlotsUsed: 99 }, { abilitySlotsBase: "unlimited" });
	const slots = buildCapability(lobby, "Ayla").resources.slots;
	assert.equal(slots.unlimited, true);
	assert.ok(slots.remaining > 0, "an unlimited pool always has something left");
});

test("an unlimited pool is flagged so a display can say so instead of printing a number", () => {
	const lobby = makeLobby({}, { abilitySlotsBase: "unlimited" });
	const slots = buildCapability(lobby, "Ayla").resources.slots;
	assert.equal(slots.unlimited, true);
	assert.equal(slots.max, null, "there is no maximum to report");
});

test("a limited pool is not flagged unlimited", () => {
	assert.equal(buildCapability(makeLobby(), "Ayla").resources.slots.unlimited, false);
});

test("a nonsensical base falls back to the default rather than breaking the pool", () => {
	const lobby = makeLobby({ level: 1 }, { abilitySlotsBase: "banana" });
	assert.equal(buildCapability(lobby, "Ayla").resources.slots.max, 1);
});

test("the pool note explains the rule whatever the base is", () => {
	assert.match(buildCapability(makeLobby(), "Ayla").resources.slots.note, /every ability/i);
});

test("remainingSlots honours an explicit base", () => {
	assert.equal(remainingSlots({ level: 1, spellSlotsUsed: 0 }, 5), 5);
});

test("remainingSlots returns Infinity for an unlimited base", () => {
	assert.equal(remainingSlots({ level: 1, spellSlotsUsed: 99 }, "unlimited"), Infinity);
});

test("remainingSlots keeps its one-argument behaviour for existing callers", () => {
	assert.equal(remainingSlots({ level: 4, spellSlotsUsed: 1 }), 3);
});

test("slotCapacity is the one place the pool size is decided", () => {
	// The spend path and the admin adjuster both clamped to player.level directly.
	// With a configured base of 3, a level-1 character showed "3 uses left" but could
	// only ever spend one, because the clamp disagreed with the model.
	const player = { level: 1, spellSlotsUsed: 0 };
	assert.equal(slotCapacity(player, 3), 3);
	assert.equal(slotCapacity(player, "unlimited"), Infinity);
	assert.equal(slotCapacity(player), 1);
});
