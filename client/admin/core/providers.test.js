import { test } from "node:test";
import assert from "node:assert/strict";

import { providerRows, policyOptions, keyStatusLabel, readinessLabel, policyPayload } from "./providers.js";

/** A provider needing an account. */
const HOSTED = { id: "openai", label: "OpenAI", requiresApiKey: true, requiresBaseUrl: false, isLocal: false };

/** A self-hosted service: an address, no account. */
const LOCAL = { id: "ollama", label: "Ollama", requiresApiKey: false, requiresBaseUrl: true, isLocal: true };

/** A gateway that could be either — self-hosted, or a paid hosted endpoint. */
const GATEWAY = { id: "openai-compatible", label: "Custom gateway", requiresApiKey: false, requiresBaseUrl: true, isLocal: false };

/**
 * @description Builds an `/api/admin/providers` response body.
 * @param {object} [byCapability] - Capability → provider rows.
 * @returns {object} The capabilities payload.
 */
function payload(byCapability = {}) {
	const out = {};
	for (const capability of ["chat", "speech", "image"]) {
		out[capability] = { providers: byCapability[capability] ?? [], anyUsableWithoutPlayerKey: false };
	}
	return out;
}

// ── Flattening the response for rendering ────────────────────────────────────

test("every capability's providers become rows tagged with their capability", () => {
	const rows = providerRows(payload({
		chat: [{ ...HOSTED, policy: "shared", key: { configured: true } }],
		image: [{ ...LOCAL, id: "local-image", policy: "local", key: { configured: false } }],
	}));

	assert.equal(rows.length, 2);
	assert.equal(rows[0].capability, "chat");
	assert.equal(rows[1].capability, "image");
});

test("rows keep the order each capability listed them in", () => {
	const rows = providerRows(payload({ chat: [HOSTED, LOCAL, GATEWAY] }));
	assert.deepEqual(rows.map((r) => r.id), ["openai", "ollama", "openai-compatible"]);
});

test("capabilities are emitted in a stable order regardless of object key order", () => {
	const rows = providerRows({
		image: { providers: [LOCAL] },
		chat: { providers: [HOSTED] },
		speech: { providers: [GATEWAY] },
	});
	assert.deepEqual(rows.map((r) => r.capability), ["chat", "speech", "image"]);
});

test("a row carries a key unique across capabilities, since one provider serves several", () => {
	const rows = providerRows(payload({
		chat: [{ ...HOSTED, policy: "shared" }],
		image: [{ ...HOSTED, policy: "byok" }],
	}));

	assert.notEqual(rows[0].rowKey, rows[1].rowKey);
	assert.equal(new Set(rows.map((r) => r.rowKey)).size, 2);
});

test("an absent or malformed payload produces no rows rather than throwing", () => {
	for (const value of [null, undefined, {}, "nonsense", 42]) {
		assert.deepEqual(providerRows(value), []);
	}
});

test("a capability with no providers contributes nothing", () => {
	assert.deepEqual(providerRows(payload({ chat: [] })), []);
});

// ── Which policies a provider can actually take ──────────────────────────────

test("a self-hosted provider can only be local or off", () => {
	assert.deepEqual(policyOptions(LOCAL), ["local", "off"]);
});

test("a provider needing an account cannot be offered as a local service", () => {
	assert.deepEqual(policyOptions(HOSTED), ["shared", "byok", "off"]);
});

test("a gateway can be any of them, because it might be self-hosted or paid", () => {
	assert.deepEqual(policyOptions(GATEWAY), ["local", "shared", "byok", "off"]);
});

test("off is always available, so a provider can always be withdrawn", () => {
	for (const provider of [HOSTED, LOCAL, GATEWAY]) {
		assert.ok(policyOptions(provider).includes("off"), `${provider.id} cannot be switched off`);
	}
});

test("an unrecognised provider shape offers only off rather than guessing", () => {
	assert.deepEqual(policyOptions({}), ["shared", "byok", "off"]);
	assert.deepEqual(policyOptions(null), ["off"]);
});

// ── How a key's state reads ──────────────────────────────────────────────────

test("a provider with no key says so plainly", () => {
	assert.match(keyStatusLabel({ configured: false }), /no key|not set/i);
});

test("a stored key is identified by its tail, never in full", () => {
	const label = keyStatusLabel({ configured: true, last4: "a1B2", status: "unknown" });
	assert.match(label, /a1B2/);
});

test("a key that tested successfully says so", () => {
	assert.match(keyStatusLabel({ configured: true, last4: "a1B2", status: "ok" }), /work|valid|ok/i);
});

test("a key the provider rejected says so", () => {
	assert.match(keyStatusLabel({ configured: true, last4: "a1B2", status: "rejected" }), /reject|invalid|fail/i);
});

test("a key too short to show a tail still reports as configured", () => {
	const label = keyStatusLabel({ configured: true, last4: null, status: "unknown" });
	assert.match(label, /set|configured/i);
	assert.doesNotMatch(label, /null/);
});

test("an absent key record is treated as no key", () => {
	assert.match(keyStatusLabel(undefined), /no key|not set/i);
});

// ── How readiness reads ──────────────────────────────────────────────────────

test("a provider that needs nothing from the player says it is ready", () => {
	assert.match(readinessLabel({ policy: "shared", ready: true, reachable: null }), /ready|available/i);
});

test("a bring-your-own provider says the player supplies the key", () => {
	assert.match(readinessLabel({ policy: "byok", ready: false, reachable: null }), /player|their own|bring/i);
});

test("a switched-off provider says it is not offered", () => {
	assert.match(readinessLabel({ policy: "off", ready: false, reachable: null }), /not offered|off/i);
});

test("a local provider known to be unreachable says so rather than claiming readiness", () => {
	assert.match(readinessLabel({ policy: "local", ready: false, reachable: false }), /unreachable|not answering|offline/i);
});

test("a local provider not yet probed does not claim to be broken", () => {
	const label = readinessLabel({ policy: "local", ready: true, reachable: null });
	assert.doesNotMatch(label, /unreachable|offline/i);
});

test("a shared provider with no key explains that the key is missing", () => {
	assert.match(readinessLabel({ policy: "shared", ready: false, reachable: null }), /key/i);
});

// ── Building the request body ────────────────────────────────────────────────

test("a shared policy carries its allowlist and cap", () => {
	assert.deepEqual(
		policyPayload({ policy: "shared", sharedModels: "gpt-4o-mini, gpt-4o", maxCallsPerLobby: "200" }),
		{ policy: "shared", sharedModels: ["gpt-4o-mini", "gpt-4o"], maxCallsPerLobby: 200, baseUrl: null },
	);
});

test("a blank allowlist means no restriction rather than an empty one", () => {
	assert.equal(policyPayload({ policy: "shared", sharedModels: "   " }).sharedModels, null);
});

test("a blank cap means unlimited", () => {
	assert.equal(policyPayload({ policy: "shared", maxCallsPerLobby: "" }).maxCallsPerLobby, null);
});

test("a cap is sent as a number, because the server refuses a string", () => {
	assert.equal(typeof policyPayload({ policy: "shared", maxCallsPerLobby: "50" }).maxCallsPerLobby, "number");
});

test("an allowlist is split on commas and trimmed, and blanks are dropped", () => {
	assert.deepEqual(
		policyPayload({ policy: "shared", sharedModels: " gpt-4o ,, gpt-4o-mini ," }).sharedModels,
		["gpt-4o", "gpt-4o-mini"],
	);
});

test("a local policy carries its address", () => {
	assert.equal(policyPayload({ policy: "local", baseUrl: " http://192.168.1.20:11434 " }).baseUrl, "http://192.168.1.20:11434");
});

test("a non-shared policy sends no allowlist or cap, which the server would drop anyway", () => {
	const body = policyPayload({ policy: "byok", sharedModels: "gpt-4o", maxCallsPerLobby: "10" });
	assert.equal(body.sharedModels, null);
	assert.equal(body.maxCallsPerLobby, null);
});

test("a non-local policy sends no address", () => {
	assert.equal(policyPayload({ policy: "shared", baseUrl: "http://192.168.1.20:11434" }).baseUrl, null);
});

test("a cap that is not a number is sent as null rather than NaN", () => {
	assert.equal(policyPayload({ policy: "shared", maxCallsPerLobby: "many" }).maxCallsPerLobby, null);
});
