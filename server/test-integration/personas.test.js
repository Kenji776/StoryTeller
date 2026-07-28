/**
 * Tests for the persona driver's view of a character.
 *
 * @description The fixture is produced by the *real* `publicState()` rather than
 *   hand-written, because a hand-written payload is exactly how the admin feed's
 *   dice renderer came to read three fields the server has never emitted: its test
 *   invented a matching payload, passed, and operators saw "dundefined" anyway. A
 *   persona that misreads the sheet fails more quietly still — it just plays badly,
 *   and the run looks like an engine problem.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LobbyStore } from "../services/lobbyStore.js";
import { viewFromState, systemPrompt, sentenceOnly, decideAction } from "./personas.mjs";

/**
 * @description Runs a lobby through the production `publicState` with no filesystem,
 *   by applying the prototype method to a bare context.
 * @param {object} lobby - The lobby record.
 * @returns {object} The published snapshot clients actually receive.
 */
function publish(lobby) {
	const ctx = { index: { lob1: lobby }, hostPlayerName: () => "Brannor Ironfoot" };
	return LobbyStore.prototype.publicState.call(ctx, "lob1");
}

/**
 * @description A lobby with one fully-equipped character and one wounded ally.
 * @param {object} [over] - Fields to override on the acting character.
 * @returns {object} The lobby record.
 */
function lobbyWith(over = {}) {
	return {
		lobbyId: "lob1", code: "ABC123", phase: "playing", sockets: {},
		storyContext: "", history: [], initiative: ["Brannor Ironfoot"], turnIndex: 0,
		abilitySlotsBase: 3,
		players: {
			"Brannor Ironfoot": {
				name: "Brannor Ironfoot", level: 1, spellSlotsUsed: 1,
				stats: { hp: 7, max_hp: 12 },
				abilities: [{ name: "Second Wind", description: "Catch your breath." }],
				inventory: [{ name: "Healing Potion", count: 2 }, { name: "Rope", count: 1 }],
				conditions: ["Bleeding"],
				...over,
			},
			"Sylvie Ashwren": {
				name: "Sylvie Ashwren", level: 1, stats: { hp: 3, max_hp: 9 }, conditions: ["Poisoned"],
			},
		},
		enemies: {
			g1: { name: "Goblin", hp: 4, max_hp: 8, status: "alive" },
			g2: { name: "Dead Goblin", hp: 0, max_hp: 8, status: "dead" },
		},
	};
}

test("a persona reads its abilities, items and conditions from the published sheet", () => {
	const view = viewFromState(publish(lobbyWith()), "Brannor Ironfoot");

	assert.deepEqual(view.abilities, ["Second Wind"]);
	assert.deepEqual(view.inventory, ["Healing Potion x2", "Rope"]);
	assert.equal(view.hp, 7);
	assert.equal(view.maxHp, 12);
	assert.deepEqual(view.conditions, ["Bleeding"]);
});

test("remaining ability uses match the server's own slot maths", () => {
	// base 3 at level 1 = capacity 3, one spent = 2 left. If this disagrees with
	// the gate, a persona spends a use it does not have and the rejection looks
	// like an engine bug rather than a harness one.
	const view = viewFromState(publish(lobbyWith()), "Brannor Ironfoot");
	assert.equal(view.uses, "2 of 3");
});

test("an unlimited pool is described as unlimited, never as a number", () => {
	const lobby = lobbyWith();
	lobby.abilitySlotsBase = "unlimited";
	const view = viewFromState(publish(lobby), "Brannor Ironfoot");
	assert.equal(view.uses, "unlimited");
});

test("a persona sees which companions are hurt but not itself in that list", () => {
	const view = viewFromState(publish(lobbyWith()), "Brannor Ironfoot");

	assert.equal(view.allies.length, 1);
	assert.match(view.allies[0], /Sylvie Ashwren/);
	assert.match(view.allies[0], /3\/9/);
	assert.match(view.allies[0], /Poisoned/);
});

test("dead enemies are not offered as targets", () => {
	const view = viewFromState(publish(lobbyWith()), "Brannor Ironfoot");

	assert.equal(view.enemies.length, 1);
	assert.match(view.enemies[0], /Goblin/);
	assert.ok(!view.enemies.some((e) => /Dead Goblin/.test(e)), view.enemies.join());
});

test("legacy string abilities and items are still readable", () => {
	const view = viewFromState(publish(lobbyWith({
		abilities: ["Old Ability"], inventory: ["Old Item"],
	})), "Brannor Ironfoot");

	assert.deepEqual(view.abilities, ["Old Ability"]);
	assert.deepEqual(view.inventory, ["Old Item"]);
});

test("a missing snapshot yields a blank view rather than throwing", () => {
	for (const bad of [null, undefined, {}, { players: {} }]) {
		const view = viewFromState(bad, "Brannor Ironfoot");
		assert.deepEqual(view.abilities, []);
		assert.equal(view.hp, null);
		assert.equal(view.uses, "unknown");
	}
});

test("a character absent from the snapshot yields a blank view", () => {
	const view = viewFromState(publish(lobbyWith()), "Nobody At All");
	assert.deepEqual(view.abilities, []);
	assert.equal(view.uses, "unknown");
});

test("the prompt never states a resource the character does not have", () => {
	const prompt = systemPrompt(
		{ name: "Brannor Ironfoot", spec: { race: "Dwarf", cls: "Fighter" } },
		viewFromState(publish(lobbyWith()), "Brannor Ironfoot"),
	);

	assert.match(prompt, /Second Wind/);
	assert.match(prompt, /Healing Potion x2/);
	assert.match(prompt, /2 of 3/);
	assert.ok(!prompt.includes("undefined"), prompt);
	assert.ok(!prompt.includes("null"), prompt);
});

test("a blank view still produces a usable prompt", () => {
	const prompt = systemPrompt({ name: "Nobody", spec: {} }, viewFromState(null, "Nobody"));
	assert.match(prompt, /abilities: none/);
	assert.match(prompt, /carrying: nothing/);
	assert.ok(!prompt.includes("undefined"), prompt);
});

test("a reply is reduced to one unquoted sentence", () => {
	assert.equal(sentenceOnly('"I swing at the goblin."'), "I swing at the goblin.");
	assert.equal(sentenceOnly("I swing.\nThen I explain myself at length."), "I swing.");
	assert.equal(sentenceOnly("  I wait.  "), "I wait.");
	assert.equal(sentenceOnly("I " + "x".repeat(500)).length, 220);
});

test("a failed persona call degrades to a neutral action instead of ending the run", async () => {
	const text = await decideAction({
		player: { name: "Brannor Ironfoot", short: "Brannor", spec: {} },
		story: [], state: null, apiKey: "test-token-DO-NOT-USE",
		fetchImpl: async () => ({ ok: false, status: 500 }),
	});

	assert.match(text, /^I /);
	assert.ok(text.length > 0);
});

test("an empty model reply degrades rather than submitting an empty action", async () => {
	const text = await decideAction({
		player: { name: "Brannor Ironfoot", short: "Brannor", spec: {} },
		story: [], state: null, apiKey: "test-token-DO-NOT-USE",
		fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "   " } }] }) }),
	});

	assert.match(text, /^I /);
});

test("the story sent to the model is the recent tail, oldest first", async () => {
	let sent = null;
	await decideAction({
		player: { name: "Brannor Ironfoot", short: "Brannor", spec: {} },
		story: Array.from({ length: 20 }, (_, i) => `beat ${i}`),
		state: null, apiKey: "test-token-DO-NOT-USE",
		fetchImpl: async (_url, opts) => {
			sent = JSON.parse(opts.body);
			return { ok: true, json: async () => ({ choices: [{ message: { content: "I act." } }] }) };
		},
	});

	const user = sent.messages.find((m) => m.role === "user").content;
	assert.ok(user.includes("beat 19"), "most recent beat must be present");
	assert.ok(user.includes("beat 14"), "the tail should span several beats");
	assert.ok(!user.includes("beat 0"), "ancient history should be dropped");
	assert.ok(user.indexOf("beat 14") < user.indexOf("beat 19"), "beats must read oldest first");
});
