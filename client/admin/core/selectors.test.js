import test from "node:test";
import assert from "node:assert/strict";
import {
	selectTurn,
	selectPlayers,
	selectVitals,
	selectEnemies,
	selectCampaign,
	selectLobbyCards,
} from "./selectors.js";

/**
 * A lobby shaped exactly as `LobbyStore.publicState` publishes it — an `initiative`
 * array with a separate `turnIndex`, and `players` as a map of raw records.
 */
const lobby = () => ({
	lobbyId: "lobby-1",
	code: "X4K2",
	adventureName: "Ravenholm Keep",
	phase: "running",
	round: 4,
	initiative: ["Mira", "Bran", "Talia"],
	turnIndex: 1,
	currentMusic: "tense_combat",
	llmProvider: "claude",
	llmModel: "claude-sonnet-4-6",
	timerEnabled: true,
	timerMinutes: 5,
	connected: [{ name: "Mira", ready: true }, { name: "Bran", ready: true }],
	players: {
		Mira: {
			name: "Mira", race: "Elf", class: "Rogue", level: 3, xp: 1450, gold: 340,
			conditions: ["poisoned"], stats: { hp: 18, max_hp: 22 }, spellSlotsUsed: 1,
		},
		Bran: {
			name: "Bran", race: "Dwarf", class: "Fighter", level: 3, xp: 1400, gold: 12,
			conditions: [], stats: { hp: 22, max_hp: 30 }, spellSlotsUsed: 0,
		},
		Talia: {
			name: "Talia", race: "Human", class: "Cleric", level: 2, xp: 900, gold: 0,
			conditions: [], stats: { hp: 0, max_hp: 18 }, dead: true, spellSlotsUsed: 2,
		},
	},
	enemies: [
		{ name: "Bandit Captain", cr: 2, status: "alive", condition: "Injured" },
		{ name: "Wolf", cr: 0.25, status: "dead", condition: "Dead" },
	],
	campaignTone: { label: "Grimdark", emoji: "🗡" },
	campaignTheme: { label: "Haunted", emoji: "👻" },
	difficulty: "standard",
	brutalityLevel: 7,
	lootGenerosity: "fair",
	campaignSetting: "standard",
	startingLevel: 1,
	ttsProvider: "local",
	narratorVoiceName: "Gravel",
});

// ── selectTurn ────────────────────────────────────────────────────────────────

test("selectTurn resolves the active player by indexing the initiative array", () => {
	// Regression: the old panel read `state.initiative.current` on an array, so the
	// Turn card rendered "--" for the entire life of the feature.
	assert.equal(selectTurn(lobby()).current, "Bran");
});

test("selectTurn reports the round the server published", () => {
	// Regression: the old panel read `state.initiative.round`, which is always
	// undefined, so Round rendered 1 no matter how long the game had run.
	assert.equal(selectTurn(lobby()).round, 4);
});

test("selectTurn carries the whole order and the pointer into it", () => {
	const turn = selectTurn(lobby());
	assert.deepEqual(turn.order, ["Mira", "Bran", "Talia"]);
	assert.equal(turn.index, 1);
});

test("selectTurn handles the first and last positions in the order", () => {
	assert.equal(selectTurn({ ...lobby(), turnIndex: 0 }).current, "Mira");
	assert.equal(selectTurn({ ...lobby(), turnIndex: 2 }).current, "Talia");
});

test("selectTurn reports no active player when the order is empty", () => {
	const turn = selectTurn({ ...lobby(), initiative: [], turnIndex: 0 });
	assert.equal(turn.current, null);
	assert.deepEqual(turn.order, []);
	assert.equal(turn.index, -1);
});

test("selectTurn reports no active player when the pointer is out of range", () => {
	// A corrupted turn order is one of the conditions the repair catalogue exists to
	// fix; the interface must render it rather than throw while showing it.
	assert.equal(selectTurn({ ...lobby(), turnIndex: 9 }).current, null);
	assert.equal(selectTurn({ ...lobby(), turnIndex: -1 }).current, null);
});

test("selectTurn defaults the round to 1 when the server omits it", () => {
	const { round, ...rest } = lobby();
	assert.equal(selectTurn(rest).round, 1);
});

test("selectTurn survives a disconnected panel", () => {
	assert.deepEqual(selectTurn(null), { current: null, round: 1, order: [], index: -1 });
	assert.deepEqual(selectTurn(undefined), { current: null, round: 1, order: [], index: -1 });
	assert.deepEqual(selectTurn({}), { current: null, round: 1, order: [], index: -1 });
});

// ── selectPlayers ─────────────────────────────────────────────────────────────

test("selectPlayers returns one row per character", () => {
	assert.deepEqual(selectPlayers(lobby()).map((p) => p.name), ["Mira", "Bran", "Talia"]);
});

test("selectPlayers reads the whole character sheet a row displays", () => {
	const [mira] = selectPlayers(lobby());
	assert.deepEqual(mira, {
		name: "Mira", race: "Elf", charClass: "Rogue", level: 3, xp: 1450, gold: 340,
		hp: 18, maxHp: 22, conditions: ["poisoned"], spellSlotsUsed: 1,
		dead: false, isCurrent: false, connected: true,
	});
});

test("selectPlayers marks whose turn it is", () => {
	const rows = selectPlayers(lobby());
	assert.deepEqual(rows.filter((p) => p.isCurrent).map((p) => p.name), ["Bran"]);
});

test("selectPlayers marks the dead and the disconnected", () => {
	const talia = selectPlayers(lobby()).find((p) => p.name === "Talia");
	assert.equal(talia.dead, true);
	assert.equal(talia.connected, false, "Talia is absent from the connected list");
});

test("selectPlayers falls back when hit points are stored flat rather than under stats", () => {
	const state = { ...lobby(), players: { Ghost: { name: "Ghost", hp: 5, max_hp: 9 } } };
	const [ghost] = selectPlayers(state);
	assert.equal(ghost.hp, 5);
	assert.equal(ghost.maxHp, 9);
});

test("selectPlayers substitutes defaults for a half-built character", () => {
	const state = { ...lobby(), players: { New: { name: "New" } } };
	const [row] = selectPlayers(state);
	assert.equal(row.level, 1);
	assert.equal(row.xp, 0);
	assert.equal(row.gold, 0);
	assert.equal(row.hp, 0);
	assert.equal(row.maxHp, 0);
	assert.deepEqual(row.conditions, []);
	assert.equal(row.race, null);
	assert.equal(row.charClass, null);
});

test("selectPlayers names a character from its map key when the record omits one", () => {
	const state = { ...lobby(), players: { Nameless: { level: 2 } } };
	assert.equal(selectPlayers(state)[0].name, "Nameless");
});

test("selectPlayers returns nothing for an empty or disconnected lobby", () => {
	assert.deepEqual(selectPlayers({ ...lobby(), players: {} }), []);
	assert.deepEqual(selectPlayers(null), []);
	assert.deepEqual(selectPlayers({}), []);
});

test("selectPlayers copies the conditions list rather than aliasing lobby state", () => {
	const state = lobby();
	selectPlayers(state)[0].conditions.push("on fire");
	assert.deepEqual(state.players.Mira.conditions, ["poisoned"]);
});

// ── selectVitals ──────────────────────────────────────────────────────────────

test("selectVitals summarises the lobby for the dashboard tiles", () => {
	const vitals = selectVitals(lobby());
	assert.equal(vitals.code, "X4K2");
	assert.equal(vitals.adventureName, "Ravenholm Keep");
	assert.equal(vitals.phase, "running");
	assert.equal(vitals.round, 4);
	assert.equal(vitals.turn, "Bran");
	assert.equal(vitals.alive, 2);
	assert.equal(vitals.dead, 1);
	assert.equal(vitals.total, 3);
	assert.equal(vitals.connectedCount, 2);
});

test("selectVitals renders the music mood as words rather than an identifier", () => {
	assert.equal(selectVitals(lobby()).music, "tense combat");
});

test("selectVitals reports silence when no mood is playing", () => {
	assert.equal(selectVitals({ ...lobby(), currentMusic: null }).music, "none");
});

test("selectVitals names the model the lobby runs on", () => {
	assert.equal(selectVitals(lobby()).model, "claude / claude-sonnet-4-6");
});

test("selectVitals reports an unconfigured model rather than printing undefined", () => {
	const vitals = selectVitals({ ...lobby(), llmProvider: null, llmModel: null });
	assert.equal(vitals.model, "not set");
});

test("selectVitals describes the turn timer", () => {
	assert.equal(selectVitals(lobby()).timer, "5 min");
	assert.equal(selectVitals({ ...lobby(), timerEnabled: false }).timer, "off");
});

test("selectVitals survives a disconnected panel", () => {
	const vitals = selectVitals(null);
	assert.equal(vitals.total, 0);
	assert.equal(vitals.turn, null);
	assert.equal(vitals.phase, "disconnected");
});

// ── selectEnemies ─────────────────────────────────────────────────────────────

test("selectEnemies lists what the party is fighting", () => {
	const [captain] = selectEnemies(lobby());
	assert.deepEqual(captain, { name: "Bandit Captain", cr: 2, status: "alive", condition: "Injured", defeated: false });
});

test("selectEnemies marks the dead and the fled as defeated", () => {
	assert.equal(selectEnemies(lobby())[1].defeated, true);
	const fled = selectEnemies({ ...lobby(), enemies: [{ name: "Imp", status: "fled" }] });
	assert.equal(fled[0].defeated, true);
});

test("selectEnemies returns nothing when combat is not running", () => {
	assert.deepEqual(selectEnemies({ ...lobby(), enemies: [] }), []);
	assert.deepEqual(selectEnemies(null), []);
	assert.deepEqual(selectEnemies({}), []);
});

// ── selectCampaign ────────────────────────────────────────────────────────────

test("selectCampaign surfaces the settings the server publishes read-only", () => {
	const rows = selectCampaign(lobby());
	const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	assert.equal(byLabel.Tone, "🗡 Grimdark");
	assert.equal(byLabel.Theme, "👻 Haunted");
	assert.equal(byLabel.Difficulty, "standard");
	assert.equal(byLabel.Brutality, "7 / 10");
	assert.equal(byLabel.Narration, "local — Gravel");
});

test("selectCampaign prints a placeholder for settings that were never chosen", () => {
	const rows = selectCampaign({ ...lobby(), campaignTone: null, ttsProvider: null });
	const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	assert.equal(byLabel.Tone, "—");
	assert.equal(byLabel.Narration, "off");
});

test("selectCampaign keeps a brutality of zero rather than treating it as unset", () => {
	const rows = selectCampaign({ ...lobby(), brutalityLevel: 0 });
	assert.equal(Object.fromEntries(rows.map((r) => [r.label, r.value])).Brutality, "0 / 10");
});

test("selectCampaign returns nothing when disconnected", () => {
	assert.deepEqual(selectCampaign(null), []);
});

// ── selectLobbyCards ──────────────────────────────────────────────────────────

/** Lobbies shaped as `/api/lobbies` returns them. */
const lobbies = () => [
	{
		code: "X4K2", adventureName: "Ravenholm Keep", phase: "running", playerCount: 2,
		lastActivity: 1000, hasPassword: false,
		players: [
			{ name: "Mira", class: "Rogue", race: "Elf", level: 3, connected: true, isHost: true },
			{ name: "Bran", class: "Fighter", race: "Dwarf", level: 3, connected: false, isHost: false },
		],
	},
	{
		code: "Q7M1", adventureName: null, phase: "waiting", playerCount: 0,
		lastActivity: 5000, hasPassword: true, players: [],
	},
];

test("selectLobbyCards orders by most recent activity", () => {
	assert.deepEqual(selectLobbyCards(lobbies()).map((l) => l.code), ["Q7M1", "X4K2"]);
});

test("selectLobbyCards names the host and counts who is actually connected", () => {
	const ravenholm = selectLobbyCards(lobbies()).find((l) => l.code === "X4K2");
	assert.equal(ravenholm.hostName, "Mira");
	assert.equal(ravenholm.connectedCount, 1);
	assert.equal(ravenholm.playerCount, 2);
});

test("selectLobbyCards titles an unnamed adventure rather than showing null", () => {
	const untitled = selectLobbyCards(lobbies()).find((l) => l.code === "Q7M1");
	assert.equal(untitled.adventureName, "Untitled Adventure");
	assert.equal(untitled.hostName, null);
});

test("selectLobbyCards marks the lobby currently connected", () => {
	const cards = selectLobbyCards(lobbies(), "X4K2");
	assert.equal(cards.find((l) => l.code === "X4K2").isConnected, true);
	assert.equal(cards.find((l) => l.code === "Q7M1").isConnected, false);
});

test("selectLobbyCards carries the private flag through", () => {
	assert.equal(selectLobbyCards(lobbies()).find((l) => l.code === "Q7M1").hasPassword, true);
});

test("selectLobbyCards handles an empty or absent list", () => {
	assert.deepEqual(selectLobbyCards([]), []);
	assert.deepEqual(selectLobbyCards(null), []);
	assert.deepEqual(selectLobbyCards(undefined), []);
});

test("selectLobbyCards sorts lobbies with no recorded activity last", () => {
	const withUnknown = [...lobbies(), { code: "Z2P9", phase: "waiting", players: [], lastActivity: null }];
	assert.equal(selectLobbyCards(withUnknown).at(-1).code, "Z2P9");
});

test("selectLobbyCards does not reorder the caller's array", () => {
	const input = lobbies();
	selectLobbyCards(input);
	assert.equal(input[0].code, "X4K2");
});
