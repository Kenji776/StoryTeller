import { test } from "node:test";
import assert from "node:assert/strict";

import { localImageProvider, normalizeImageSize } from "./localImageServer.js";
import { LLMRequestError } from "../../llm/errors.js";

/** An RFC1918 fixture address. The real one is deployment config, never source (STY-3). */
const BASE_URL = "http://192.168.1.50:8189";
const config = { providerId: "local-image", apiKey: null, model: null, baseUrl: BASE_URL };

/** A one-pixel PNG, so a fixture never carries anything that looks like real image data. */
const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

/**
 * Builds a fetch double that records its calls and replays a scripted response.
 *
 * @param {object} [options] - How the fake server should answer.
 * @param {number} [options.status=200] - HTTP status to return.
 * @param {object|string} [options.body] - Response body; objects are serialised.
 * @param {Error} [options.throws] - Transport failure to raise instead of answering.
 * @returns {Function} A fetch-shaped function carrying a `calls` array.
 */
function makeFetch({ status = 200, body = { images: [FAKE_PNG_B64], seed: 8412, model: "krea2" }, throws } = {}) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
		if (throws) throw throws;
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return { ok: status >= 200 && status < 300, status, text: async () => text };
	};
	impl.calls = calls;
	return impl;
}

/**
 * Generates through the adapter with test defaults filled in.
 *
 * @param {Function} fetchImpl - The fetch double.
 * @param {object} [overrides] - Request fields to replace.
 * @returns {Promise<object>} The adapter's result.
 */
function generate(fetchImpl, overrides = {}) {
	return localImageProvider.generate({ prompt: "a dwarven paladin", config, fetchImpl, ...overrides });
}

// ── normalizeImageSize ───────────────────────────────────────────────────────

test("a size with both dimensions on the 16-pixel grid is accepted", () => {
	assert.deepEqual(normalizeImageSize({ width: 896, height: 1152 }), { width: 896, height: 1152 });
});

test("an absent size falls back to a portrait aspect, which is what characters need", () => {
	const size = normalizeImageSize();
	assert.equal(size.width % 16, 0);
	assert.equal(size.height % 16, 0);
	assert.ok(size.height > size.width, "a character portrait should default to a portrait aspect");
});

test("a dimension off the 16-pixel grid is refused with the offending field named", () => {
	assert.throws(() => normalizeImageSize({ width: 900, height: 1152 }), /width.*16|16.*width/i);
	assert.throws(() => normalizeImageSize({ width: 896, height: 1000 }), /height.*16|16.*height/i);
});

test("a dimension below the minimum is refused", () => {
	assert.throws(() => normalizeImageSize({ width: 240, height: 1152 }), /width/i);
});

test("a dimension above the maximum is refused", () => {
	assert.throws(() => normalizeImageSize({ width: 2064, height: 1152 }), /width/i);
});

test("a non-numeric dimension is refused rather than coerced", () => {
	assert.throws(() => normalizeImageSize({ width: "896", height: 1152 }), /width/i);
});

// ── Generating ───────────────────────────────────────────────────────────────

test("the prompt is posted to /generate on the configured server", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl);

	assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/generate`);
	assert.equal(fetchImpl.calls[0].init.method, "POST");
	assert.equal(fetchImpl.calls[0].payload.prompt, "a dwarven paladin");
});

test("the image, model and seed all come back", async () => {
	const result = await generate(makeFetch());

	assert.equal(result.b64, FAKE_PNG_B64);
	assert.equal(result.model, "krea2");
	assert.equal(result.seed, 8412);
});

test("character portraits default to the fantasy portrait style", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl);

	assert.equal(fetchImpl.calls[0].payload.style, "fantasy-portrait");
});

test("a caller-chosen style is sent instead of the default", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { style: "photoreal" });

	assert.equal(fetchImpl.calls[0].payload.style, "photoreal");
});

test("a seed is sent when the caller wants a reproducible image", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { seed: 1234 });

	assert.equal(fetchImpl.calls[0].payload.seed, 1234);
});

test("no seed is sent when the caller wants a fresh image", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl);

	assert.equal(Object.hasOwn(fetchImpl.calls[0].payload, "seed"), false);
});

test("the requested dimensions are sent", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { size: { width: 1024, height: 1024 } });

	assert.equal(fetchImpl.calls[0].payload.width, 1024);
	assert.equal(fetchImpl.calls[0].payload.height, 1024);
});

test("the lobby's chosen model is sent when there is one", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { config: { ...config, model: "krea2" } });

	assert.equal(fetchImpl.calls[0].payload.model, "krea2");
});

// ── Parameters this adapter must never send ──────────────────────────────────

test("cfg is never sent, because the model is distilled for the server's default", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { cfg: 7.5 });

	assert.equal(
		Object.hasOwn(fetchImpl.calls[0].payload, "cfg"),
		false,
		"sending cfg at all risks overriding the only value that produces usable output",
	);
});

test("steps is never sent", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { steps: 30 });

	assert.equal(Object.hasOwn(fetchImpl.calls[0].payload, "steps"), false);
});

test("negative_prompt is never sent, having no effect at the server's cfg", async () => {
	const fetchImpl = makeFetch();
	await generate(fetchImpl, { negative_prompt: "blurry" });

	assert.equal(Object.hasOwn(fetchImpl.calls[0].payload, "negative_prompt"), false);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("a blank prompt is refused before a request is made", async () => {
	const fetchImpl = makeFetch();
	await assert.rejects(() => generate(fetchImpl, { prompt: "   " }), /prompt/i);
	assert.equal(fetchImpl.calls.length, 0, "a request was sent for an invalid prompt");
});

test("a non-string prompt is refused", async () => {
	await assert.rejects(() => generate(makeFetch(), { prompt: null }), /prompt/i);
});

test("an unknown style is refused rather than passed through", async () => {
	await assert.rejects(() => generate(makeFetch(), { style: "vaporwave" }), /style/i);
});

test("a missing base URL is refused, because there is no sensible address to guess", async () => {
	await assert.rejects(
		() => generate(makeFetch(), { config: { ...config, baseUrl: null } }),
		/address|base url/i,
	);
});

test("a batch size outside the server's range is refused", async () => {
	await assert.rejects(() => generate(makeFetch(), { batchSize: 0 }), /batch/i);
	await assert.rejects(() => generate(makeFetch(), { batchSize: 9 }), /batch/i);
});

// ── Responses that are not images ────────────────────────────────────────────

test("an empty images array is a failure, not an empty portrait", async () => {
	await assert.rejects(
		() => generate(makeFetch({ body: { images: [], seed: 1, model: "krea2" } })),
		/no image/i,
	);
});

test("a response with no images field is a failure", async () => {
	await assert.rejects(() => generate(makeFetch({ body: { seed: 1 } })), /no image/i);
});

test("the first image is taken when the server returns a batch", async () => {
	const result = await generate(makeFetch({ body: { images: [FAKE_PNG_B64, "second"], seed: 1, model: "krea2" } }));
	assert.equal(result.b64, FAKE_PNG_B64);
});

// ── Failures ─────────────────────────────────────────────────────────────────

test("a backend that is down is reported as a server failure", async () => {
	await assert.rejects(
		() => generate(makeFetch({ status: 503, body: { error: "backend down" } })),
		(err) => {
			assert.ok(err instanceof LLMRequestError);
			assert.equal(err.kind, "server");
			return true;
		},
	);
});

test("a rejected parameter surfaces the server's own explanation", async () => {
	await assert.rejects(
		() => generate(makeFetch({ status: 400, body: { error: "width must be a multiple of 16" } })),
		/multiple of 16/,
	);
});

test("an unreachable server is reported as a network failure", async () => {
	await assert.rejects(
		() => generate(makeFetch({ throws: new Error("ECONNREFUSED") })),
		(err) => {
			assert.equal(err.kind, "network");
			return true;
		},
	);
});

// ── Health probing ───────────────────────────────────────────────────────────

test("a healthy server probes true", async () => {
	assert.equal(await localImageProvider.probe({ config, fetchImpl: makeFetch({ body: { gpu: "test" } }) }), true);
});

test("a server whose backend is down probes false", async () => {
	assert.equal(await localImageProvider.probe({ config, fetchImpl: makeFetch({ status: 503 }) }), false);
});

test("an unreachable server probes false rather than throwing", async () => {
	const fetchImpl = makeFetch({ throws: new Error("ECONNREFUSED") });
	assert.equal(await localImageProvider.probe({ config, fetchImpl }), false);
});

test("a server with no address configured probes false without a request", async () => {
	const fetchImpl = makeFetch();
	assert.equal(await localImageProvider.probe({ config: { ...config, baseUrl: null }, fetchImpl }), false);
	assert.equal(fetchImpl.calls.length, 0);
});

test("probing asks the health endpoint", async () => {
	const fetchImpl = makeFetch({ body: { gpu: "test" } });
	await localImageProvider.probe({ config, fetchImpl });

	assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/health`);
});

// ── Model discovery ──────────────────────────────────────────────────────────

test("installed models are listed for the picker", async () => {
	const fetchImpl = makeFetch({
		body: { models: [{ name: "krea2", installed: true }, { name: "redcraft", installed: true }] },
	});

	const models = await localImageProvider.listModels({ config, fetchImpl });
	assert.deepEqual(models.map((m) => m.id), ["krea2", "redcraft"]);
});

test("models the server does not actually have are left out", async () => {
	const fetchImpl = makeFetch({
		body: { models: [{ name: "krea2", installed: true }, { name: "ghost", installed: false }] },
	});

	const models = await localImageProvider.listModels({ config, fetchImpl });
	assert.deepEqual(models.map((m) => m.id), ["krea2"]);
});

test("a server with no discovery endpoint degrades to an empty list", async () => {
	const models = await localImageProvider.listModels({ config, fetchImpl: makeFetch({ status: 404 }) });
	assert.deepEqual(models, []);
});

test("the styles the adapter offers are declared for the UI", () => {
	assert.ok(localImageProvider.styles.includes("fantasy-portrait"));
	assert.ok(localImageProvider.styles.length >= 3);
});

// ── Descriptor ───────────────────────────────────────────────────────────────

test("the adapter declares itself local and needing an address but no key", () => {
	assert.equal(localImageProvider.isLocal, true);
	assert.equal(localImageProvider.requiresApiKey, false);
	assert.equal(localImageProvider.requiresBaseUrl, true);
});
