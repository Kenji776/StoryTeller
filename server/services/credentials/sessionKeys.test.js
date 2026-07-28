import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionKeys } from "./sessionKeys.js";

/** Obviously-fake credentials. Nothing here may ever reach a real provider (TDD-14). */
const HOST_KEY = "test-token-DO-NOT-USE-host";
const OTHER_KEY = "test-token-DO-NOT-USE-other";

const LOBBY = "lobby-1";
const HOST_SID = "socket-host";

/** A fixed instant, so every expiry assertion is exact (`TDD-8`). */
const T0 = Date.UTC(2026, 6, 27, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Builds a clock the test drives by hand.
 *
 * @description Time is injected rather than read, so an expiry test asserts what
 *   the store does at a moment rather than sleeping until one arrives (`TDD-8`).
 * @param {number} [start=T0] - The opening instant, in epoch milliseconds.
 * @returns {{now: Function, advance: Function}} The clock and its control.
 */
function makeClock(start = T0) {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => { current += ms; },
	};
}

/**
 * Builds a normalized-looking AI configuration.
 *
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} A config shaped like `normalizeLLMConfig` output.
 */
function config(overrides = {}) {
	return { providerId: "anthropic", apiKey: HOST_KEY, model: "claude-sonnet-4-6", baseUrl: null, ...overrides };
}

/**
 * Builds a store plus the arguments a well-formed `put` needs.
 *
 * @param {object} [options] - Overrides for the clock and purge listener.
 * @returns {object} The store, its clock, and the purges it has reported.
 */
function makeStore({ clock = makeClock(), idleTtlMs } = {}) {
	const purges = [];
	const keys = createSessionKeys({
		now: clock.now,
		log: () => {},
		onPurge: (entry) => purges.push(entry),
		...(idleTtlMs === undefined ? {} : { idleTtlMs }),
	});
	return { keys, clock, purges };
}

/**
 * Supplies a host credential with every required field filled in.
 *
 * @param {object} keys - The store under test.
 * @param {object} [overrides] - Fields to replace on the put payload.
 * @returns {void}
 */
function supply(keys, overrides = {}) {
	keys.put(LOBBY, {
		capability: "chat",
		config: config(),
		ownerSid: HOST_SID,
		consent: true,
		maxCalls: null,
		expiresAt: null,
		...overrides,
	});
}

// ── Happy path ───────────────────────────────────────────────────────────────

test("a supplied host credential is handed back to the game loop", () => {
	const { keys } = makeStore();
	supply(keys);

	const taken = keys.take(LOBBY, "chat");
	assert.equal(taken.ok, true);
	assert.equal(taken.config.apiKey, HOST_KEY);
	assert.equal(taken.config.providerId, "anthropic");
});

test("capabilities are held independently for one lobby", () => {
	const { keys } = makeStore();
	supply(keys, { capability: "chat" });
	supply(keys, { capability: "image", config: config({ providerId: "openai", apiKey: OTHER_KEY }) });

	assert.equal(keys.take(LOBBY, "chat").config.apiKey, HOST_KEY);
	assert.equal(keys.take(LOBBY, "image").config.apiKey, OTHER_KEY);
});

test("lobbies do not see each other's credentials", () => {
	const { keys } = makeStore();
	supply(keys);
	assert.deepEqual(keys.take("lobby-2", "chat"), { ok: false, reason: "absent" });
});

test("re-supplying replaces the stored credential", () => {
	const { keys } = makeStore();
	supply(keys);
	supply(keys, { config: config({ apiKey: OTHER_KEY }) });

	assert.equal(keys.take(LOBBY, "chat").config.apiKey, OTHER_KEY);
});

test("describe reports what is held for a lobby", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 100 });

	const described = keys.describe(LOBBY);
	assert.equal(described.chat.providerId, "anthropic");
	assert.equal(described.chat.maxCalls, 100);
	assert.equal(described.chat.used, 0);
	assert.equal(described.chat.consentAt, new Date(T0).toISOString());
});

// ── Consent is not optional ──────────────────────────────────────────────────

test("a credential supplied without consent is refused", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { consent: undefined }), /consent/i);
});

test("a credential supplied with consent explicitly withheld is refused", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { consent: false }), /consent/i);
});

test("a truthy non-true consent value is not accepted as agreement", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { consent: "yes" }), /consent/i);
});

// ── Call limits ──────────────────────────────────────────────────────────────

test("a limited credential can be spent up to its limit", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 2 });

	assert.equal(keys.take(LOBBY, "chat").ok, true);
	assert.equal(keys.take(LOBBY, "chat").ok, true);
});

test("a credential spent past its limit reports exhaustion", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 1 });
	keys.take(LOBBY, "chat");

	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "exhausted" });
});

test("an unlimited credential never exhausts", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: null });

	for (let i = 0; i < 250; i += 1) assert.equal(keys.take(LOBBY, "chat").ok, true);
});

test("a failed take does not consume any of the budget", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 1 });
	keys.take(LOBBY, "chat");
	keys.take(LOBBY, "chat");
	keys.take(LOBBY, "chat");

	assert.equal(keys.describe(LOBBY).chat.used, 1);
});

test("an exhausted credential is kept so the host can raise the limit without re-entering it", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 1 });
	keys.take(LOBBY, "chat");

	assert.equal(keys.describe(LOBBY).chat.configured, true);
	supply(keys, { maxCalls: 5 });
	assert.equal(keys.take(LOBBY, "chat").ok, true);
});

test("the spend ledger survives a secret purge, so reconnecting cannot reset the budget", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 2 });
	keys.take(LOBBY, "chat");

	keys.dropSecrets(LOBBY, "host-disconnected");
	supply(keys, { maxCalls: 2 });

	assert.equal(keys.describe(LOBBY).chat.used, 1, "the ledger was reset by re-supplying the key");
	assert.equal(keys.take(LOBBY, "chat").ok, true);
	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "exhausted" });
});

test("forgetting a lobby clears the ledger as well as the secret", () => {
	const { keys } = makeStore();
	supply(keys, { maxCalls: 2 });
	keys.take(LOBBY, "chat");

	keys.forget(LOBBY, "game-ended");
	supply(keys, { maxCalls: 2 });

	assert.equal(keys.describe(LOBBY).chat.used, 0);
});

// ── Expiry ───────────────────────────────────────────────────────────────────

test("a credential taken before its expiry is served", () => {
	const { keys, clock } = makeStore();
	supply(keys, { expiresAt: T0 + HOUR });
	clock.advance(59 * MINUTE);

	assert.equal(keys.take(LOBBY, "chat").ok, true);
});

test("a credential taken after its expiry is refused", () => {
	const { keys, clock } = makeStore();
	supply(keys, { expiresAt: T0 + HOUR });
	clock.advance(HOUR + 1);

	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "expired" });
});

test("an expired credential is dropped by the sweep with nobody asking for it", () => {
	const { keys, clock, purges } = makeStore();
	supply(keys, { expiresAt: T0 + HOUR });

	clock.advance(HOUR + 1);
	const swept = keys.sweep();

	assert.deepEqual(swept, [{ lobbyId: LOBBY, capability: "chat", reason: "expired" }]);
	assert.equal(keys.describe(LOBBY).chat.configured, false);
	assert.equal(purges.at(-1).reason, "expired");
});

test("a sweep before the expiry drops nothing", () => {
	const { keys, clock } = makeStore();
	supply(keys, { expiresAt: T0 + HOUR });
	clock.advance(MINUTE);

	assert.deepEqual(keys.sweep(), []);
});

test("an expiry already in the past is refused rather than stored", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { expiresAt: T0 - 1 }), /expir/i);
});

test("an expiry that is not a date is refused", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { expiresAt: "next tuesday" }), /expir/i);
});

test("an expiry given as an ISO string is accepted", () => {
	const { keys, clock } = makeStore();
	supply(keys, { expiresAt: new Date(T0 + HOUR).toISOString() });

	clock.advance(HOUR + 1);
	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "expired" });
});

test("a fresh credential may be supplied after the previous one expired", () => {
	const { keys, clock } = makeStore();
	supply(keys, { expiresAt: T0 + HOUR });
	clock.advance(HOUR + 1);
	keys.sweep();

	supply(keys, { expiresAt: clock.now() + HOUR });
	assert.equal(keys.take(LOBBY, "chat").ok, true);
});

test("an expiry does not keep a credential alive past its host leaving", () => {
	const { keys } = makeStore();
	supply(keys, { expiresAt: T0 + 100 * HOUR });

	keys.dropSecretsBySocket(HOST_SID, "host-disconnected");
	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "absent" });
});

// ── Purge triggers ───────────────────────────────────────────────────────────

test("dropping secrets removes the credential", () => {
	const { keys } = makeStore();
	supply(keys);

	assert.equal(keys.dropSecrets(LOBBY, "host-disconnected"), true);
	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "absent" });
});

test("dropping secrets by socket clears only that host's lobbies", () => {
	const { keys } = makeStore();
	supply(keys);
	keys.put("lobby-2", {
		capability: "chat", config: config(), ownerSid: "socket-other", consent: true, maxCalls: null, expiresAt: null,
	});

	const dropped = keys.dropSecretsBySocket(HOST_SID, "host-disconnected");

	assert.deepEqual(dropped, [{ lobbyId: LOBBY, capability: "chat", reason: "host-disconnected" }]);
	assert.equal(keys.take("lobby-2", "chat").ok, true);
});

test("forgetting a lobby removes every capability it held", () => {
	const { keys } = makeStore();
	supply(keys, { capability: "chat" });
	supply(keys, { capability: "speech" });

	assert.equal(keys.forget(LOBBY, "lobby-deleted"), true);
	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "absent" });
	assert.deepEqual(keys.take(LOBBY, "speech"), { ok: false, reason: "absent" });
});

test("forgetting a lobby that holds nothing reports that nothing was removed", () => {
	const { keys } = makeStore();
	assert.equal(keys.forget(LOBBY, "lobby-deleted"), false);
});

test("a credential idle past the TTL is swept even with no expiry set", () => {
	const { keys, clock } = makeStore({ idleTtlMs: 2 * HOUR });
	supply(keys, { expiresAt: null });

	clock.advance(2 * HOUR + 1);
	assert.deepEqual(keys.sweep(), [{ lobbyId: LOBBY, capability: "chat", reason: "idle" }]);
});

test("using a credential postpones its idle sweep", () => {
	const { keys, clock } = makeStore({ idleTtlMs: 2 * HOUR });
	supply(keys);

	clock.advance(90 * MINUTE);
	keys.take(LOBBY, "chat");
	clock.advance(90 * MINUTE);

	assert.deepEqual(keys.sweep(), []);
});

test("every purge is reported to the listener with its reason", () => {
	const { keys, purges } = makeStore();
	supply(keys);
	keys.forget(LOBBY, "game-ended");

	assert.deepEqual(purges, [{ lobbyId: LOBBY, capability: "chat", reason: "game-ended" }]);
});

test("size counts the credentials currently held", () => {
	const { keys } = makeStore();
	assert.equal(keys.size(), 0);
	supply(keys, { capability: "chat" });
	supply(keys, { capability: "image" });
	assert.equal(keys.size(), 2);

	keys.dropSecrets(LOBBY, "host-disconnected");
	assert.equal(keys.size(), 0);
});

// ── Shared-key ledger ────────────────────────────────────────────────────────

test("shared use is counted per lobby, capability and provider", () => {
	const { keys } = makeStore();
	keys.countSharedUse(LOBBY, "chat", "openai");
	keys.countSharedUse(LOBBY, "chat", "openai");
	keys.countSharedUse(LOBBY, "chat", "anthropic");

	assert.equal(keys.sharedUse(LOBBY, "chat", "openai"), 2);
	assert.equal(keys.sharedUse(LOBBY, "chat", "anthropic"), 1);
	assert.equal(keys.sharedUse("lobby-2", "chat", "openai"), 0);
});

test("shared use survives a secret purge but not forgetting the lobby", () => {
	const { keys } = makeStore();
	keys.countSharedUse(LOBBY, "chat", "openai");

	keys.dropSecrets(LOBBY, "host-disconnected");
	assert.equal(keys.sharedUse(LOBBY, "chat", "openai"), 1);

	keys.forget(LOBBY, "game-ended");
	assert.equal(keys.sharedUse(LOBBY, "chat", "openai"), 0);
});

// ── Security properties ──────────────────────────────────────────────────────

test("describe never carries the key in any of its values", () => {
	const { keys } = makeStore();
	supply(keys);

	assert.ok(!JSON.stringify(keys.describe(LOBBY)).includes(HOST_KEY));
});

test("describe reports a lobby that holds nothing without inventing an entry", () => {
	const { keys } = makeStore();
	assert.equal(keys.describe("lobby-nobody"), null);
});

test("the config handed out is a copy, so a caller cannot mutate what is stored", () => {
	const { keys } = makeStore();
	supply(keys);

	keys.take(LOBBY, "chat").config.apiKey = "mutated";
	assert.equal(keys.take(LOBBY, "chat").config.apiKey, HOST_KEY);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("put rejects a missing lobby id", () => {
	const { keys } = makeStore();
	assert.throws(() => keys.put("", { capability: "chat", config: config(), ownerSid: HOST_SID, consent: true }), /lobby/i);
});

test("put rejects an unknown capability", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { capability: "telepathy" }), /capability/i);
});

test("put rejects a config that is not an object", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { config: HOST_KEY }), /config/i);
});

test("put rejects a config with no provider id", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { config: { apiKey: HOST_KEY } }), /provider/i);
});

test("put rejects a missing owner socket, without which no disconnect can clear it", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { ownerSid: null }), /owner|socket/i);
});

test("put rejects a fractional call limit", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { maxCalls: 2.5 }), /limit/i);
});

test("put rejects a zero call limit as an unusable credential", () => {
	const { keys } = makeStore();
	assert.throws(() => supply(keys, { maxCalls: 0 }), /limit/i);
});

test("take on a lobby that was never supplied reports absence", () => {
	const { keys } = makeStore();
	assert.deepEqual(keys.take(LOBBY, "chat"), { ok: false, reason: "absent" });
});

test("take for a capability that was never supplied reports absence", () => {
	const { keys } = makeStore();
	supply(keys, { capability: "chat" });
	assert.deepEqual(keys.take(LOBBY, "image"), { ok: false, reason: "absent" });
});
