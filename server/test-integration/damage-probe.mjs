/**
 * Does the Dungeon Master actually apply combat damage?
 *
 * @description Two games totalling 57 turns produced zero negative HP deltas. The
 *   prompt told the model to reduce *enemy* HP but never said enemies hit back, and
 *   the only HP guidance was environmental ("burns their hand"). A prompt change is
 *   only verifiable empirically, so this drives one real DM call with the party
 *   under attack and reports whether the reply contains damage — cheap enough to run
 *   before committing to a full game.
 *
 *   node server/test-integration/damage-probe.mjs [runs]
 */

import { LobbyStore } from "../services/lobbyStore.js";
import { getLLMResponse } from "../services/llmService.js";
import { parseDMJson } from "../helpers/parseDMJson.js";

const RUNS = Number(process.argv[2] ?? 3);
const store = new LobbyStore();

const lobbyId = "probe1";
store.index[lobbyId] = {
	lobbyId,
	code: "PROBE1",
	phase: "running",
	sockets: {},
	storyContext: "The party is cornered in a collapsed mine shaft. Three goblins have "
		+ "them pinned against the rubble and are attacking.",
	history: [],
	initiative: ["Brannor Ironfoot", "Sylvie Ashwren"],
	turnIndex: 0,
	round: 3,
	abilitySlotsBase: 3,
	brutalityLevel: 9,
	difficulty: "merciless",
	llmProvider: "openai",
	llmModel: "gpt-4o",
	players: {
		"Brannor Ironfoot": {
			name: "Brannor Ironfoot", class: "Fighter", race: "Dwarf", level: 1, xp: 0,
			stats: { hp: 12, max_hp: 12, str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
			abilities: [{ name: "Second Wind" }], inventory: [{ name: "Healing Potion", count: 2 }],
			weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
			conditions: [],
		},
		"Sylvie Ashwren": {
			name: "Sylvie Ashwren", class: "Rogue", race: "Half-Elf", level: 1, xp: 0,
			stats: { hp: 9, max_hp: 9, str: 8, dex: 16, con: 12, int: 12, wis: 12, cha: 14 },
			abilities: [{ name: "Sneak Attack" }], inventory: [{ name: "Healing Potion", count: 2 }],
			weapon: { name: "Dagger", damage: "1d4", damageType: "piercing", range: "melee" },
			conditions: [],
		},
	},
	enemies: {
		"Goblin 1": { name: "Goblin 1", hp: 7, max_hp: 7, ac: 15, cr: "1/4", status: "active" },
		"Goblin 2": { name: "Goblin 2", hp: 7, max_hp: 7, ac: 15, cr: "1/4", status: "active" },
		"Goblin 3": { name: "Goblin 3", hp: 7, max_hp: 7, ac: 15, cr: "1/4", status: "active" },
	},
};

const action = "I swing my shortsword at the nearest goblin, trying to drive them back from Sylvie.";
store.appendPlayer?.(lobbyId, "Brannor Ironfoot", action);

// The real turn is two halves: the DM asks for a roll, the server rolls, and only
// the second call resolves the action. Probing with no dice outcome measured the
// first half, where nothing is meant to happen to anyone.
const rollOutcome = {
	kind: "d20 ATTACK (str+3)",
	value: 18,
	detail: { base: 15, bonus: 3, stat: "str", outcome: "success" },
};

let damaged = 0;
for (let i = 1; i <= RUNS; i++) {
	const msgs = store.composeMessages(lobbyId, "Brannor Ironfoot", action, rollOutcome);
	const raw = await getLLMResponse(msgs, { provider: "openai", model: "gpt-4o", lobbyId });
	const dm = await parseDMJson(raw, { getLLMResponse, llmOpts: { provider: "openai", model: "gpt-4o" } });

	const hp = dm?.updates?.hp ?? [];
	const hits = hp.filter((h) => Number(h.delta) < 0);
	if (hits.length) damaged++;

	console.log(`run ${i}: hp updates=${JSON.stringify(hp)}`);
	console.log(`        enemies=${JSON.stringify((dm?.updates?.enemies ?? []).map((e) => `${e.name} ${e.hp}hp ${e.status}`))}`);
}

console.log(`\n${damaged}/${RUNS} DM responses dealt damage to a player.`);
process.exit(damaged > 0 ? 0 : 1);
