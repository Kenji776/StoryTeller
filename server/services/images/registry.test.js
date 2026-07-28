import { test } from "node:test";
import assert from "node:assert/strict";

import { getImageProvider, listImageProviders, IMAGE_PROVIDERS } from "./registry.js";

// ── Resolution ───────────────────────────────────────────────────────────────

test("a registered provider resolves by id", () => {
	assert.equal(getImageProvider("local-image").id, "local-image");
	assert.equal(getImageProvider("openai").id, "openai");
});

test("ids are matched after trimming and case-folding, since they come from stored config", () => {
	assert.equal(getImageProvider("  OpenAI  ").id, "openai");
	assert.equal(getImageProvider("LOCAL-IMAGE").id, "local-image");
});

test("an unknown id resolves to nothing rather than throwing", () => {
	assert.equal(getImageProvider("midjourney"), null);
});

test("a non-string id resolves to nothing", () => {
	for (const value of [null, undefined, 42, {}, []]) {
		assert.equal(getImageProvider(value), null);
	}
});

// ── Listing ──────────────────────────────────────────────────────────────────

test("every registered provider is listed", () => {
	const ids = listImageProviders().map((p) => p.id);
	assert.ok(ids.includes("local-image"));
	assert.ok(ids.includes("openai"));
});

test("listing returns plain serialisable descriptors with no functions", () => {
	for (const provider of listImageProviders()) {
		for (const [key, value] of Object.entries(provider)) {
			assert.notEqual(typeof value, "function", `${provider.id}.${key} is a function and cannot be sent to a browser`);
		}
	}
});

test("listing carries what the policy layer and the UI need to decide", () => {
	const local = listImageProviders().find((p) => p.id === "local-image");

	assert.equal(local.isLocal, true);
	assert.equal(local.requiresBaseUrl, true);
	assert.equal(local.requiresApiKey, true);
	assert.ok(Array.isArray(local.styles));
});

test("listing hands back fresh objects a caller cannot use to mutate the registry", () => {
	listImageProviders()[0].label = "mutated";
	assert.notEqual(listImageProviders()[0].label, "mutated");
});

// ── The contract every adapter owes ──────────────────────────────────────────

test("the registry actually holds providers, so the contract tests cannot pass vacuously", () => {
	assert.ok(IMAGE_PROVIDERS.length >= 2, "a contract test over an empty registry proves nothing (TDD-7)");
});

test("every provider implements the whole adapter contract", () => {
	assert.ok(IMAGE_PROVIDERS.length > 0);
	for (const provider of IMAGE_PROVIDERS) {
		for (const method of ["generate", "probe", "listModels"]) {
			assert.equal(typeof provider[method], "function", `${provider.id} is missing ${method}`);
		}
		for (const field of ["id", "label"]) {
			assert.equal(typeof provider[field], "string", `${provider.id} is missing ${field}`);
		}
		for (const flag of ["requiresApiKey", "requiresBaseUrl", "isLocal"]) {
			assert.equal(typeof provider[flag], "boolean", `${provider.id} is missing ${flag}`);
		}
	}
});

test("provider ids are unique", () => {
	const ids = IMAGE_PROVIDERS.map((p) => p.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("a provider needing no key declares no place to obtain one", () => {
	assert.ok(IMAGE_PROVIDERS.length > 0);
	for (const provider of IMAGE_PROVIDERS) {
		if (!provider.requiresApiKey) assert.equal(provider.keyUrl, null, `${provider.id} offers a key URL but needs no key`);
	}
});

test("a hosted provider needing a key says where to get one", () => {
	// Only hosted ones. A self-hosted service can require a token and still have
	// no page to send anyone to — the operator issued it themselves — so demanding
	// a URL there would be demanding a link that cannot exist.
	assert.ok(IMAGE_PROVIDERS.length > 0);
	for (const provider of IMAGE_PROVIDERS) {
		if (provider.requiresApiKey && !provider.isLocal) {
			assert.match(provider.keyUrl ?? "", /^https:\/\//, `${provider.id} needs a key but says nothing about where to get one`);
		}
	}
});

test("a self-hosted provider needing a token is allowed to have no key URL", () => {
	const local = IMAGE_PROVIDERS.find((p) => p.isLocal && p.requiresApiKey);
	assert.ok(local, "expected a self-hosted provider that takes a token");
	assert.equal(local.keyUrl, null);
});
