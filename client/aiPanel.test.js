import { test } from "node:test";
import assert from "node:assert/strict";

import { panelRows, startGate, credentialSubmission, heldSummary, modelChoices } from "./aiPanel.js";

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

// ── The narrator's provider and model ───────────────────────────────────────

/**
 * @description An `ai:state` payload with a chat service in a given condition.
 * @param {object} chat - Fields for the chat service.
 * @returns {object} The payload.
 */
function withChat(chat) {
	return {
		ready: true,
		blocking: [],
		services: [{
			capability: "chat", label: "the Dungeon Master",
			state: "server", providerId: "anthropic", providerLabel: "Anthropic",
			message: "Provided by this server (Anthropic).",
			// `ready`, `requiresApiKey` and `needsPlayerKey` are carried per provider by the real
			// payload — verified against a live `ai:state`. The first version of this fixture omitted
			// `ready`, and that omission is exactly what let a bug through: the code read the
			// service-level `providerId` instead, which names the first provider that *could* serve
			// rather than the one with a key, and the tests could not tell the difference.
			options: [
				{ id: "openai", label: "OpenAI", requiresApiKey: true, needsPlayerKey: false, ready: true },
				{ id: "anthropic", label: "Anthropic", requiresApiKey: true, needsPlayerKey: false, ready: true },
			],
			...chat,
		}],
	};
}

const CATALOGUE = [
	{ id: "openai", label: "OpenAI", models: [{ id: "gpt-4o", label: "GPT-4o" }] },
	{ id: "anthropic", label: "Anthropic", models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }] },
];

test("the provider serving the narrator is marked as ready on the server's key", () => {
	// "Use the server's key if there is one" is the default a host should not have to arrange.
	const choices = modelChoices(withChat({}), { llmProvider: "anthropic", llmModel: "claude-sonnet-5" }, CATALOGUE);
	const anthropic = choices.providers.find((p) => p.id === "anthropic");
	assert.equal(anthropic.keySource, "server");
	assert.equal(anthropic.selectable, true);
});

test("a host's own key is reported as theirs, not the server's", () => {
	// Which provider the host supplied a key for comes from `held`, not from the service state:
	// "own-key" says *a* key was supplied, and `held.chat.providerId` says for which one.
	const state = withChat({ state: "own-key", providerId: "openai", providerLabel: "OpenAI" });
	state.held = { chat: { providerId: "openai" } };
	const choices = modelChoices(state, { llmProvider: "openai", llmModel: "gpt-4o" }, CATALOGUE);
	assert.equal(choices.providers.find((p) => p.id === "openai").keySource, "own");
	assert.equal(choices.providers.find((p) => p.id === "anthropic").keySource, "server",
		"and the server's own key is still reported as the server's");
});

test("a provider with no key anywhere is offered but flagged as needing one", () => {
	// Offered rather than hidden: the point of the panel is that a host can supply a key and use it.
	// Hiding the option would leave them unable to discover that possibility at all.
	const choices = modelChoices(withChat({
		options: [
			{ id: "anthropic", label: "Anthropic", requiresApiKey: true, needsPlayerKey: false, ready: true },
			{ id: "google", label: "Google", requiresApiKey: true, needsPlayerKey: true, ready: false },
		],
	}), { llmProvider: "anthropic", llmModel: "claude-sonnet-5" }, CATALOGUE);
	const google = choices.providers.find((p) => p.id === "google");
	assert.equal(google.keySource, "none");
	assert.equal(google.selectable, false);
	assert.match(google.note, /key/i);
});

test("a local provider needs no key and is selectable", () => {
	const choices = modelChoices(withChat({
		state: "local", providerId: "ollama", providerLabel: "Ollama",
		options: [{ id: "ollama", label: "Ollama", requiresApiKey: false, needsPlayerKey: false, ready: true }],
	}), { llmProvider: "ollama", llmModel: "llama3" }, CATALOGUE);
	const ollama = choices.providers.find((p) => p.id === "ollama");
	assert.equal(ollama.keySource, "local");
	assert.equal(ollama.selectable, true);
});

test("a provider needing no key but with nowhere to reach still reads as needing setup", () => {
	// Taken from a live payload: `openai-compatible` reports requiresApiKey false — it is whatever
	// endpoint the host points it at — yet ready false, because this server has no endpoint
	// configured. Answering "needs no key, go ahead" would offer a provider that cannot be reached.
	// This is the case that makes the order of the checks load-bearing rather than incidental.
	const choices = modelChoices(withChat({
		options: [
			{ id: "anthropic", label: "Anthropic", requiresApiKey: true, needsPlayerKey: false, ready: true },
			{ id: "openai-compatible", label: "Custom", requiresApiKey: false, needsPlayerKey: true, ready: false },
		],
	}), { llmProvider: "anthropic", llmModel: "claude-sonnet-5" }, CATALOGUE);

	const custom = choices.providers.find((p) => p.id === "openai-compatible");
	assert.equal(custom.keySource, "none", "readiness decides before the key requirement does");
	assert.equal(custom.selectable, false);
});

test("the provider in force appears even when the options list omits it", () => {
	// `options` only carries providers that take a key, so a local one satisfying the capability
	// would otherwise vanish from a picker that is supposed to show what is running.
	const choices = modelChoices(
		withChat({ state: "local", providerId: "ollama", providerLabel: "Ollama", options: [] }),
		{ llmProvider: "ollama", llmModel: "llama3" }, CATALOGUE);
	assert.ok(choices.providers.some((p) => p.id === "ollama"));
});

test("the current selection is reported so the panel can show what is running", () => {
	// The complaint that started this: a host could not see what model the game was using.
	const choices = modelChoices(withChat({}), { llmProvider: "anthropic", llmModel: "claude-opus-5" }, CATALOGUE);
	assert.equal(choices.current.providerId, "anthropic");
	assert.equal(choices.current.modelId, "claude-opus-5");
});

test("models come from the catalogue for the chosen provider", () => {
	const choices = modelChoices(withChat({}), { llmProvider: "anthropic", llmModel: "claude-sonnet-5" }, CATALOGUE);
	assert.deepEqual(choices.modelsFor("anthropic").map((m) => m.id), ["claude-sonnet-5"]);
	assert.deepEqual(choices.modelsFor("openai").map((m) => m.id), ["gpt-4o"]);
});

test("a model the lobby is running is offered even if the catalogue has never heard of it", () => {
	// Otherwise opening the panel and pressing Apply would silently downgrade a host who had set
	// something newer than the shipped list — which is how the list going stale becomes destructive
	// rather than merely unhelpful.
	const choices = modelChoices(withChat({}), { llmProvider: "anthropic", llmModel: "claude-opus-9" }, CATALOGUE);
	assert.ok(choices.modelsFor("anthropic").some((m) => m.id === "claude-opus-9"));
});

test("a provider with no catalogue entry still allows a model to be typed", () => {
	const choices = modelChoices(withChat({}), { llmProvider: "ollama", llmModel: "llama3" }, CATALOGUE);
	assert.equal(choices.freeTextFor("ollama"), true, "local model names cannot be enumerated");
	assert.equal(choices.freeTextFor("anthropic"), false);
});

test("a missing or malformed state yields an empty picker rather than throwing", () => {
	for (const bad of [null, undefined, {}, { services: "chat" }]) {
		const choices = modelChoices(bad, null, CATALOGUE);
		assert.deepEqual(choices.providers, []);
		assert.equal(choices.current.providerId, null);
	}
});

test("a capability other than chat is ignored", () => {
	// Speech and images have their own keys and their own rows; the narrator's model is not theirs.
	const state = { services: [{ capability: "speech", state: "server", providerId: "elevenlabs", options: [] }] };
	assert.deepEqual(modelChoices(state, null, CATALOGUE).providers, []);
});

test("a provider the server has a key for is selectable even when it is not the one in force", () => {
	// Found by running it. `ai:state`'s `providerId` names the *first* provider that could serve the
	// capability, not the one this lobby uses — `readiness.js` does `providers.find(p => p.ready)`.
	// Reading it as "the provider with a key" marked Anthropic as needing one on a server that plainly
	// had an Anthropic key and had been narrating with it all day, and disabled the Apply button for
	// the provider the game was actually running on. Worse than offering no picker at all.
	//
	// Each option carries its own `ready` flag. That is the authority.
	const state = withChat({
		providerId: "openai", state: "server",
		options: [
			{ id: "openai", label: "OpenAI", requiresApiKey: true, needsPlayerKey: false, ready: true },
			{ id: "anthropic", label: "Anthropic", requiresApiKey: true, needsPlayerKey: false, ready: true },
			{ id: "google", label: "Google", requiresApiKey: true, needsPlayerKey: true, ready: false },
		],
	});
	const choices = modelChoices(state, { llmProvider: "anthropic", llmModel: "claude-sonnet-5" }, CATALOGUE);

	const anthropic = choices.providers.find((p) => p.id === "anthropic");
	assert.equal(anthropic.keySource, "server", "the server has a key for it");
	assert.equal(anthropic.selectable, true);

	const google = choices.providers.find((p) => p.id === "google");
	assert.equal(google.keySource, "none");
	assert.equal(google.selectable, false);
});

test("a provider needing no key at all is local rather than server-supplied", () => {
	const state = withChat({
		providerId: "ollama", state: "local",
		options: [{ id: "ollama", label: "Ollama", requiresApiKey: false, needsPlayerKey: false, ready: true }],
	});
	const choices = modelChoices(state, { llmProvider: "ollama", llmModel: "llama3" }, CATALOGUE);
	assert.equal(choices.providers.find((p) => p.id === "ollama").keySource, "local");
});

test("a provider the host holds a key for is reported as theirs", () => {
	// `held` is keyed by capability and names the provider the host supplied a key for.
	const state = withChat({
		providerId: "openai", state: "own-key",
		options: [
			{ id: "openai", label: "OpenAI", requiresApiKey: true, needsPlayerKey: false, ready: true },
			{ id: "google", label: "Google", requiresApiKey: true, needsPlayerKey: true, ready: true },
		],
	});
	state.held = { chat: { providerId: "google" } };
	const choices = modelChoices(state, { llmProvider: "google", llmModel: "gemini-1.5-pro" }, CATALOGUE);
	assert.equal(choices.providers.find((p) => p.id === "google").keySource, "own");
	assert.equal(choices.providers.find((p) => p.id === "openai").keySource, "server");
});
