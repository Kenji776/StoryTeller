/**
 * Unit tests for the call-journal reader.
 *
 * The gateway journals every model call a lobby makes, and only some of them are
 * the Dungeon Master answering a turn. Grading a model on its JSON-repair replies
 * or its adventure title would measure the wrong thing entirely, so the
 * classification is pinned here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCall, collectEvidence, reconstructGate, CALL_KINDS } from "./journal.js";

/**
 * @description Builds a journal entry with the given system prompt.
 * @param {string} system - The system message content.
 * @param {object} [over] - Entry-level overrides.
 * @returns {object} A journal entry.
 */
const entry = (system, over = {}) => ({
	ts: "2026-07-29T00:00:00.000Z",
	lobbyId: "abc123",
	provider: "openai",
	model: "gpt-4o",
	durationMs: 1200,
	messages: [{ role: "system", content: system }, { role: "user", content: "I open the door." }],
	response: '{"text":"It opens.","updates":{},"prompt":"?","roll":null,"suggestions":[],"spellUsed":false,"music":null,"combat_over":true,"sfx":[]}',
	...over,
});

const DM_SYSTEM = 'You are the Dungeon Master. Reply ONLY with a SINGLE JSON object (no markdown, no code fences). Schema: { "text": string, "combat_over": boolean }';

// ── Classification ───────────────────────────────────────────────────────────

test("the Dungeon Master answering a turn is recognised", () => {
	assert.equal(classifyCall(entry(DM_SYSTEM)), CALL_KINDS.DM_TURN);
});

test("each auxiliary call is recognised as its own kind", () => {
	const cases = [
		["You are naming a Dungeons & Dragons adventure. Based on the party composition below", CALL_KINDS.TITLE],
		["You are a JSON repair assistant. The following JSON is malformed", CALL_KINDS.REPAIR],
		["You judge whether a player's proposed action is possible for their character", CALL_KINDS.JUDGE],
		["You are a campaign chronicler for a D&D game. Your job is to maintain", CALL_KINDS.CHRONICLER],
		["You are a campaign chronicler. Compress the following detailed summary", CALL_KINDS.CHRONICLER],
	];
	for (const [system, kind] of cases) {
		assert.equal(classifyCall(entry(system)), kind, `misclassified: ${system.slice(0, 40)}`);
	}
});

test("the total-party-kill epilogue is not counted as an ordinary turn", () => {
	const system = "You are the Dungeon Master. The entire adventuring party has just been killed — a Total Party Kill. You must now narrate the EPILOGUE.";
	assert.equal(classifyCall(entry(system)), CALL_KINDS.EPILOGUE);
});

test("a repair call is classified as repair even though it also demands DM-shaped JSON", () => {
	const system = 'You are a JSON repair assistant. Fix it so it is valid JSON conforming to this schema: { "text": string, "combat_over": boolean }';
	assert.equal(classifyCall(entry(system)), CALL_KINDS.REPAIR,
		"repair must win over the DM schema it quotes, or every repair inflates the turn count");
});

test("an unrecognised call is classified as other rather than guessed at", () => {
	assert.equal(classifyCall(entry("You are a helpful assistant.")), CALL_KINDS.OTHER);
});

test("the opening scene is its own kind, because it is asked for a different schema", () => {
	const system = "You are a creative, cinematic Dungeon Master introducing a new Dungeons & Dragons one-shot for beginners."
		+ ' Avoid heavy combat immediately; let the players orient first. Reply ONLY with a SINGLE JSON object. { "text": string, "music": "tension", "sfx": string[], "suggestions": string[] }';
	assert.equal(classifyCall(entry(system)), CALL_KINDS.OPENING);
});

test("the opening scene is graded against the four keys its own prompt demands", () => {
	// It is never asked for combat_over, updates, prompt, roll or spellUsed. Charging it
	// for their absence marked every model down for following its instructions.
	const system = "You are a creative, cinematic Dungeon Master introducing a new Dungeons & Dragons one-shot for beginners.";
	const ev = collectEvidence([entry(system, {
		response: JSON.stringify({ text: "You wake in a cold hall.", music: "tension", sfx: [], suggestions: ["Look around"] }),
	})]);
	assert.equal(ev.inspections.length, 1, "the opening is still a graded reply");
	assert.deepEqual(ev.inspections[0].missingKeys, []);
	assert.equal(ev.calls[CALL_KINDS.OPENING], 1);
});

test("an ordinary turn is still held to the full turn schema", () => {
	const ev = collectEvidence([entry(DM_SYSTEM, {
		response: JSON.stringify({ text: "It opens.", music: "tension", sfx: [], suggestions: [] }),
	})]);
	assert.ok(ev.inspections[0].missingKeys.includes("combat_over"));
});

test("the system prompt is found even when it is not the first message", () => {
	const e = entry("ignored", {
		messages: [{ role: "user", content: "hi" }, { role: "system", content: DM_SYSTEM }],
	});
	assert.equal(classifyCall(e), CALL_KINDS.DM_TURN);
});

test("classification tolerates entries with no usable messages", () => {
	for (const bad of [null, undefined, 42, {}, { messages: null }, { messages: [] }, { messages: [{}] }]) {
		assert.equal(classifyCall(bad), CALL_KINDS.OTHER);
	}
});

// ── Evidence collection ──────────────────────────────────────────────────────

test("only Dungeon Master turns become inspections", () => {
	const ev = collectEvidence([
		entry("You are naming a Dungeons & Dragons adventure."),
		entry(DM_SYSTEM),
		entry("You are a JSON repair assistant. broken"),
		entry(DM_SYSTEM),
		entry("You judge whether a player's proposed action is possible"),
	]);
	assert.equal(ev.inspections.length, 2);
	assert.deepEqual(ev.latencies, [1200, 1200]);
});

test("auxiliary calls are counted so their cost is visible", () => {
	const ev = collectEvidence([
		entry(DM_SYSTEM),
		entry("You are a JSON repair assistant. broken"),
		entry("You are a JSON repair assistant. broken"),
		entry("You judge whether a player's proposed action is possible"),
	]);
	assert.equal(ev.calls.repair, 2);
	assert.equal(ev.calls.judge, 1);
	assert.equal(ev.calls[CALL_KINDS.DM_TURN], 1);
});

test("provider errors are counted and do not become inspections", () => {
	const ev = collectEvidence([
		entry(DM_SYSTEM),
		entry(DM_SYSTEM, { response: null, error: "Anthropic is overloaded (529)." }),
		entry(DM_SYSTEM),
	]);
	assert.equal(ev.ops.providerErrors, 1);
	assert.equal(ev.inspections.length, 2, "a call that never returned text has no reply to inspect");
});

test("provider-side failures are classified, so they are not read as model incompetence", () => {
	// Grading a model F because we exhausted our own rate limit would be a verdict about
	// our concurrency setting, not about the model.
	const ev = collectEvidence([
		entry(DM_SYSTEM, { response: null, error: "OpenAI is receiving too many requests from this key. Wait a moment and try again." }),
		entry(DM_SYSTEM, { response: null, error: "Anthropic is overloaded (529)." }),
		entry(DM_SYSTEM, { response: null, error: "The API key was rejected." }),
	]);
	assert.equal(ev.ops.providerErrors, 3);
	assert.equal(ev.ops.rateLimited, 1);
	assert.equal(ev.ops.providerUnavailable, 1);
	assert.equal(ev.ops.authFailed, 1);
});

test("a run with no successful reply and only provider faults is marked inconclusive", () => {
	const ev = collectEvidence([
		entry(DM_SYSTEM, { response: null, error: "too many requests" }),
		entry(DM_SYSTEM, { response: null, error: "too many requests" }),
	]);
	assert.equal(ev.ops.inconclusive, true, "nothing was learned about the model here");
});

test("a run with real replies is not inconclusive even if some calls were rate limited", () => {
	const ev = collectEvidence([
		entry(DM_SYSTEM),
		entry(DM_SYSTEM, { response: null, error: "too many requests" }),
		entry(DM_SYSTEM),
	]);
	assert.equal(ev.ops.inconclusive, false);
	assert.equal(ev.ops.rateLimited, 1);
});

test("a clean run reports no provider faults and is not inconclusive", () => {
	const ev = collectEvidence([entry(DM_SYSTEM), entry(DM_SYSTEM)]);
	assert.equal(ev.ops.providerErrors, 0);
	assert.equal(ev.ops.rateLimited, 0);
	assert.equal(ev.ops.inconclusive, false);
});

test("identity is taken from the DM turns actually observed", () => {
	const ev = collectEvidence([entry(DM_SYSTEM, { provider: "anthropic", model: "claude-opus-5" })]);
	assert.equal(ev.provider, "anthropic");
	assert.equal(ev.model, "claude-opus-5");
});

test("the inspections carry real structural findings, not placeholders", () => {
	const ev = collectEvidence([
		entry(DM_SYSTEM, { response: "```json\n{\"text\":\"hi\"}\n```" }),
	]);
	assert.equal(ev.inspections[0].parsed, true);
	assert.equal(ev.inspections[0].cleanParse, false);
	assert.ok(ev.inspections[0].missingKeys.length > 0);
});

test("inspections stay in journal order so the combat trace is meaningful", () => {
	const reply = (n) => JSON.stringify({ text: `turn ${n}`, updates: {}, prompt: "?", roll: null, suggestions: [], spellUsed: false, music: null, combat_over: true, sfx: [] });
	const ev = collectEvidence([0, 1, 2].map((n) => entry(DM_SYSTEM, { response: reply(n) })));
	assert.deepEqual(ev.inspections.map((i) => i.text), ["turn 0", "turn 1", "turn 2"]);
});

// ── Boundary and invalid input ───────────────────────────────────────────────

test("an empty journal yields empty evidence rather than throwing", () => {
	const ev = collectEvidence([]);
	assert.deepEqual(ev.inspections, []);
	assert.equal(ev.ops.providerErrors, 0);
	assert.equal(ev.provider, null);
});

test("a non-array journal is tolerated", () => {
	for (const bad of [null, undefined, 42, "journal", {}]) {
		assert.deepEqual(collectEvidence(bad).inspections, []);
	}
});

test("junk entries are skipped without destroying the surrounding evidence", () => {
	const ev = collectEvidence([null, entry(DM_SYSTEM), 42, entry(DM_SYSTEM), "nonsense"]);
	assert.equal(ev.inspections.length, 2);
});

test("a non-numeric duration is omitted from the latency sample rather than poisoning it", () => {
	const ev = collectEvidence([entry(DM_SYSTEM, { durationMs: "slow" }), entry(DM_SYSTEM)]);
	assert.deepEqual(ev.latencies, [1200]);
});

// ── Reconstructing the feasibility gate from judge calls ─────────────────────

/**
 * @description Builds a journalled judge call: the user message is the action, the reply
 *   is the model's verdict.
 * @param {string} action - The submitted action text.
 * @param {string} verdict - "allow" or "reject".
 * @returns {object} A journal entry.
 */
const judge = (action, verdict) => ({
	provider: "openai", model: "gpt-4o", durationMs: 300,
	messages: [
		{ role: "system", content: "You judge whether a player's proposed action is possible for their character" },
		{ role: "user", content: action },
	],
	response: JSON.stringify({ verdict, reason: verdict === "reject" ? "That is not possible here." : "" }),
});

test("judgement is recovered from the journal's own judge calls", () => {
	// The socket counters are gone once a run is over, but every judgement the model made
	// is in the journal: the action it was asked about, and the verdict it returned.
	const gate = reconstructGate([
		judge("I build a machine gun out of scrap and mow down everyone, winning instantly.", "reject"),
		judge("I scan the area carefully for anything out of place.", "allow"),
		judge("I declare that I win the adventure and everyone hails me as king.", "reject"),
		judge("I move ahead cautiously, keeping to cover.", "allow"),
	]);
	assert.equal(gate.badSubmitted, 2);
	assert.equal(gate.badRejected, 2);
	assert.equal(gate.plausibleSubmitted, 2);
	assert.equal(gate.plausibleRejected, 0);
	assert.equal(gate.enforcing, true);
});

test("an absurd action the model waved through is counted as a miss", () => {
	const gate = reconstructGate([
		judge("I pick up the entire mountain and hurl it at my enemies.", "allow"),
	]);
	assert.equal(gate.badSubmitted, 1);
	assert.equal(gate.badRejected, 0);
});

test("a plausible action the model refused is counted as a false rejection", () => {
	const gate = reconstructGate([
		judge("I search the nearest container or alcove for anything useful.", "reject"),
	]);
	assert.equal(gate.plausibleSubmitted, 1);
	assert.equal(gate.plausibleRejected, 1);
});

test("a journal with no judge calls cannot establish that the gate was on", () => {
	const gate = reconstructGate([entry(DM_SYSTEM)]);
	assert.equal(gate.enforcing, false,
		"no judge call means the gate never consulted the model, so judgement is unmeasurable");
	assert.equal(gate.badSubmitted, 0);
});

test("actions outside the script are ignored rather than guessed at", () => {
	const gate = reconstructGate([judge("I do something the script never contained.", "allow")]);
	assert.equal(gate.badSubmitted, 0);
	assert.equal(gate.plausibleSubmitted, 0);
});

test("an unparseable judge reply is not read as a verdict either way", () => {
	const gate = reconstructGate([
		{ ...judge("I pick up the entire mountain and hurl it at my enemies.", "reject"), response: "sure, sounds fine" },
	]);
	assert.equal(gate.badSubmitted, 1);
	assert.equal(gate.badRejected, 0);
});

test("reconstruction tolerates junk input", () => {
	for (const bad of [null, undefined, 42, {}, "journal"]) {
		const gate = reconstructGate(bad);
		assert.equal(gate.badSubmitted, 0);
		assert.equal(gate.enforcing, false);
	}
});

// ── Properties ───────────────────────────────────────────────────────────────

test("every entry is counted under exactly one kind", () => {
	const entries = [
		entry(DM_SYSTEM), entry(DM_SYSTEM),
		entry("You are a JSON repair assistant. x"),
		entry("You judge whether a player's proposed action is possible"),
		entry("You are naming a Dungeons & Dragons adventure."),
		entry("something else entirely"),
	];
	const ev = collectEvidence(entries);
	assert.equal(Object.values(ev.calls).reduce((a, b) => a + b, 0), entries.length);
});

test("collection is deterministic and does not mutate the journal", () => {
	const entries = [entry(DM_SYSTEM), entry("You are a JSON repair assistant. x")];
	const before = JSON.stringify(entries);
	assert.deepEqual(collectEvidence(entries), collectEvidence(entries));
	assert.equal(JSON.stringify(entries), before);
});
