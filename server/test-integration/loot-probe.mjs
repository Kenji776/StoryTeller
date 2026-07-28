/**
 * Functional probe: what does the Dungeon Master actually hand out?
 *
 * @description Finding gear is one of the load-bearing pleasures of D&D, and the
 *   only instruction the prompt carries about it is one sentence of
 *   `_lootInstruction`. Whether that sentence produces anything a player would be
 *   pleased to find is not answerable by reading the code — it is a question about
 *   a model's behaviour, so it has to be measured.
 *
 *   This drives the real production prompt (`composeMessages`) through the real
 *   gateway in situations deliberately built to yield loot: searching bodies,
 *   forcing a chest, looting a boss, tossing a wizard's study. It reports exactly
 *   what came back in `updates.inventory` and `updates.gold`, and whether the
 *   items carry the `attributes` the equip UI needs to make them wearable.
 *
 *   Costs real money. Run it by hand.
 *
 *     node server/test-integration/loot-probe.mjs [--generosity fair|sparse|generous] [--runs 1]
 */

import dotenv from "dotenv";
import fetchImpl from "node-fetch";

dotenv.config({ path: new URL("../.env", import.meta.url) });

const { LobbyStore } = await import("../services/lobbyStore.js");
const { detectLootMoment } = await import("../services/lootMoment.js");
const { rollLoot } = await import("../services/loot.js");
const { createCredentialSystem } = await import("../services/credentials/index.js");
const { createLLMGateway } = await import("../services/llmGateway.js");
const { parseDMJson } = await import("../helpers/parseDMJson.js");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GENEROSITY = arg("generosity", "fair");
const RUNS = Number(arg("runs", 1));
// "open" stages a fresh loot-seeking turn; "followup" stages the beat *after* the
// DM has already described a container and handed the moment back, which is what
// the first run of this probe showed it does every time.
const SET = arg("set", "open");
// Pins the engine so the probe measures the DM's obedience rather than the dice.
// "nothing" is the case that matters: the narrator's failure mode is describing a
// container and handing the moment back, forever.
const FORCE = arg("force", "");

/**
 * Drops handed to the prompt instead of a rolled one, so the probe measures the
 * narrator's obedience rather than the dice.
 *
 * `nothing` is the case that matters most: the DM's failure mode was describing a
 * container and handing the moment back, forever. `treasure` is handcrafted rather
 * than forced out of `rollLoot` with a rigged rng, because a rigged rng picks the
 * floor of every table and a common Dagger proves nothing about whether a memorable
 * item survives the handover.
 */
const FORCED_LOOT = {
	nothing: () => ({ source: "search", rarity: null, gold: 0, items: [] }),
	treasure: () => ({
		source: "boss",
		rarity: "rare",
		gold: 120,
		items: [{
			name: "Whisperfang",
			rarity: "rare",
			slot: "weapon",
			baseName: "Dagger",
			bonus: 1,
			effect: "This weapon makes no sound when drawn or when it strikes. Attacks made with it from hiding do not reveal the wielder's position.",
			attributes: { item_type: "weapon", damage: "1d4", damage_type: "piercing", range: "melee", bonus: 1, silent: true },
		}],
	}),
};
const PROVIDER = arg("provider", "anthropic");
const MODEL = arg("model", "claude-sonnet-4-6");

/**
 * @description Converts a file URL to a path Windows and POSIX both accept, the
 *   same fix `illustrate-probe.mjs` carries.
 * @param {URL} url - The URL to convert.
 * @returns {string} A usable filesystem path.
 */
function toPath(url) {
	return url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

const credentials = createCredentialSystem({
	dataDir: toPath(new URL("../data/credentials", import.meta.url)),
	secret: process.env.STORYTELLER_SECRET || null,
	log: () => {},
});
const gateway = createLLMGateway({
	credentials,
	logDir: toPath(new URL("../logs", import.meta.url)),
	fetchImpl,
	log: () => {},
});

const store = new LobbyStore();

/**
 * @description Builds a throwaway lobby in memory. Written straight into `index`
 *   rather than through `createLobby` so nothing reaches disk — this probe must not
 *   leave a lobby file behind for the next real game to rehydrate.
 * @param {string} lobbyId - The lobby key.
 * @param {object} scenario - The scenario being staged.
 * @returns {void}
 */
function stageLobby(lobbyId, scenario) {
	store.index[lobbyId] = {
		lobbyId,
		code: lobbyId.toUpperCase(),
		phase: "running",
		sockets: {},
		storyContext: scenario.context,
		history: scenario.priorDM ? [{ role: "assistant", content: scenario.priorDM }] : [],
		initiative: ["Brannor Ironfoot", "Sylvie Ashwren"],
		turnIndex: 0,
		round: scenario.round ?? 4,
		abilitySlotsBase: 3,
		brutalityLevel: 5,
		difficulty: "standard",
		lootGenerosity: GENEROSITY,
		campaignSetting: "standard",
		illustrationMode: "off",
		llmProvider: PROVIDER,
		llmModel: MODEL,
		enemies: scenario.enemies ?? {},
		players: {
			"Brannor Ironfoot": {
				name: "Brannor Ironfoot", class: "Fighter", race: "Dwarf", level: 3, xp: 900, gold: 25,
				stats: { hp: 24, max_hp: 28, str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 10 },
				abilities: [{ name: "Second Wind" }],
				inventory: [{ name: "Healing Potion", count: 2 }, { name: "Rations", count: 3 }],
				weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
				armor: { name: "Leather Armor", ac: 11, type: "light" },
				conditions: [],
			},
			"Sylvie Ashwren": {
				name: "Sylvie Ashwren", class: "Rogue", race: "Halfling", level: 3, xp: 900, gold: 40,
				stats: { hp: 18, max_hp: 21, str: 8, dex: 16, con: 12, int: 12, wis: 12, cha: 14 },
				abilities: [{ name: "Sneak Attack" }],
				inventory: [{ name: "Thieves' Tools", count: 1 }],
				weapon: { name: "Dagger", damage: "1d4", damageType: "piercing", range: "melee" },
				armor: { name: "Leather Armor", ac: 11, type: "light" },
				conditions: [],
			},
		},
	};
}

/**
 * Situations a player would expect to produce loot. Each carries the dice outcome
 * the server would have rolled, because the real turn resolves in two halves and a
 * probe with no roll measures the half where nothing is meant to happen yet.
 */
const SCENARIOS = [
	{
		id: "search-bodies",
		context: "The party has just killed three goblins in a collapsed mine shaft. The bodies "
			+ "lie among the rubble. Nothing else is moving.",
		// The roster is what tells the detector how big the thing that died was, so a
		// scenario without one measures the fallback rather than the case it names.
		enemies: {
			"Goblin 1": { name: "Goblin 1", hp: 0, max_hp: 7, cr: "1/4", status: "dead" },
			"Goblin 2": { name: "Goblin 2", hp: 0, max_hp: 7, cr: "1/4", status: "dead" },
			"Goblin 3": { name: "Goblin 3", hp: 0, max_hp: 7, cr: "1/4", status: "dead" },
		},
		actor: "Sylvie Ashwren",
		action: "I search the goblin bodies for anything useful — coin, weapons, anything they were carrying.",
		roll: { kind: "d20 INVESTIGATION (int+1)", value: 17, detail: { base: 16, bonus: 1, stat: "int", outcome: "success" } },
	},
	{
		id: "force-chest",
		context: "Behind the goblins' bedding the party found an iron-bound chest, banded and locked, "
			+ "clearly not goblin work — something they stole and could not open.",
		actor: "Sylvie Ashwren",
		action: "I work the lock on the iron-bound chest with my thieves' tools and open it.",
		roll: { kind: "d20 SLEIGHT OF HAND (dex+3)", value: 21, detail: { base: 18, bonus: 3, stat: "dex", outcome: "success" } },
	},
	{
		id: "boss-corpse",
		context: "The ogre chieftain Gurnak, who has terrorised the valley for a season, lies dead at "
			+ "the party's feet in his hall. The fight is over. His warband has scattered.",
		enemies: { Gurnak: { name: "Gurnak", hp: 0, max_hp: 76, cr: "7", status: "dead" } },
		actor: "Brannor Ironfoot",
		action: "I kneel beside Gurnak's body and take whatever he was carrying.",
		roll: { kind: "d20 INVESTIGATION (int-1)", value: 14, detail: { base: 15, bonus: -1, stat: "int", outcome: "success" } },
	},
	{
		id: "search-study",
		context: "The party has broken into the study of the hedge-wizard Ollivan, who fled two days ago. "
			+ "Shelves of books, a cold hearth, a writing desk, a locked cabinet.",
		actor: "Sylvie Ashwren",
		action: "I search the study carefully — the desk drawers, behind the books, under the rug — for anything hidden.",
		roll: { kind: "d20 INVESTIGATION (int+1)", value: 19, detail: { base: 18, bonus: 1, stat: "int", outcome: "success" } },
	},
	{
		id: "explicit-treasure",
		context: "The party stands in the burial chamber beneath the barrow. The dead thing that guarded "
			+ "it is destroyed. Alcoves line the walls, and grave-goods are heaped at the bier.",
		actor: "Brannor Ironfoot",
		action: "I look for treasure among the grave-goods.",
		roll: { kind: "d20 PERCEPTION (wis+0)", value: 16, detail: { base: 16, bonus: 0, stat: "wis", outcome: "success" } },
	},
	{
		id: "quest-reward",
		context: "The party has returned Elder Maerith's stolen reliquary to her. She is a village elder "
			+ "of modest means but genuine gratitude, and the village owes them.",
		actor: "Brannor Ironfoot",
		action: "I hand the reliquary back to Elder Maerith and tell her the road was harder than we expected.",
		roll: null,
	},
];

/**
 * The beat after. Each of these carries the DM's own previous narration — taken
 * verbatim from the first run of this probe — in which it described a container and
 * then stopped. The player now reaches in. If loot still does not appear here, the
 * deferral is not a one-turn delay, it is a loop.
 */
const FOLLOWUP_SCENARIOS = [
	{
		id: "chest-reach-in",
		context: "The party killed three goblins in a mine shaft and found an iron-bound chest behind "
			+ "the bedding. Sylvie has picked the lock and the hasp is open.",
		priorDM: "The chest is open. Whatever is inside has been waiting in goblin-darkness for some time.",
		actor: "Sylvie Ashwren",
		action: "I lift the lid all the way and take out everything inside.",
		roll: null,
	},
	{
		id: "strongbox-take",
		context: "Gurnak the ogre chieftain lies dead in his hall. His warband has fled.",
		priorDM: "Beneath one of the throne's legs you can see the glint of something metallic — a strongbox, "
			+ "perhaps, or loose coin.",
		actor: "Brannor Ironfoot",
		action: "I drag the strongbox out from under the throne and break it open, and I take what is in it.",
		roll: { kind: "d20 ATHLETICS (str+3)", value: 20, detail: { base: 17, bonus: 3, stat: "str", outcome: "success" } },
	},
	{
		id: "grave-goods-open",
		context: "The wight guarding the barrow is destroyed. Grave-goods are heaped at the foot of the bier: "
			+ "a leather satchel, a wooden coffer with a tarnished silver clasp, and a bundle in oilcloth.",
		priorDM: "Heaped at the foot of the bier are what appear to be grave-goods of greater value — a leather "
			+ "satchel, a wooden coffer, and a bundle wrapped in oilcloth.",
		actor: "Brannor Ironfoot",
		action: "I open the satchel, the coffer and the oilcloth bundle, one after another, and take what is in them.",
		roll: { kind: "d20 INVESTIGATION (int-1)", value: 15, detail: { base: 16, bonus: -1, stat: "int", outcome: "success" } },
	},
];

/**
 * The same situations with the dice going against the party. If loot still appears
 * here, the DM is not gating rewards on the roll at all, and "sometimes you find
 * nothing" is not a state the game can currently reach.
 */
const FAILED_SCENARIOS = SCENARIOS.slice(0, 3).map((s) => ({
	...s,
	id: `${s.id}-failed`,
	roll: s.roll
		? { ...s.roll, value: 4, detail: { ...s.roll.detail, base: 3, outcome: "failure" } }
		: { kind: "d20 INVESTIGATION (int+1)", value: 5, detail: { base: 4, bonus: 1, stat: "int", outcome: "failure" } },
}));

/**
 * @description Classifies an item as ordinary kit or something a player would be
 *   pleased to find. Crude on purpose: the interesting signal is a proper name or a
 *   stated magical property, and both are visible in the text.
 * @param {object} entry - One `updates.inventory` entry.
 * @returns {string} A short label for the report.
 */
function classify(entry) {
	const text = `${entry.item || ""} ${entry.description || ""}`.toLowerCase();
	const attrs = entry.attributes || {};
	const magical = /\bmagic|enchant|glow|rune|arcane|\+1|\+2|blessed|cursed\b/.test(text);
	const named = /^(the |[A-Z][a-z]+['’]s )/.test(entry.item || "") || /\bof the\b|\bof \w+/i.test(entry.item || "");
	const equippable = ["weapon", "armor", "trinket"].includes(attrs.item_type);
	if (magical) return "MAGICAL";
	if (named && equippable) return "NAMED GEAR";
	if (equippable) return "plain gear";
	if (attrs.item_type === "consumable") return "consumable";
	return "mundane";
}

const SETS = { open: SCENARIOS, followup: FOLLOWUP_SCENARIOS, failed: FAILED_SCENARIOS };
const ACTIVE = SETS[SET] ?? SCENARIOS;

console.log(`loot probe — set="${SET}", generosity="${GENEROSITY}", ${PROVIDER}/${MODEL}, ${RUNS} run(s) per scenario\n`);

const tally = { calls: 0, withItems: 0, withGold: 0, items: 0, equippable: 0, magical: 0, withAttrs: 0, grants: 0, narrated: 0, conjured: 0, duplicated: 0 };

for (const scenario of ACTIVE) {
	for (let run = 1; run <= RUNS; run++) {
		const lobbyId = `probe-loot-${scenario.id}-${run}`;
		stageLobby(lobbyId, scenario);
		// The real turn appends the action to history *before* composing, and
		// `composeMessages` deliberately does not add it again. Pushed directly rather
		// than through `appendUser`, which persists and would leave a lobby file behind.
		store.index[lobbyId].history.push({ role: "user", name: scenario.actor, content: scenario.action });

		// The server now decides the reward before the model writes. Driven through
		// the real detector and the real engine, so this probe measures the whole
		// path — including whether the DM honours being told the party finds nothing.
		const moment = detectLootMoment({ action: scenario.action, enemies: store.index[lobbyId].enemies });
		let loot = null;
		if (moment) {
			loot = FORCED_LOOT[FORCE]
				? FORCED_LOOT[FORCE]()
				: rollLoot({ source: moment.source, partyLevel: 3, generosity: GENEROSITY });
		}

		console.log(`── ${RUNS > 1 ? `${scenario.id} #${run}` : scenario.id} ${"─".repeat(Math.max(0, 50 - scenario.id.length))}`);
		console.log(`   detected:  ${moment ? moment.source : "(not a loot moment)"}`);
		console.log(`   server rolled: ${loot ? (loot.items.length || loot.gold ? `${loot.gold}g — ${loot.items.map((i) => `${i.name} [${i.rarity}]`).join(", ") || "no item"}` : "NOTHING") : "—"}`);

		const messages = store.composeMessages(lobbyId, scenario.actor, scenario.action, scenario.roll, loot);
		const raw = await gateway.getLLMResponse(messages, { provider: PROVIDER, model: MODEL, lobbyId });
		const dm = await parseDMJson(raw, {
			getLLMResponse: gateway.getLLMResponse,
			llmOpts: { provider: PROVIDER, model: MODEL, lobbyId },
		});

		const inv = dm?.updates?.inventory ?? [];
		const gold = dm?.updates?.gold ?? [];
		const prose = String(dm?.text || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

		tally.calls++;
		if (inv.some((i) => Number(i.change) > 0)) tally.withItems++;
		if (gold.some((g) => Number(g.delta) > 0)) tally.withGold++;

		// The DM's updates are no longer where loot lives — the server applies it. What
		// is being measured now is whether the narration honours the block: naming the
		// item it was given, and not conjuring gear it was not.
		if (loot) {
			tally.grants++;
			const named = loot.items.every((i) => prose.toLowerCase().includes(i.name.toLowerCase()));
			const conjured = inv.filter((i) =>
				Number(i.change) > 0
				&& ["weapon", "armor", "trinket"].includes(i.attributes?.item_type)
				&& !loot.items.some((g) => g.name.toLowerCase() === String(i.item).toLowerCase())
			);
			const duplicated = inv.some((i) => loot.items.some((g) => g.name.toLowerCase() === String(i.item).toLowerCase()))
				|| (loot.gold > 0 && gold.some((g) => Number(g.delta) > 0));

			if (loot.items.length && named) tally.narrated++;
			if (conjured.length) tally.conjured++;
			if (duplicated) tally.duplicated++;

			console.log(`   honoured:  ${loot.items.length ? (named ? "named the item ✓" : "DID NOT name the item ✗") : "n/a (nothing to name)"}`
				+ ` | conjured gear: ${conjured.length ? `✗ ${conjured.map((c) => c.item).join(", ")}` : "none ✓"}`
				+ ` | duplicated: ${duplicated ? "✗ yes" : "no ✓"}`);
		}

		console.log(`   narration: "${prose.slice(0, 260)}…"`);

		if (!inv.length) {
			console.log(`   items:     (none)`);
		} else {
			for (const entry of inv.filter((i) => Number(i.change) > 0)) {
				tally.items++;
				const attrs = entry.attributes || {};
				const hasAttrs = Object.keys(attrs).length > 0;
				if (hasAttrs) tally.withAttrs++;
				const kind = classify(entry);
				if (kind === "MAGICAL") tally.magical++;
				if (["weapon", "armor", "trinket"].includes(attrs.item_type)) tally.equippable++;
				console.log(`   item:      [${kind}] ${entry.item} ×${entry.change} → ${entry.player}`);
				console.log(`              desc: ${entry.description ? `"${entry.description}"` : "(none)"}`);
				console.log(`              attributes: ${hasAttrs ? JSON.stringify(attrs) : "(none — cannot be equipped)"}`);
			}
		}

		const goldLines = gold.filter((g) => Number(g.delta) !== 0);
		console.log(`   gold:      ${goldLines.length ? goldLines.map((g) => `${g.player} ${g.delta > 0 ? "+" : ""}${g.delta}`).join(", ") : "(none)"}`);
		console.log();

		delete store.index[lobbyId];
	}
}

console.log(`══ summary ${"═".repeat(50)}`);
console.log(`   ${tally.grants}/${tally.calls} turns were recognised as loot moments`);
console.log(`   ${tally.narrated} of those named the granted item in the narration`);
console.log(`   ${tally.conjured} conjured equipment the server never granted`);
console.log(`   ${tally.duplicated} duplicated the grant into their own updates`);
console.log(`   ${tally.items} items came through the DM channel (quest hooks and consumables are expected here)`);
