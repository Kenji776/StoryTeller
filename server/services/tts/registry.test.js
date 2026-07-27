import { test } from "node:test";
import assert from "node:assert/strict";

import {
	TTS_PROVIDERS,
	resolveTTSProvider,
	pickDefaultProviderId,
	normalizeProviderId,
	probeAvailability,
} from "./registry.js";

const BOTH = { local: true, elevenlabs: true };
const NEITHER = { local: false, elevenlabs: false };

// ===== the registry itself =====

test("the registry lists both shipped providers", () => {
	assert.deepEqual(TTS_PROVIDERS.map((p) => p.id).sort(), ["elevenlabs", "local"]);
});

test("every registered provider satisfies the adapter contract", () => {
	// A provider missing a method fails at narration time, in front of players.
	// Checking the shape here turns that into a failing test instead.
	for (const p of TTS_PROVIDERS) {
		assert.equal(typeof p.id, "string", `${p.id} must declare an id`);
		assert.equal(typeof p.label, "string", `${p.id} must declare a label`);
		assert.ok(["mpeg", "wav"].includes(p.audioFormat), `${p.id} declares unknown format ${p.audioFormat}`);
		for (const method of ["isAvailable", "listVoices", "synthesize", "preview"]) {
			assert.equal(typeof p[method], "function", `${p.id} must implement ${method}`);
		}
	}
});

// ===== resolveTTSProvider =====

test("resolveTTSProvider returns the adapter for a known id", () => {
	assert.equal(resolveTTSProvider("local").id, "local");
	assert.equal(resolveTTSProvider("elevenlabs").id, "elevenlabs");
});

test("resolveTTSProvider returns null for an unknown id", () => {
	assert.equal(resolveTTSProvider("festival"), null);
});

test("resolveTTSProvider returns null rather than throwing on junk input", () => {
	// This id arrives from persisted lobby state and from the browser, so it is
	// untrusted by definition.
	assert.equal(resolveTTSProvider(null), null);
	assert.equal(resolveTTSProvider(undefined), null);
	assert.equal(resolveTTSProvider(""), null);
	assert.equal(resolveTTSProvider(42), null);
	assert.equal(resolveTTSProvider({}), null);
});

// ===== pickDefaultProviderId =====

test("pickDefaultProviderId prefers the local server when it is up", () => {
	assert.equal(pickDefaultProviderId(BOTH), "local");
});

test("pickDefaultProviderId falls back to ElevenLabs when local is down", () => {
	assert.equal(pickDefaultProviderId({ local: false, elevenlabs: true }), "elevenlabs");
});

test("pickDefaultProviderId chooses local when it is the only one up", () => {
	assert.equal(pickDefaultProviderId({ local: true, elevenlabs: false }), "local");
});

test("pickDefaultProviderId returns null when nothing can speak", () => {
	assert.equal(pickDefaultProviderId(NEITHER), null);
});

test("pickDefaultProviderId treats a missing availability map as nothing available", () => {
	assert.equal(pickDefaultProviderId({}), null);
	assert.equal(pickDefaultProviderId(undefined), null);
});

// ===== normalizeProviderId =====

test("normalizeProviderId keeps a valid, available choice", () => {
	assert.equal(normalizeProviderId("elevenlabs", BOTH), "elevenlabs");
});

test("normalizeProviderId replaces a choice whose provider is no longer up", () => {
	// A lobby persisted before the local server was switched off must still narrate.
	assert.equal(normalizeProviderId("local", { local: false, elevenlabs: true }), "elevenlabs");
});

test("normalizeProviderId replaces an unknown id with the default", () => {
	assert.equal(normalizeProviderId("festival", BOTH), "local");
});

test("normalizeProviderId supplies the default when no choice was ever made", () => {
	assert.equal(normalizeProviderId(null, BOTH), "local");
	assert.equal(normalizeProviderId(undefined, BOTH), "local");
});

test("normalizeProviderId returns null when nothing is available to fall back to", () => {
	assert.equal(normalizeProviderId("local", NEITHER), null);
	assert.equal(normalizeProviderId("elevenlabs", NEITHER), null);
});

// ===== probeAvailability =====

test("probeAvailability reports each provider's own verdict", async () => {
	const answers = { local: true, elevenlabs: false };
	const result = await probeAvailability({
		providers: TTS_PROVIDERS.map((p) => ({ ...p, isAvailable: async () => answers[p.id] })),
		depsFor: () => ({}),
	});
	assert.deepEqual(result, { local: true, elevenlabs: false });
});

test("probeAvailability hands each provider its own dependency bundle", async () => {
	const seen = {};
	await probeAvailability({
		providers: TTS_PROVIDERS.map((p) => ({ ...p, isAvailable: async (d) => { seen[p.id] = d; return true; } })),
		depsFor: (id) => ({ who: id }),
	});
	assert.deepEqual(seen, { local: { who: "local" }, elevenlabs: { who: "elevenlabs" } });
});

test("probeAvailability records false for a provider that throws", async () => {
	// isAvailable is documented not to throw, but a boot probe must survive one that does.
	const result = await probeAvailability({
		providers: [
			{ id: "local", isAvailable: async () => { throw new Error("boom"); } },
			{ id: "elevenlabs", isAvailable: async () => true },
		],
		depsFor: () => ({}),
	});
	assert.deepEqual(result, { local: false, elevenlabs: true });
});

test("probeAvailability coerces a non-boolean verdict", async () => {
	const result = await probeAvailability({
		providers: [{ id: "local", isAvailable: async () => "yes" }],
		depsFor: () => ({}),
	});
	assert.equal(result.local, true);
});

test("probeAvailability returns an empty map for no providers", async () => {
	assert.deepEqual(await probeAvailability({ providers: [], depsFor: () => ({}) }), {});
});
