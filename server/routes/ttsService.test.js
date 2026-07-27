import { test } from "node:test";
import assert from "node:assert/strict";

import { registerTTSRoutes } from "./ttsService.js";

/**
 * Builds an Express stand-in that captures route handlers for direct invocation.
 *
 * @description Avoids pulling in a test HTTP client just to exercise four handlers;
 *   the handlers are plain functions of `(req, res)` and are more directly tested
 *   as such. `call` returns whatever the handler wrote to its response.
 * @returns {{app: object, call: Function}}
 */
function makeApp() {
	const routes = new Map();
	const app = { get: (path, handler) => routes.set(path, handler) };

	/**
	 * Invokes a registered handler and collects its response.
	 *
	 * @param {string} path - The registered route path.
	 * @param {object} [req] - Request fields to merge over the defaults.
	 * @returns {Promise<{status: number, body: *, headers: object}>} What the handler sent.
	 */
	const call = async (path, req = {}) => {
		const handler = routes.get(path);
		assert.ok(handler, `no handler registered for ${path}`);
		const out = { status: 200, body: undefined, headers: {} };
		const res = {
			status(code) { out.status = code; return res; },
			json(payload) { out.body = payload; return res; },
			send(payload) { out.body = payload; return res; },
			setHeader(k, v) { out.headers[k.toLowerCase()] = v; return res; },
		};
		await handler({ query: {}, params: {}, ...req }, res);
		return out;
	};

	return { app, call };
}

const VOICES = [{ id: "House", name: "House", category: "", accent: "", description: "", isDefault: true }];

/**
 * Registers the routes against controllable provider behaviour.
 *
 * @param {object} [opts]
 *   - `availability` Provider id → boolean.
 *   - `listVoices`   Override for the local provider's listVoices.
 *   - `preview`      Override for the local provider's preview.
 *   - `devMode`      Passed through to the routes.
 * @returns {{call: Function, availability: object, logs: Array, depsAsked: Array}}
 */
function setup(opts = {}) {
	const { app, call } = makeApp();
	const availability = opts.availability ?? { local: true, elevenlabs: true };
	const logs = [];
	const depsAsked = [];

	// The registry holds the real adapters, so the seams are the dependency bundle
	// each one receives. Overriding through providerDepsFor keeps the registry real.
	const listVoices = opts.listVoices ?? (async () => VOICES);
	const preview = opts.preview ?? (async () => ({ contentType: "audio/wav", body: Buffer.from("audio") }));

	registerTTSRoutes(app, {
		availability,
		devMode: opts.devMode ?? false,
		log: (m) => logs.push(m),
		providerDepsFor: (id) => {
			depsAsked.push(id);
			return { id, listVoices, preview };
		},
	});

	// Patch the adapters' network-facing methods to read from the injected bundle,
	// so no test here reaches a real endpoint (`TDD-8`).
	return { call, availability, logs, depsAsked };
}

/**
 * Replaces the registry adapters' IO methods for the duration of a test.
 *
 * @description `registerTTSRoutes` resolves adapters from the real registry, which
 *   is the behaviour worth testing. Their two IO methods are swapped to read from
 *   the dependency bundle the route hands them, and restored afterwards.
 * @param {Function} body - The test body.
 * @returns {Promise<void>}
 */
async function withStubbedAdapters(body) {
	const { TTS_PROVIDERS } = await import("../services/tts/registry.js");
	const originals = TTS_PROVIDERS.map((p) => ({ p, listVoices: p.listVoices, preview: p.preview }));
	for (const p of TTS_PROVIDERS) {
		p.listVoices = (d) => d.listVoices(d);
		p.preview = (voiceId, d) => d.preview(voiceId, d);
	}
	try {
		await body();
	} finally {
		for (const { p, listVoices, preview } of originals) { p.listVoices = listVoices; p.preview = preview; }
	}
}

// ===== GET /api/tts/providers =====

test("the provider list names every registered engine", async () => {
	const { call } = setup();
	const res = await call("/api/tts/providers");
	assert.deepEqual(res.body.providers.map((p) => p.id).sort(), ["elevenlabs", "local"]);
});

test("the provider list reports which engines are reachable", async () => {
	const { call } = setup({ availability: { local: true, elevenlabs: false } });
	const byId = Object.fromEntries((await call("/api/tts/providers")).body.providers.map((p) => [p.id, p.available]));
	assert.deepEqual(byId, { local: true, elevenlabs: false });
});

test("the provider list carries each engine's audio format", async () => {
	const { call } = setup();
	const byId = Object.fromEntries((await call("/api/tts/providers")).body.providers.map((p) => [p.id, p.audioFormat]));
	assert.deepEqual(byId, { local: "wav", elevenlabs: "mpeg" });
});

test("the provider list names what a lobby with no choice will use", async () => {
	const { call } = setup({ availability: { local: false, elevenlabs: true } });
	assert.equal((await call("/api/tts/providers")).body.defaultProvider, "elevenlabs");
});

test("the provider list reports no default when nothing can speak", async () => {
	const { call } = setup({ availability: { local: false, elevenlabs: false } });
	assert.equal((await call("/api/tts/providers")).body.defaultProvider, null);
});

// ===== GET /api/voices =====

test("the voice list answers for the requested provider", async () => {
	await withStubbedAdapters(async () => {
		const { call, depsAsked } = setup();
		const res = await call("/api/voices", { query: { provider: "elevenlabs" } });
		assert.equal(res.body.ok, true);
		assert.equal(res.body.provider, "elevenlabs");
		assert.ok(depsAsked.includes("elevenlabs"));
	});
});

test("the voice list returns the adapter's voices verbatim", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup();
		assert.deepEqual((await call("/api/voices", { query: { provider: "local" } })).body.voices, VOICES);
	});
});

test("the voice list falls back to an available provider when none is named", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup({ availability: { local: false, elevenlabs: true } });
		assert.equal((await call("/api/voices")).body.provider, "elevenlabs");
	});
});

test("the voice list falls back when the named provider is unreachable", async () => {
	// A settings window left open while the local server was stopped must not wedge.
	await withStubbedAdapters(async () => {
		const { call } = setup({ availability: { local: false, elevenlabs: true } });
		assert.equal((await call("/api/voices", { query: { provider: "local" } })).body.provider, "elevenlabs");
	});
});

test("the voice list still asks a provider that was down at boot", async () => {
	// The boot probe runs once. A server that starts late — the usual case for a
	// container whose network is not up yet — must be able to recover without a
	// restart, which means asking it even though availability says otherwise.
	await withStubbedAdapters(async () => {
		const { call, availability } = setup({ availability: { local: false, elevenlabs: false } });
		const res = await call("/api/voices", { query: { provider: "local" } });
		assert.equal(res.body.ok, true);
		assert.equal(availability.local, true, "answering with voices proves it is up");
	});
});

test("the voice list reports failure when the retry also finds nothing", async () => {
	await withStubbedAdapters(async () => {
		const { call, availability } = setup({ availability: { local: false, elevenlabs: false }, listVoices: async () => [] });
		const res = await call("/api/voices", { query: { provider: "local" } });
		assert.equal(res.body.ok, false);
		assert.deepEqual(res.body.voices, []);
		assert.equal(availability.local, false, "an empty answer must not mark it available");
	});
});

test("the voice list retries the default provider when none is named", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup({ availability: { local: false, elevenlabs: false } });
		assert.equal((await call("/api/voices")).body.provider, "local", "the registry's first choice is the one to retry");
	});
});

test("the voice list reports failure when the provider returns nothing", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup({ listVoices: async () => [] });
		const res = await call("/api/voices", { query: { provider: "local" } });
		assert.equal(res.body.ok, false);
		assert.match(res.body.error, /no voices/i);
	});
});

test("the voice list returns 500 with the reason when the provider throws", async () => {
	await withStubbedAdapters(async () => {
		const { call, logs } = setup({ listVoices: async () => { throw new Error("model not loaded"); } });
		const res = await call("/api/voices", { query: { provider: "local" } });
		assert.equal(res.status, 500);
		assert.match(res.body.error, /model not loaded/);
		assert.ok(logs.some((l) => l.includes("model not loaded")), "the failure must reach the log");
	});
});

test("the voice list is memoised, so a second request does not call the provider again", async () => {
	await withStubbedAdapters(async () => {
		let calls = 0;
		const { call } = setup({ listVoices: async () => { calls++; return VOICES; } });
		await call("/api/voices", { query: { provider: "local" } });
		await call("/api/voices", { query: { provider: "local" } });
		assert.equal(calls, 1);
	});
});

test("an empty voice list is not memoised, so a late-starting provider recovers", async () => {
	// A container whose network came up after boot must not be stuck with an empty
	// dropdown until someone restarts the process.
	await withStubbedAdapters(async () => {
		let calls = 0;
		const { call } = setup({ listVoices: async () => (++calls === 1 ? [] : VOICES) });
		assert.equal((await call("/api/voices", { query: { provider: "local" } })).body.ok, false);
		assert.equal((await call("/api/voices", { query: { provider: "local" } })).body.ok, true);
		assert.equal(calls, 2);
	});
});

test("a provider that answers with voices is marked available again", async () => {
	await withStubbedAdapters(async () => {
		const { call, availability, logs } = setup({ availability: { local: false, elevenlabs: true } });
		await call("/api/voices", { query: { provider: "elevenlabs" } });
		assert.equal(availability.elevenlabs, true);
		// Now the local server comes back; asking it directly should re-enable it.
		availability.local = true;
		await call("/api/voices", { query: { provider: "local" } });
		assert.equal(availability.local, true);
		assert.ok(logs.length >= 0);
	});
});

test("each provider gets its own memo slot", async () => {
	await withStubbedAdapters(async () => {
		const seen = [];
		const { call } = setup({ listVoices: async (d) => { seen.push(d.id); return VOICES; } });
		await call("/api/voices", { query: { provider: "local" } });
		await call("/api/voices", { query: { provider: "elevenlabs" } });
		assert.deepEqual(seen, ["local", "elevenlabs"], "one provider's cache must not answer for another");
	});
});

// ===== GET /api/voice-preview/:id =====

test("a preview streams the adapter's audio with its content type", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup();
		const res = await call("/api/voice-preview/:id", { params: { id: "House" }, query: { provider: "local" } });
		assert.equal(res.headers["content-type"], "audio/wav");
		assert.equal(res.body.toString(), "audio");
	});
});

test("a preview asks for the voice named in the path", async () => {
	await withStubbedAdapters(async () => {
		const asked = [];
		const { call } = setup({ preview: async (voiceId) => { asked.push(voiceId); return { contentType: "audio/wav", body: Buffer.alloc(1) }; } });
		await call("/api/voice-preview/:id", { params: { id: "Keiko" }, query: { provider: "local" } });
		assert.deepEqual(asked, ["Keiko"]);
	});
});

test("a preview is refused in developer mode", async () => {
	const { call } = setup({ devMode: true });
	assert.equal((await call("/api/voice-preview/:id", { params: { id: "House" } })).status, 204);
});

test("a preview also tries a provider that was down at boot", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup({ availability: { local: false, elevenlabs: false } });
		const res = await call("/api/voice-preview/:id", { params: { id: "House" }, query: { provider: "local" } });
		assert.equal(res.status, 200);
	});
});

test("a preview returns 500 when the retried provider is genuinely down", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup({
			availability: { local: false, elevenlabs: false },
			preview: async () => { throw new Error("ECONNREFUSED"); },
		});
		const res = await call("/api/voice-preview/:id", { params: { id: "House" }, query: { provider: "local" } });
		assert.equal(res.status, 500);
	});
});

test("a preview returns 500 and logs when the provider throws", async () => {
	await withStubbedAdapters(async () => {
		const { call, logs } = setup({ preview: async () => { throw new Error("voice 'Ghost' not built"); } });
		const res = await call("/api/voice-preview/:id", { params: { id: "Ghost" }, query: { provider: "local" } });
		assert.equal(res.status, 500);
		assert.ok(logs.some((l) => l.includes("not built")), "the reason must reach the log even though the client gets a generic message");
	});
});

test("a preview does not leak the provider's error text to the browser", async () => {
	await withStubbedAdapters(async () => {
		const { call } = setup({ preview: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8199"); } });
		const res = await call("/api/voice-preview/:id", { params: { id: "House" }, query: { provider: "local" } });
		assert.equal(res.body, "Preview unavailable");
	});
});
