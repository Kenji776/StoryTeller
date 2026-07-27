import { test } from "node:test";
import assert from "node:assert/strict";

import { createActionGate } from "./actionGate.js";
import { turnAttemptMethods, MAX_ACTION_ATTEMPTS } from "./lobby/turnAttempts.js";

/**
 * Builds a gate wired to fakes, plus handles for asserting what it did.
 *
 * @description Every collaborator is injected: the socket, the timer functions and
 *   the model call. That keeps the orchestration unit-testable with no server, no
 *   sockets and no network (`TDD-8`), and it is why the timer behaviour on rejection
 *   — the part that previously froze lobbies — can be asserted at all.
 * @param {object} [opts] - Overrides.
 * @param {string} [opts.mode] - Gate mode.
 * @param {string} [opts.llmReply] - Canned judge reply.
 * @param {object} [opts.player] - Player fields merged over the baseline.
 * @returns {object} The gate and its recorded effects.
 */
function makeGate(opts = {}) {
	const emitted = [];
	const resumed = [];
	const skipped = [];

	const store = {
		index: {
			lob1: {
				lobbyId: "lob1",
				initiative: ["Ayla"],
				turnIndex: 0,
				players: {
					Ayla: {
						name: "Ayla",
						class: "Wizard",
						level: 3,
						spellSlotsUsed: 0,
						dead: false,
						stats: { hp: 18, max_hp: 24 },
						abilities: [{ name: "Magic Missile", description: "darts" }],
						inventory: [],
						conditions: [],
						...opts.player,
					},
				},
			},
		},
		persist() {},
		...turnAttemptMethods,
	};

	const socket = { emit: (event, payload) => emitted.push({ event, payload }) };

	const gate = createActionGate({
		store,
		log: () => {},
		mode: opts.mode ?? "judge",
		getLLMResponse: async () => opts.llmReply ?? '{"verdict":"allow"}',
		llmOpts: () => ({}),
		resumeTurnTimer: (id) => resumed.push(id),
		skipTurn: (id, name, reason) => skipped.push({ id, name, reason }),
	});

	return { gate, store, socket, emitted, resumed, skipped };
}

/** @description Convenience wrapper for the common call shape. */
const check = (h, text) => h.gate.check({ lobbyId: "lob1", socket: h.socket, playerName: "Ayla", text });

// ── Allowing ─────────────────────────────────────────────────────────────────

test("a plausible action is allowed", async () => {
	const h = makeGate();
	assert.equal((await check(h, "I search the crates.")).allow, true);
});

test("an allowed action emits nothing to the player", async () => {
	const h = makeGate();
	await check(h, "I search the crates.");
	assert.deepEqual(h.emitted, []);
});

test("an allowed action does not touch the turn timer", async () => {
	const h = makeGate();
	await check(h, "I search the crates.");
	assert.deepEqual(h.resumed, []);
});

// ── Rejecting ────────────────────────────────────────────────────────────────

test("an impossible action is refused", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	assert.equal((await check(h, "I cast Magic Missile.")).allow, false);
});

test("a rejection is sent only to the player who submitted it", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	assert.equal(h.emitted.length, 1);
	assert.equal(h.emitted[0].event, "action:rejected");
});

test("a rejection tells the player how many chances remain", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	const p = h.emitted[0].payload;
	assert.equal(p.strikes, 1);
	assert.equal(p.maxStrikes, MAX_ACTION_ATTEMPTS);
	assert.equal(p.retry, true);
});

test("a rejection carries the machine-readable code", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	assert.equal(h.emitted[0].payload.code, "no_slots");
});

test("a rejection resumes the turn timer, so the turn clock is not lost", async () => {
	// action:submit cancels the timer before validating. Every early return therefore
	// has to put it back, or the lobby waits forever for a player whose clock is dead.
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	assert.deepEqual(h.resumed, ["lob1"]);
});

test("a rejection does not skip the turn while chances remain", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	assert.deepEqual(h.skipped, []);
});

// ── Strikes that should not be charged ───────────────────────────────────────

test("an empty submission does not cost a chance", async () => {
	const h = makeGate();
	await check(h, "   ");
	assert.equal(h.store.attemptsUsed("lob1", "Ayla"), 0);
});

test("being dead does not cost a chance", async () => {
	const h = makeGate({ player: { dead: true } });
	await check(h, "I stand up and fight on.");
	assert.equal(h.store.attemptsUsed("lob1", "Ayla"), 0);
});

test("a rejection that costs no chance still resumes the timer", async () => {
	const h = makeGate();
	await check(h, "");
	assert.deepEqual(h.resumed, ["lob1"]);
});

// ── Running out of chances ───────────────────────────────────────────────────

test("the third impossible action skips the turn", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	for (let i = 0; i < MAX_ACTION_ATTEMPTS; i++) await check(h, "I cast Magic Missile.");
	assert.equal(h.skipped.length, 1);
	assert.equal(h.skipped[0].name, "Ayla");
});

test("the skip names the reason so the table understands why", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	for (let i = 0; i < MAX_ACTION_ATTEMPTS; i++) await check(h, "I cast Magic Missile.");
	assert.match(h.skipped[0].reason, /three|3/i);
});

test("a skipped turn does not also resume the timer", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	for (let i = 0; i < MAX_ACTION_ATTEMPTS; i++) await check(h, "I cast Magic Missile.");
	// Two resumes for the first two rejections; the third skips instead.
	assert.equal(h.resumed.length, MAX_ACTION_ATTEMPTS - 1);
});

test("the final rejection tells the player they are out of chances", async () => {
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	for (let i = 0; i < MAX_ACTION_ATTEMPTS; i++) await check(h, "I cast Magic Missile.");
	assert.equal(h.emitted.at(-1).payload.retry, false);
});

// ── Modes ────────────────────────────────────────────────────────────────────

test("observe mode allows everything while still forming a verdict", async () => {
	const h = makeGate({ mode: "observe", player: { level: 1, spellSlotsUsed: 1 } });
	const r = await check(h, "I cast Magic Missile.");
	assert.equal(r.allow, true);
	assert.equal(r.wouldReject, true);
});

test("observe mode charges no strikes", async () => {
	const h = makeGate({ mode: "observe", player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	assert.equal(h.store.attemptsUsed("lob1", "Ayla"), 0);
});

test("observe mode says nothing to the player", async () => {
	const h = makeGate({ mode: "observe", player: { level: 1, spellSlotsUsed: 1 } });
	await check(h, "I cast Magic Missile.");
	assert.deepEqual(h.emitted, []);
});

test("off mode does not even consult the model", async () => {
	let called = false;
	const h = makeGate({ mode: "off" });
	h.gate.check;
	const gate = createActionGate({
		store: h.store, log: () => {}, mode: "off",
		getLLMResponse: async () => { called = true; return '{"verdict":"reject"}'; },
		llmOpts: () => ({}), resumeTurnTimer: () => {}, skipTurn: () => {},
	});
	const r = await gate.check({ lobbyId: "lob1", socket: h.socket, playerName: "Ayla", text: "I do anything." });
	assert.equal(r.allow, true);
	assert.equal(called, false);
});

test("hard mode enforces code checks but never calls the model", async () => {
	let called = false;
	const h = makeGate({ player: { level: 1, spellSlotsUsed: 1 } });
	const gate = createActionGate({
		store: h.store, log: () => {}, mode: "hard",
		getLLMResponse: async () => { called = true; return '{"verdict":"allow"}'; },
		llmOpts: () => ({}), resumeTurnTimer: () => {}, skipTurn: () => {},
	});
	const r = await gate.check({ lobbyId: "lob1", socket: h.socket, playerName: "Ayla", text: "I search the room." });
	assert.equal(r.allow, true);
	assert.equal(called, false, "hard mode must not spend a model call");
});

// ── The judge ────────────────────────────────────────────────────────────────

test("an action the judge rejects is refused and costs a chance", async () => {
	const h = makeGate({ llmReply: '{"verdict":"reject","reason":"Firearms do not exist here."}' });
	const r = await check(h, "I build a machine gun.");
	assert.equal(r.allow, false);
	assert.equal(h.store.attemptsUsed("lob1", "Ayla"), 1);
});

test("the judge's reason is what the player is shown", async () => {
	const h = makeGate({ llmReply: '{"verdict":"reject","reason":"Firearms do not exist here."}' });
	await check(h, "I build a machine gun.");
	assert.match(h.emitted[0].payload.reason, /Firearms/);
});

test("an unavailable judge lets the action through", async () => {
	const h = makeGate();
	const gate = createActionGate({
		store: h.store, log: () => {}, mode: "judge",
		getLLMResponse: async () => { throw new Error("provider down"); },
		llmOpts: () => ({}), resumeTurnTimer: () => {}, skipTurn: () => {},
	});
	const r = await gate.check({ lobbyId: "lob1", socket: h.socket, playerName: "Ayla", text: "I search." });
	assert.equal(r.allow, true);
});

test("table talk is allowed without a model call", async () => {
	let called = false;
	const h = makeGate();
	const gate = createActionGate({
		store: h.store, log: () => {}, mode: "judge",
		getLLMResponse: async () => { called = true; return '{"verdict":"reject"}'; },
		llmOpts: () => ({}), resumeTurnTimer: () => {}, skipTurn: () => {},
	});
	const r = await gate.check({ lobbyId: "lob1", socket: h.socket, playerName: "Ayla", text: "ooc what is a saving throw" });
	assert.equal(r.allow, true);
	assert.equal(called, false);
});

test("a roll report is allowed without a model call", async () => {
	let called = false;
	const h = makeGate();
	const gate = createActionGate({
		store: h.store, log: () => {}, mode: "judge",
		getLLMResponse: async () => { called = true; return '{"verdict":"reject"}'; },
		llmOpts: () => ({}), resumeTurnTimer: () => {}, skipTurn: () => {},
	});
	const r = await gate.check({ lobbyId: "lob1", socket: h.socket, playerName: "Ayla", text: "[ROLL] Ayla rolls 14 [/ROLL]" });
	assert.equal(r.allow, true);
	assert.equal(called, false);
});

// ── Robustness ───────────────────────────────────────────────────────────────

test("an unknown lobby is refused without throwing", async () => {
	const h = makeGate();
	const r = await h.gate.check({ lobbyId: "nope", socket: h.socket, playerName: "Ayla", text: "I act." });
	assert.equal(r.allow, false);
});

test("a successful action clears any strikes the player had accrued", async () => {
	const h = makeGate();
	h.store.recordRejectedAttempt("lob1", "Ayla");
	await check(h, "I search the crates.");
	assert.equal(h.store.attemptsUsed("lob1", "Ayla"), 0);
});
