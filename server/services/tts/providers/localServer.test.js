import { test } from "node:test";
import assert from "node:assert/strict";

import { localServerProvider, normalizeBaseUrl, AUDIO_FRAME_BYTES } from "./localServer.js";

const BASE = "http://127.0.0.1:8199";

/**
 * Builds a 16-bit mono 24 kHz WAV of a given payload size.
 *
 * @description Matches what the local TTS server actually emits, so duration maths
 *   in the tests below is the same arithmetic the provider will do in production.
 * @param {number} dataBytes - Size of the PCM payload; 48000 bytes is one second.
 * @returns {Buffer} A complete WAV file.
 */
function makeWav(dataBytes) {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);                    // mono
	header.writeUInt32LE(24000, 24);                // sample rate
	header.writeUInt32LE(48000, 28);                // byte rate
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(dataBytes, 40);
	return Buffer.concat([header, Buffer.alloc(dataBytes, 7)]);
}

/**
 * Builds a fetch double that answers from a route table and records every call.
 *
 * @description The provider takes `fetchImpl` as a dependency precisely so the unit
 *   tier never touches the network (`TDD-8`). Routes are matched by URL suffix.
 * @param {object} routes - Map of URL suffix to `{status?, json?, buffer?, contentType?}`,
 *   or to a function throwing to simulate a transport failure.
 * @returns {{fetchImpl: Function, calls: Array<{url: string, options: object}>}}
 */
function makeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url, options = {}) => {
		calls.push({ url, options });
		const key = Object.keys(routes).find((k) => url.endsWith(k));
		if (!key) throw new Error(`unexpected fetch to ${url}`);
		const route = routes[key];
		if (typeof route === "function") return route();
		const { status = 200, json, buffer, contentType = "application/json" } = route;
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: `status ${status}`,
			headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
			json: async () => {
				if (json === undefined) throw new SyntaxError("Unexpected token in JSON");
				return json;
			},
			arrayBuffer: async () => {
				const b = buffer ?? Buffer.from(JSON.stringify(json ?? {}));
				return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			},
		};
	};
	return { fetchImpl, calls };
}

/**
 * Drains an async generator into an array.
 *
 * @param {AsyncGenerator} gen - The generator to consume.
 * @returns {Promise<Array>} Everything it yielded, in order.
 */
async function collect(gen) {
	const out = [];
	for await (const frame of gen) out.push(frame);
	return out;
}

/**
 * Standard dependency bundle for the local provider.
 *
 * @param {object} routes - Route table for the fetch double.
 * @param {object} [over] - Dependency overrides.
 * @returns {{deps: object, calls: Array}} The deps and the call recording.
 */
function makeDeps(routes, over = {}) {
	const { fetchImpl, calls } = makeFetch(routes);
	return { deps: { LOCAL_TTS_URL: BASE, fetchImpl, log: () => {}, ...over }, calls };
}

const VOICES_OK = { ok: true, default: "House", voices: [{ id: "House", name: "House" }, { id: "Keiko", name: "Keiko" }] };

// ===== normalizeBaseUrl =====

test("normalizeBaseUrl keeps a well-formed origin untouched", () => {
	assert.equal(normalizeBaseUrl("http://127.0.0.1:8199"), "http://127.0.0.1:8199");
});

test("normalizeBaseUrl strips a trailing slash so path joins never double up", () => {
	assert.equal(normalizeBaseUrl("http://127.0.0.1:8199/"), "http://127.0.0.1:8199");
});

test("normalizeBaseUrl strips several trailing slashes", () => {
	assert.equal(normalizeBaseUrl("http://127.0.0.1:8199///"), "http://127.0.0.1:8199");
});

test("normalizeBaseUrl trims surrounding whitespace from an env var", () => {
	assert.equal(normalizeBaseUrl("  http://127.0.0.1:8199  "), "http://127.0.0.1:8199");
});

test("normalizeBaseUrl rejects a URL with no scheme", () => {
	assert.throws(() => normalizeBaseUrl("127.0.0.1:8199"), { message: /must be an absolute http/i });
});

test("normalizeBaseUrl rejects a non-http scheme", () => {
	assert.throws(() => normalizeBaseUrl("ftp://127.0.0.1:8199"), { message: /must be an absolute http/i });
});

test("normalizeBaseUrl rejects an empty value", () => {
	assert.throws(() => normalizeBaseUrl(""), { message: /must be an absolute http/i });
});

test("normalizeBaseUrl rejects a non-string value", () => {
	assert.throws(() => normalizeBaseUrl(null), { message: /must be an absolute http/i });
});

// ===== isAvailable =====

test("isAvailable reports true when the server says it is ready", async () => {
	const { deps } = makeDeps({ "/health": { json: { ok: true, ready: true } } });
	assert.equal(await localServerProvider.isAvailable(deps), true);
});

test("isAvailable reports false when the server is up but not ready", async () => {
	const { deps } = makeDeps({ "/health": { json: { ok: true, ready: false } } });
	assert.equal(await localServerProvider.isAvailable(deps), false);
});

test("isAvailable reports false on a non-2xx health response", async () => {
	const { deps } = makeDeps({ "/health": { status: 503, json: { ok: false } } });
	assert.equal(await localServerProvider.isAvailable(deps), false);
});

test("isAvailable swallows a transport failure rather than crashing startup", async () => {
	// This runs during boot probing; an unreachable server is the normal case for
	// anyone who does not run one, and must not take the process down.
	const { deps } = makeDeps({ "/health": () => { throw new Error("ECONNREFUSED"); } });
	assert.equal(await localServerProvider.isAvailable(deps), false);
});

// ===== listVoices =====

test("listVoices returns the voices the server offers", async () => {
	const { deps } = makeDeps({ "/voices": { json: VOICES_OK } });
	const voices = await localServerProvider.listVoices(deps);
	assert.deepEqual(voices.map((v) => v.id), ["House", "Keiko"]);
});

test("listVoices fills the dropdown fields the client expects", async () => {
	const { deps } = makeDeps({ "/voices": { json: VOICES_OK } });
	const [first] = await localServerProvider.listVoices(deps);
	assert.deepEqual(first, { id: "House", name: "House", category: "", accent: "", description: "", isDefault: true });
});

test("listVoices marks only the server's declared default", async () => {
	const { deps } = makeDeps({ "/voices": { json: VOICES_OK } });
	const voices = await localServerProvider.listVoices(deps);
	assert.deepEqual(voices.map((v) => v.isDefault), [true, false]);
});

test("listVoices marks nothing default when the server declares none", async () => {
	const { deps } = makeDeps({ "/voices": { json: { ok: true, voices: [{ id: "Rick", name: "Rick" }] } } });
	const voices = await localServerProvider.listVoices(deps);
	assert.equal(voices[0].isDefault, false);
});

test("listVoices returns an empty list when the server has no voices built", async () => {
	const { deps } = makeDeps({ "/voices": { json: { ok: true, voices: [] } } });
	assert.deepEqual(await localServerProvider.listVoices(deps), []);
});

test("listVoices falls back to the id when a voice carries no name", async () => {
	const { deps } = makeDeps({ "/voices": { json: { ok: true, voices: [{ id: "Spike" }] } } });
	assert.equal((await localServerProvider.listVoices(deps))[0].name, "Spike");
});

test("listVoices drops entries with no usable id", async () => {
	const { deps } = makeDeps({ "/voices": { json: { ok: true, voices: [{ name: "nameless" }, { id: "Rick" }] } } });
	assert.deepEqual((await localServerProvider.listVoices(deps)).map((v) => v.id), ["Rick"]);
});

test("listVoices throws on a non-2xx response", async () => {
	const { deps } = makeDeps({ "/voices": { status: 500, json: { ok: false } } });
	await assert.rejects(() => localServerProvider.listVoices(deps), { message: /voice list failed.*500/i });
});

test("listVoices throws when the server reports failure in the body", async () => {
	const { deps } = makeDeps({ "/voices": { json: { ok: false, error: "model not loaded" } } });
	await assert.rejects(() => localServerProvider.listVoices(deps), { message: /model not loaded/ });
});

test("listVoices throws when the payload has no voices array", async () => {
	const { deps } = makeDeps({ "/voices": { json: { ok: true } } });
	await assert.rejects(() => localServerProvider.listVoices(deps), { message: /expected .*voices.* array/i });
});

test("listVoices requests the documented path on the configured base URL", async () => {
	const { deps, calls } = makeDeps({ "/voices": { json: VOICES_OK } });
	await localServerProvider.listVoices(deps);
	assert.equal(calls[0].url, `${BASE}/voices`);
});

// ===== synthesize =====

test("synthesize posts the text and voice to the OpenAI-compatible endpoint", async () => {
	const { deps, calls } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(48000), contentType: "audio/wav" } });
	await collect(localServerProvider.synthesize("Hello there.", "Keiko", deps));
	assert.equal(calls[0].url, `${BASE}/v1/audio/speech`);
	assert.equal(calls[0].options.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].options.body), { input: "Hello there.", voice: "Keiko", response_format: "wav" });
});

test("synthesize yields the audio payload", async () => {
	const wav = makeWav(1000);
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: wav, contentType: "audio/wav" } });
	const frames = await collect(localServerProvider.synthesize("Hello.", "House", deps));
	const audio = frames.filter((f) => f.type === "audio");
	assert.ok(audio.length > 0, "at least one audio frame must be produced");
	assert.deepEqual(Buffer.concat(audio.map((f) => f.data)), wav, "the reassembled frames must be the original WAV");
});

test("synthesize splits large audio into frames small enough for the socket", async () => {
	// Socket.IO's default maxHttpBufferSize is 1 MB and base64 inflates by 4/3, so a
	// 1.5 MB clip sent as one frame would be dropped by the transport.
	const wav = makeWav(1_500_000);
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: wav, contentType: "audio/wav" } });
	const frames = (await collect(localServerProvider.synthesize("Long.", "House", deps))).filter((f) => f.type === "audio");
	assert.ok(frames.length > 1, "a 1.5 MB clip must be split");
	for (const f of frames) {
		assert.ok(f.data.length <= AUDIO_FRAME_BYTES, `frame of ${f.data.length} exceeds the ${AUDIO_FRAME_BYTES} byte cap`);
	}
});

test("synthesize reassembles exactly, losing no bytes across frame boundaries", async () => {
	const wav = makeWav(200_000);
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: wav, contentType: "audio/wav" } });
	const frames = (await collect(localServerProvider.synthesize("x", "House", deps))).filter((f) => f.type === "audio");
	assert.equal(Buffer.concat(frames.map((f) => f.data)).length, wav.length);
});

test("synthesize derives word timings from the clip duration", async () => {
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(96000), contentType: "audio/wav" } });
	const frames = await collect(localServerProvider.synthesize("two seconds here", "House", deps));
	const alignment = frames.find((f) => f.type === "alignment");
	assert.ok(alignment, "an alignment frame must be produced so highlighting still works");
	assert.deepEqual(alignment.words.map((w) => w.word), ["two", "seconds", "here"]);
	assert.equal(alignment.words.at(-1).end, 2);
});

test("synthesize emits the alignment after the audio it describes", async () => {
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(48000), contentType: "audio/wav" } });
	const frames = await collect(localServerProvider.synthesize("some words", "House", deps));
	assert.equal(frames.at(-1).type, "alignment");
});

test("synthesize strips bracketed stage directions before sending them to be spoken", async () => {
	const { deps, calls } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(48000), contentType: "audio/wav" } });
	await collect(localServerProvider.synthesize("He waits [nervously] by the door.", "House", deps));
	assert.equal(JSON.parse(calls[0].options.body).input, "He waits by the door.");
});

test("synthesize yields nothing for empty text without calling the server", async () => {
	const { deps, calls } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(48000) } });
	assert.deepEqual(await collect(localServerProvider.synthesize("", "House", deps)), []);
	assert.equal(calls.length, 0, "no request should be made for empty text");
});

test("synthesize yields nothing when the text is only whitespace", async () => {
	const { deps, calls } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(48000) } });
	assert.deepEqual(await collect(localServerProvider.synthesize("  \n ", "House", deps)), []);
	assert.equal(calls.length, 0);
});

test("synthesize yields nothing when the text is only a stage direction", async () => {
	const { deps, calls } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(48000) } });
	assert.deepEqual(await collect(localServerProvider.synthesize("[a long silence]", "House", deps)), []);
	assert.equal(calls.length, 0);
});

test("synthesize still delivers audio when the response is not parseable as WAV", async () => {
	// Losing the highlight is a cosmetic degradation; losing the narration is not.
	const notWav = Buffer.from("this is not a RIFF container at all");
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: notWav, contentType: "audio/wav" } });
	const frames = await collect(localServerProvider.synthesize("Hello.", "House", deps));
	assert.deepEqual(Buffer.concat(frames.filter((f) => f.type === "audio").map((f) => f.data)), notWav);
	assert.equal(frames.find((f) => f.type === "alignment"), undefined, "no alignment can be derived without a header");
});

test("synthesize throws the server's error message on an unknown voice", async () => {
	const { deps } = makeDeps({
		"/v1/audio/speech": { status: 500, json: { ok: false, error: "voice 'Nobody' not built" }, contentType: "application/json" },
	});
	await assert.rejects(
		() => collect(localServerProvider.synthesize("Hello.", "Nobody", deps)),
		{ message: /voice 'Nobody' not built/ },
	);
});

test("synthesize throws on a non-2xx response with no JSON body", async () => {
	const { deps } = makeDeps({ "/v1/audio/speech": { status: 502, contentType: "text/plain" } });
	await assert.rejects(() => collect(localServerProvider.synthesize("Hello.", "House", deps)), { message: /502/ });
});

test("synthesize propagates a transport failure", async () => {
	const { deps } = makeDeps({ "/v1/audio/speech": () => { throw new Error("ECONNREFUSED"); } });
	await assert.rejects(() => collect(localServerProvider.synthesize("Hello.", "House", deps)), { message: /ECONNREFUSED/ });
});

test("synthesize throws when the server returns an empty body", async () => {
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: Buffer.alloc(0), contentType: "audio/wav" } });
	await assert.rejects(() => collect(localServerProvider.synthesize("Hello.", "House", deps)), { message: /empty audio/i });
});

// ===== preview =====

test("preview returns playable audio and its content type", async () => {
	const wav = makeWav(48000);
	const { deps } = makeDeps({ "/v1/audio/speech": { buffer: wav, contentType: "audio/wav" } });
	const result = await localServerProvider.preview("Keiko", deps);
	assert.equal(result.contentType, "audio/wav");
	assert.deepEqual(result.body, wav);
});

test("preview asks for the voice it was given", async () => {
	const { deps, calls } = makeDeps({ "/v1/audio/speech": { buffer: makeWav(4800), contentType: "audio/wav" } });
	await localServerProvider.preview("Spike", deps);
	assert.equal(JSON.parse(calls[0].options.body).voice, "Spike");
});

test("preview throws when the voice does not exist", async () => {
	const { deps } = makeDeps({
		"/v1/audio/speech": { status: 500, json: { ok: false, error: "voice 'Ghost' not built" }, contentType: "application/json" },
	});
	await assert.rejects(() => localServerProvider.preview("Ghost", deps), { message: /voice 'Ghost' not built/ });
});

// ===== provider descriptor =====

test("the provider declares the wav format so the client picks buffered playback", () => {
	assert.equal(localServerProvider.audioFormat, "wav");
});

test("the provider declares the id the lobby setting stores", () => {
	assert.equal(localServerProvider.id, "local");
});

// ===== timeout reporting =====

test("a voice request that times out says so, rather than leaking the abort", async () => {
	// "This operation was aborted" is what AbortSignal produces, and it tells a host
	// nothing about what to fix. The address field shows this message verbatim.
	const { deps } = makeDeps({
		"/voices": () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); },
	});
	await assert.rejects(() => localServerProvider.listVoices(deps), { message: /timed out/i });
});

test("a synthesis request that times out says so too", async () => {
	const { deps } = makeDeps({
		"/v1/audio/speech": () => { throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); },
	});
	await assert.rejects(
		() => collect(localServerProvider.synthesize("Hello.", "House", deps)),
		{ message: /timed out/i },
	);
});

test("a timeout message names how long it waited, so the number is not a mystery", async () => {
	const { deps } = makeDeps(
		{ "/voices": () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } },
		{ probeTimeoutMs: 5000 },
	);
	await assert.rejects(() => localServerProvider.listVoices(deps), { message: /5s/ });
});

test("a connection refusal is passed through unchanged, since it is already clear", async () => {
	const { deps } = makeDeps({ "/voices": () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9999"); } });
	await assert.rejects(() => localServerProvider.listVoices(deps), { message: /ECONNREFUSED/ });
});

test("isAvailable still reports false on a timeout rather than surfacing it", async () => {
	const { deps } = makeDeps({
		"/health": () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
	});
	assert.equal(await localServerProvider.isAvailable(deps), false);
});
