import { test } from "node:test";
import assert from "node:assert/strict";

import { lobbyReadiness, REQUIRED_CAPABILITIES } from "./readiness.js";

/**
 * @description Builds a player-facing capability view.
 * @param {object} [byCapability] - Capability → provider rows.
 * @returns {object} The view.
 */
function view(byCapability = {}) {
	const out = {};
	for (const capability of ["chat", "speech", "image"]) {
		const providers = byCapability[capability] ?? [];
		out[capability] = { providers, anyUsableWithoutPlayerKey: providers.some((p) => p.ready) };
	}
	return out;
}

/**
 * @description Builds one provider row as `publicCapabilities` emits it.
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} The row.
 */
function provider(overrides = {}) {
	return {
		id: "openai", label: "OpenAI", needsPlayerKey: false, requiresApiKey: true,
		requiresBaseUrl: false, keyUrl: null, sharedModels: null, reachable: null, ready: true,
		...overrides,
	};
}

/** A session describing a host who has supplied a key for one capability. */
const withHostKey = (capability, providerId = "openai") => ({
	[capability]: { configured: true, providerId, last4: "aB12", used: 0, maxCalls: null, expiresAt: null },
});

// ── What blocks a game, and what does not ────────────────────────────────────

test("only the story service is required to start a game", () => {
	assert.deepEqual(REQUIRED_CAPABILITIES, ["chat"]);
});

test("a lobby whose story service is served by the instance is ready", () => {
	const result = lobbyReadiness({ capabilities: view({ chat: [provider()] }) });
	assert.equal(result.ready, true);
	assert.deepEqual(result.blocking, []);
});

test("a lobby with no usable story service is not ready, and says which service", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
	});

	assert.equal(result.ready, false);
	assert.equal(result.blocking.length, 1);
	assert.equal(result.blocking[0].capability, "chat");
});

test("missing narration never blocks a game", () => {
	const result = lobbyReadiness({
		capabilities: view({
			chat: [provider()],
			speech: [provider({ id: "elevenlabs", ready: false, needsPlayerKey: true })],
		}),
	});

	assert.equal(result.ready, true, "a game should be playable without narration");
});

test("missing portraits never blocks a game", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider()], image: [provider({ ready: false, needsPlayerKey: true })] }),
	});
	assert.equal(result.ready, true);
});

test("a lobby with nothing configured at all is blocked only on story", () => {
	const result = lobbyReadiness({ capabilities: view({}) });
	assert.equal(result.ready, false);
	assert.deepEqual(result.blocking.map((b) => b.capability), ["chat"]);
});

// ── A host's own key satisfies the requirement ───────────────────────────────

test("a host who supplied a story key makes the lobby ready", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
		session: withHostKey("chat"),
	});

	assert.equal(result.ready, true);
	assert.deepEqual(result.blocking, []);
});

test("a host key for a provider that is not offered does not count", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ id: "anthropic", ready: false, needsPlayerKey: true })] }),
		session: withHostKey("chat", "openai"),
	});

	assert.equal(result.ready, false, "a key for a withdrawn provider should not satisfy the requirement");
});

test("a host key that has expired does not count", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
		session: { chat: { configured: false, providerId: "openai", used: 3, maxCalls: null } },
	});

	assert.equal(result.ready, false);
});

test("a host key satisfying story still leaves narration reported as needing one", () => {
	const result = lobbyReadiness({
		capabilities: view({
			chat: [provider({ ready: false, needsPlayerKey: true })],
			speech: [provider({ id: "elevenlabs", ready: false, needsPlayerKey: true })],
		}),
		session: withHostKey("chat"),
	});

	const speech = result.services.find((s) => s.capability === "speech");
	assert.equal(speech.state, "needs-key");
	assert.equal(result.ready, true);
});

// ── How each service reports itself ──────────────────────────────────────────

test("a service the instance pays for reports as provided by the server", () => {
	const result = lobbyReadiness({ capabilities: view({ chat: [provider()] }) });
	const chat = result.services.find((s) => s.capability === "chat");

	assert.equal(chat.state, "server");
	assert.equal(chat.providerId, "openai");
});

test("a reachable local service reports as local rather than as the server paying", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ id: "ollama", requiresApiKey: false, reachable: true })] }),
	});

	assert.equal(result.services.find((s) => s.capability === "chat").state, "local");
});

test("an unreachable local service with no alternative is unavailable, not asking for a key", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ id: "ollama", requiresApiKey: false, reachable: false, ready: false })] }),
	});

	assert.equal(result.ready, false);
	// No key would fix somebody else's Ollama being down, so offering a key field
	// would be busywork dressed as a solution.
	const chat = result.services.find((s) => s.capability === "chat");
	assert.equal(chat.state, "unavailable");
	assert.equal(chat.actionable, false);
});

test("an unreachable local service still asks for a key when a paid alternative exists", () => {
	const result = lobbyReadiness({
		capabilities: view({
			chat: [
				provider({ id: "ollama", requiresApiKey: false, reachable: false, ready: false }),
				provider({ id: "openai", ready: false, needsPlayerKey: true }),
			],
		}),
	});

	assert.equal(result.services.find((s) => s.capability === "chat").state, "needs-key");
});

test("a service satisfied by the host's own key says so", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
		session: withHostKey("chat"),
	});

	assert.equal(result.services.find((s) => s.capability === "chat").state, "own-key");
});

test("a service with nothing offered at all reports as unavailable, not as needing a key", () => {
	const result = lobbyReadiness({ capabilities: view({ speech: [] }), });
	const speech = result.services.find((s) => s.capability === "speech");

	assert.equal(speech.state, "unavailable");
	// Nothing the player can do about it, so it must not present as an action.
	assert.equal(speech.actionable, false);
});

test("a service needing a key is marked actionable, so the UI knows to open it", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
	});

	assert.equal(result.services.find((s) => s.capability === "chat").actionable, true);
});

test("every capability is reported, in a stable order, whether or not it is configured", () => {
	const result = lobbyReadiness({ capabilities: view({ chat: [provider()] }) });
	assert.deepEqual(result.services.map((s) => s.capability), ["chat", "speech", "image"]);
});

test("a server-provided service is not actionable, because there is nothing to do", () => {
	const result = lobbyReadiness({ capabilities: view({ chat: [provider()] }) });
	assert.equal(result.services.find((s) => s.capability === "chat").actionable, false);
});

// ── The providers a player may choose between ────────────────────────────────

test("a service needing a key lists the providers that would accept one", () => {
	const result = lobbyReadiness({
		capabilities: view({
			chat: [
				provider({ id: "openai", ready: false, needsPlayerKey: true, keyUrl: "https://openai" }),
				provider({ id: "anthropic", ready: false, needsPlayerKey: true, keyUrl: "https://anthropic" }),
			],
		}),
	});

	const chat = result.services.find((s) => s.capability === "chat");
	assert.deepEqual(chat.options.map((o) => o.id), ["openai", "anthropic"]);
	assert.equal(chat.options[0].keyUrl, "https://openai");
});

test("a ready service still lists what it is using, for display", () => {
	const result = lobbyReadiness({ capabilities: view({ chat: [provider({ label: "OpenAI" })] }) });
	assert.equal(result.services.find((s) => s.capability === "chat").providerLabel, "OpenAI");
});

// ── Messages ─────────────────────────────────────────────────────────────────

test("the blocking message names the service and what to do", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
	});

	assert.match(result.blocking[0].message, /key/i);
	assert.match(result.blocking[0].message, /stor(y|ies)|dungeon master|ai/i);
});

test("a blocked lobby with nothing offered explains that rather than asking for a key", () => {
	const result = lobbyReadiness({ capabilities: view({}) });
	assert.match(result.blocking[0].message, /not available|no .*provider|unavailable/i);
});

// ── Boundary ─────────────────────────────────────────────────────────────────

test("an absent capability view is treated as nothing being available", () => {
	for (const value of [null, undefined, {}]) {
		const result = lobbyReadiness({ capabilities: value });
		assert.equal(result.ready, false);
		assert.equal(result.services.length, 3);
	}
});

test("an absent session is the same as a host having supplied nothing", () => {
	const withNothing = lobbyReadiness({ capabilities: view({ chat: [provider()] }) });
	const withNull = lobbyReadiness({ capabilities: view({ chat: [provider()] }), session: null });
	assert.deepEqual(withNull, withNothing);
});

test("readiness never carries key material", () => {
	const result = lobbyReadiness({
		capabilities: view({ chat: [provider({ ready: false, needsPlayerKey: true })] }),
		session: withHostKey("chat"),
	});

	// Asserting on values, not field names: the previous form matched the
	// `requiresApiKey` flag and so could never have caught a real leak.
	const values = [];
	JSON.stringify(result, (key, value) => { if (typeof value === "string") values.push(value); return value; });
	for (const value of values) {
		assert.ok(!/^sk-|test-token|DO-NOT-USE/.test(value), `readiness leaked a credential-shaped value: ${value}`);
	}
});
