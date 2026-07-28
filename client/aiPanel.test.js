import { test } from "node:test";
import assert from "node:assert/strict";

import { panelRows, startGate, credentialSubmission, heldSummary } from "./aiPanel.js";

/**
 * @description Builds one service as `lobbyReadiness` reports it.
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} The service.
 */
function service(overrides = {}) {
	return {
		capability: "chat", label: "the Dungeon Master", state: "server", actionable: false,
		providerId: "openai", providerLabel: "OpenAI", options: [], message: "Provided by this server (OpenAI).",
		...overrides,
	};
}

/**
 * @description Builds an `ai:state` payload.
 * @param {Array<object>} services - The services.
 * @param {object} [extra] - `blocking` and `held` overrides.
 * @returns {object} The payload.
 */
function state(services, extra = {}) {
	const blocking = extra.blocking ?? [];
	return { ready: blocking.length === 0, services, blocking, held: extra.held ?? null };
}

// ── Turning the server's verdict into rows ───────────────────────────────────

test("a service the server pays for renders as done, with nothing to fill in", () => {
	const [row] = panelRows(state([service()]));

	assert.equal(row.tone, "ok");
	assert.equal(row.needsInput, false);
	assert.match(row.title, /dungeon master/i);
});

test("a local service renders as free rather than as the server paying", () => {
	const [row] = panelRows(state([service({ state: "local", providerLabel: "Ollama", message: "Running on Ollama — free, on this network." })]));

	assert.equal(row.tone, "ok");
	assert.equal(row.needsInput, false);
	assert.match(row.detail, /free/i);
});

test("a service needing a key renders as an action with the providers to choose from", () => {
	const [row] = panelRows(state([service({
		state: "needs-key", actionable: true, providerId: null,
		options: [{ id: "openai", label: "OpenAI", keyUrl: "https://openai" }],
	})], { blocking: [{ capability: "chat", message: "Add an API key." }] }));

	assert.equal(row.needsInput, true);
	assert.equal(row.tone, "warn");
	assert.deepEqual(row.options.map((o) => o.id), ["openai"]);
});

test("a service running on the host's own key says so and can still be changed", () => {
	const [row] = panelRows(state([service({ state: "own-key", providerLabel: "Anthropic" })], {
		held: { chat: { configured: true, providerId: "anthropic", last4: "aB12", used: 4, maxCalls: 100, expiresAt: null } },
	}));

	assert.equal(row.tone, "ok");
	assert.match(row.detail, /aB12/);
	assert.equal(row.canWithdraw, true);
});

test("an unavailable service is shown but offers nothing to do about it", () => {
	const [row] = panelRows(state([service({ state: "unavailable", actionable: false, providerId: null, options: [] })]));

	assert.equal(row.needsInput, false);
	assert.equal(row.tone, "muted");
	assert.equal(row.canWithdraw, false);
});

test("only a service the game cannot run without is marked as blocking", () => {
	const rows = panelRows(state(
		[
			service({ capability: "chat", state: "needs-key", actionable: true }),
			service({ capability: "speech", state: "needs-key", actionable: true }),
		],
		{ blocking: [{ capability: "chat", message: "Add an API key." }] },
	));

	assert.equal(rows.find((r) => r.capability === "chat").blocking, true);
	assert.equal(rows.find((r) => r.capability === "speech").blocking, false);
});

test("an optional service needing a key reads as optional, not as a problem", () => {
	const rows = panelRows(state([service({ capability: "speech", state: "needs-key", actionable: true })]));
	assert.match(rows[0].detail, /optional/i);
});

test("every service keeps a stable, human order", () => {
	const rows = panelRows(state([
		service({ capability: "image" }), service({ capability: "chat" }), service({ capability: "speech" }),
	]));
	assert.deepEqual(rows.map((r) => r.capability), ["chat", "speech", "image"]);
});

test("an absent state renders nothing rather than throwing", () => {
	for (const value of [null, undefined, {}]) assert.deepEqual(panelRows(value), []);
});

// ── The Start button ─────────────────────────────────────────────────────────

test("a ready lobby may start", () => {
	assert.deepEqual(startGate(state([service()])), { canStart: true, reason: "" });
});

test("a blocked lobby may not start, and the reason is the server's own words", () => {
	const gate = startGate(state([service({ state: "needs-key" })], {
		blocking: [{ capability: "chat", message: "Add an API key for the Dungeon Master before starting the game." }],
	}));

	assert.equal(gate.canStart, false);
	assert.equal(gate.reason, "Add an API key for the Dungeon Master before starting the game.");
});

test("an unknown state does not enable the button", () => {
	// Before the first ai:state arrives there is no verdict, and defaulting to
	// enabled would let someone start a game the server then refuses.
	for (const value of [null, undefined, {}]) assert.equal(startGate(value).canStart, false);
});

test("the reason names only the first blocker, so the button's tooltip stays readable", () => {
	const gate = startGate(state([], { blocking: [{ message: "first" }, { message: "second" }] }));
	assert.equal(gate.reason, "first");
});

// ── Building a submission ────────────────────────────────────────────────────

test("a filled form becomes a submission the server accepts", () => {
	assert.deepEqual(
		credentialSubmission({
			lobbyId: "L1", capability: "chat", providerId: "openai",
			apiKey: "  test-token-DO-NOT-USE  ", consent: true,
		}),
		{ lobbyId: "L1", capability: "chat", providerId: "openai", apiKey: "test-token-DO-NOT-USE", baseUrl: null, consent: true, maxCalls: null, expiresAt: null },
	);
});

test("a call limit is sent as a number, because the server refuses a string", () => {
	const body = credentialSubmission({ lobbyId: "L1", capability: "chat", providerId: "openai", apiKey: "k", consent: true, maxCalls: "250" });
	assert.equal(body.maxCalls, 250);
});

test("a blank limit means unlimited", () => {
	for (const value of ["", "   ", null, undefined]) {
		assert.equal(credentialSubmission({ apiKey: "k", consent: true, maxCalls: value }).maxCalls, null);
	}
});

test("a limit that is not a number is sent as unlimited rather than NaN", () => {
	assert.equal(credentialSubmission({ apiKey: "k", consent: true, maxCalls: "lots" }).maxCalls, null);
});

test("an expiry date becomes an ISO instant at the end of that day", () => {
	// A date input gives a day, and a host choosing "the 5th" means the key should
	// last through the 5th rather than expiring as it begins.
	const body = credentialSubmission({ apiKey: "k", consent: true, expiresAt: "2026-08-05" });

	assert.match(body.expiresAt, /^2026-08-05T23:59/);
});

test("a blank expiry means no expiry", () => {
	for (const value of ["", null, undefined]) {
		assert.equal(credentialSubmission({ apiKey: "k", consent: true, expiresAt: value }).expiresAt, null);
	}
});

test("an already-instant expiry is passed through unchanged", () => {
	const iso = "2026-08-05T12:00:00.000Z";
	assert.equal(credentialSubmission({ apiKey: "k", consent: true, expiresAt: iso }).expiresAt, iso);
});

test("consent is passed through exactly, never coerced to true", () => {
	assert.equal(credentialSubmission({ apiKey: "k", consent: "yes" }).consent, false);
	assert.equal(credentialSubmission({ apiKey: "k" }).consent, false);
	assert.equal(credentialSubmission({ apiKey: "k", consent: true }).consent, true);
});

test("a base URL is trimmed and blank means none", () => {
	assert.equal(credentialSubmission({ apiKey: "k", consent: true, baseUrl: "  http://x  " }).baseUrl, "http://x");
	assert.equal(credentialSubmission({ apiKey: "k", consent: true, baseUrl: "   " }).baseUrl, null);
});

// ── Describing what is held ──────────────────────────────────────────────────

test("a held key is summarised by its tail and its usage", () => {
	const text = heldSummary({ configured: true, providerId: "openai", last4: "aB12", used: 12, maxCalls: 100, expiresAt: null });

	assert.match(text, /aB12/);
	assert.match(text, /12/);
	assert.match(text, /100/);
});

test("an unlimited key does not invent a limit to display", () => {
	const text = heldSummary({ configured: true, last4: "aB12", used: 3, maxCalls: null, expiresAt: null });

	assert.match(text, /unlimited|no limit/i);
	assert.doesNotMatch(text, /null/);
});

test("an expiry is shown as a date a person can read", () => {
	const text = heldSummary({ configured: true, last4: "aB12", used: 0, maxCalls: null, expiresAt: "2026-08-05T23:59:59.000Z" });
	assert.match(text, /2026/);
});

test("a key that has been dropped says so rather than showing stale usage", () => {
	const text = heldSummary({ configured: false, providerId: "openai", last4: "aB12", used: 9, maxCalls: 10, expiresAt: null });
	assert.match(text, /no longer|removed|expired|not set/i);
});

test("nothing held summarises to nothing", () => {
	assert.equal(heldSummary(null), "");
	assert.equal(heldSummary(undefined), "");
});

test("no summary ever contains a full key", () => {
	const text = heldSummary({ configured: true, providerId: "openai", last4: "aB12", used: 1, maxCalls: null, expiresAt: null });
	assert.ok(!/sk-|test-token/.test(text));
});
