import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "stream";

import { elevenLabsProvider, charAlignmentToWords } from "./elevenLabs.js";

const KEY = "test-key-DO-NOT-USE";

/**
 * Builds an in-memory stand-in for the filesystem calls the voice cache makes.
 *
 * @description The adapter takes `fsImpl` as a dependency so the unit tier never
 *   touches a real path (`TDD-8`). Files start empty unless seeded.
 * @param {object} [seed] - Initial path→contents map.
 * @returns {object} An fs-shaped double exposing the seeded `files` map.
 */
function makeFs(seed = {}) {
	const files = { ...seed };
	return {
		files,
		existsSync: (p) => Object.hasOwn(files, p),
		readFileSync: (p) => {
			if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
			return files[p];
		},
		writeFileSync: (p, data) => { files[p] = data; },
		mkdirSync: () => {},
	};
}

/**
 * Builds a fetch double answering from a route table, recording every call.
 *
 * @param {object} routes - Map of URL substring to `{status?, json?, ndjson?, buffer?}`
 *   or to a function that throws to simulate a transport failure. `ndjson` is an
 *   array of objects delivered as newline-delimited JSON over a Node stream, which
 *   is how ElevenLabs' with-timestamps endpoint actually responds.
 * @returns {{fetchImpl: Function, calls: Array<{url: string, options: object}>}}
 */
function makeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url, options = {}) => {
		calls.push({ url, options });
		const key = Object.keys(routes).find((k) => url.includes(k));
		if (!key) throw new Error(`unexpected fetch to ${url}`);
		const route = routes[key];
		if (typeof route === "function") return route();
		const { status = 200, json, ndjson, buffer, chunkSplit } = route;

		let body = null;
		if (ndjson) {
			const text = ndjson.map((o) => JSON.stringify(o)).join("\n");
			// Split mid-line where asked, to prove the NDJSON reassembly handles a
			// JSON object arriving across two socket reads.
			const pieces = chunkSplit
				? [text.slice(0, chunkSplit), text.slice(chunkSplit)]
				: [text];
			body = Readable.from(pieces.map((p) => Buffer.from(p)));
		} else if (buffer) {
			body = Readable.from([buffer]);
		}

		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: `status ${status}`,
			headers: { get: () => "audio/mpeg" },
			body,
			json: async () => {
				if (json === undefined) throw new SyntaxError("not JSON");
				return json;
			},
			arrayBuffer: async () => {
				const b = buffer ?? Buffer.alloc(0);
				return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			},
		};
	};
	return { fetchImpl, calls };
}

/**
 * Standard dependency bundle for the ElevenLabs adapter.
 *
 * @description The key is deliberately a fake placeholder (`TDD-14`); no test here
 *   reaches a real endpoint.
 * @param {object} routes - Route table for the fetch double.
 * @param {object} [over] - Dependency overrides.
 * @returns {{deps: object, calls: Array, fsImpl: object}}
 */
function makeDeps(routes, over = {}) {
	const { fetchImpl, calls } = makeFetch(routes);
	const fsImpl = over.fsImpl || makeFs();
	return {
		calls,
		fsImpl,
		deps: {
			ELEVEN_API_KEY: KEY,
			VOICE_CACHE_FILE: "/cache/voices.json",
			fetchImpl,
			fsImpl,
			log: () => {},
			chunkDelayMs: 0,
			...over,
		},
	};
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
 * Builds an NDJSON frame carrying base64 audio.
 *
 * @param {string} text - Plain text to encode as if it were audio bytes.
 * @returns {object} A frame in the shape the API returns.
 */
function audioFrame(text) {
	return { audio_base64: Buffer.from(text).toString("base64") };
}

const ALIGNMENT = {
	characters: ["h", "i", " ", "y", "o", "u"],
	character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
	character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
};

// ===== charAlignmentToWords =====

test("charAlignmentToWords groups characters into whitespace-delimited words", () => {
	const words = charAlignmentToWords(ALIGNMENT, 0, 0);
	assert.deepEqual(words.map((w) => w.word), ["hi", "you"]);
});

test("charAlignmentToWords takes each word's span from its first and last character", () => {
	const [hi] = charAlignmentToWords(ALIGNMENT, 0, 0);
	assert.equal(hi.start, 0);
	assert.equal(hi.end, 0.2);
});

test("charAlignmentToWords applies the cumulative time offset from earlier chunks", () => {
	const [hi] = charAlignmentToWords(ALIGNMENT, 10, 0);
	assert.equal(hi.start, 10);
	assert.equal(hi.end, 10.2);
});

test("charAlignmentToWords continues the word index across chunks", () => {
	const words = charAlignmentToWords(ALIGNMENT, 0, 5);
	assert.deepEqual(words.map((w) => w.index), [5, 6]);
});

test("charAlignmentToWords emits the trailing word when the text has no final space", () => {
	const words = charAlignmentToWords(ALIGNMENT, 0, 0);
	assert.equal(words.at(-1).word, "you", "a word ending at end-of-input must not be dropped");
});

test("charAlignmentToWords treats newlines and tabs as word separators", () => {
	const words = charAlignmentToWords({
		characters: ["a", "\n", "b", "\t", "c"],
		character_start_times_seconds: [0, 1, 2, 3, 4],
		character_end_times_seconds: [1, 2, 3, 4, 5],
	}, 0, 0);
	assert.deepEqual(words.map((w) => w.word), ["a", "b", "c"]);
});

test("charAlignmentToWords returns nothing when the alignment has no characters", () => {
	assert.deepEqual(charAlignmentToWords({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }, 0, 0), []);
});

test("charAlignmentToWords returns nothing for a malformed alignment object", () => {
	assert.deepEqual(charAlignmentToWords({ characters: ["a"] }, 0, 0), []);
	assert.deepEqual(charAlignmentToWords({}, 0, 0), []);
});

test("charAlignmentToWords returns nothing for whitespace-only input", () => {
	assert.deepEqual(charAlignmentToWords({
		characters: [" ", " "],
		character_start_times_seconds: [0, 1],
		character_end_times_seconds: [1, 2],
	}, 0, 0), []);
});

// ===== isAvailable =====

test("isAvailable reports false without an API key, without calling out", async () => {
	const { deps, calls } = makeDeps({ "/v1/voices": { json: { voices: [{ voice_id: "a", name: "A" }] } } }, { ELEVEN_API_KEY: "" });
	assert.equal(await elevenLabsProvider.isAvailable(deps), false);
	assert.equal(calls.length, 0, "no request should be made when there is no key to send");
});

test("isAvailable reports true when the key returns voices", async () => {
	const { deps } = makeDeps({ "/v1/voices": { json: { voices: [{ voice_id: "a", name: "A" }] } } });
	assert.equal(await elevenLabsProvider.isAvailable(deps), true);
});

test("isAvailable reports false when the key is rejected", async () => {
	const { deps } = makeDeps({ "/v1/voices": { status: 401, json: { detail: "invalid key" } } });
	assert.equal(await elevenLabsProvider.isAvailable(deps), false);
});

test("isAvailable swallows a transport failure rather than crashing startup", async () => {
	const { deps } = makeDeps({ "/v1/voices": () => { throw new Error("ENOTFOUND"); } });
	assert.equal(await elevenLabsProvider.isAvailable(deps), false);
});

// ===== listVoices =====

test("listVoices trims each voice to the fields the dropdown needs", async () => {
	const { deps } = makeDeps({
		"/v1/voices": { json: { voices: [{ voice_id: "v1", name: "George", category: "premade", labels: { accent: "british" }, description: "warm" }] } },
	});
	assert.deepEqual(await elevenLabsProvider.listVoices(deps), [
		{ id: "v1", name: "George", category: "premade", accent: "british", description: "warm", isDefault: false },
	]);
});

test("listVoices tolerates a voice with no category, accent, or description", async () => {
	const { deps } = makeDeps({ "/v1/voices": { json: { voices: [{ voice_id: "v1", name: "Plain" }] } } });
	const [v] = await elevenLabsProvider.listVoices(deps);
	assert.deepEqual([v.category, v.accent, v.description], ["", "", ""]);
});

test("listVoices sends the key as the xi-api-key header", async () => {
	const { deps, calls } = makeDeps({ "/v1/voices": { json: { voices: [] } } });
	await elevenLabsProvider.listVoices(deps);
	assert.equal(calls[0].options.headers["xi-api-key"], KEY);
});

test("listVoices writes the fetched list to the cache file", async () => {
	const { deps, fsImpl } = makeDeps({ "/v1/voices": { json: { voices: [{ voice_id: "v1", name: "George" }] } } });
	await elevenLabsProvider.listVoices(deps);
	assert.ok(fsImpl.files["/cache/voices.json"], "the cache file must be written for offline fallback");
	assert.equal(JSON.parse(fsImpl.files["/cache/voices.json"])[0].voice_id, "v1");
});

test("listVoices falls back to the cache file when the API is unreachable", async () => {
	// A Docker container that boots before its network is up must still offer a
	// voice list rather than an empty dropdown.
	const fsImpl = makeFs({ "/cache/voices.json": JSON.stringify([{ voice_id: "cached", name: "Cached" }]) });
	const { deps } = makeDeps({ "/v1/voices": () => { throw new Error("ECONNREFUSED"); } }, { fsImpl });
	assert.deepEqual((await elevenLabsProvider.listVoices(deps)).map((v) => v.id), ["cached"]);
});

test("listVoices falls back to the cache file on a rejected key", async () => {
	const fsImpl = makeFs({ "/cache/voices.json": JSON.stringify([{ voice_id: "cached", name: "Cached" }]) });
	const { deps } = makeDeps({ "/v1/voices": { status: 401, json: {} } }, { fsImpl });
	assert.deepEqual((await elevenLabsProvider.listVoices(deps)).map((v) => v.id), ["cached"]);
});

test("listVoices returns an empty list when the API fails and no cache exists", async () => {
	const { deps } = makeDeps({ "/v1/voices": () => { throw new Error("ECONNREFUSED"); } });
	assert.deepEqual(await elevenLabsProvider.listVoices(deps), []);
});

test("listVoices returns an empty list when the cache file is corrupt", async () => {
	const fsImpl = makeFs({ "/cache/voices.json": "{ this is not json" });
	const { deps } = makeDeps({ "/v1/voices": () => { throw new Error("ECONNREFUSED"); } }, { fsImpl });
	assert.deepEqual(await elevenLabsProvider.listVoices(deps), []);
});

test("listVoices returns an empty list without a key rather than calling out", async () => {
	const { deps, calls } = makeDeps({ "/v1/voices": { json: { voices: [] } } }, { ELEVEN_API_KEY: "" });
	assert.deepEqual(await elevenLabsProvider.listVoices(deps), []);
	assert.equal(calls.length, 0);
});

// ===== synthesize =====

test("synthesize yields the decoded audio from the NDJSON stream", async () => {
	const { deps } = makeDeps({
		"/stream/with-timestamps": { ndjson: [audioFrame("hello"), audioFrame("world")] },
	});
	const frames = await collect(elevenLabsProvider.synthesize("Speak this.", "v1", deps));
	const audio = Buffer.concat(frames.filter((f) => f.type === "audio").map((f) => f.data));
	assert.equal(audio.toString(), "helloworld");
});

test("synthesize reassembles a JSON object split across two socket reads", async () => {
	const { deps } = makeDeps({
		"/stream/with-timestamps": { ndjson: [audioFrame("hello"), audioFrame("world")], chunkSplit: 20 },
	});
	const frames = await collect(elevenLabsProvider.synthesize("Speak this.", "v1", deps));
	const audio = Buffer.concat(frames.filter((f) => f.type === "audio").map((f) => f.data));
	assert.equal(audio.toString(), "helloworld", "a partial trailing line must be held until it completes");
});

test("synthesize yields word alignment derived from the character timings", async () => {
	const { deps } = makeDeps({
		"/stream/with-timestamps": { ndjson: [audioFrame("a"), { alignment: ALIGNMENT }] },
	});
	const frames = await collect(elevenLabsProvider.synthesize("hi you", "v1", deps));
	const alignment = frames.find((f) => f.type === "alignment");
	assert.deepEqual(alignment.words.map((w) => w.word), ["hi", "you"]);
});

test("synthesize accepts normalizedAlignment when no raw alignment is sent", async () => {
	const { deps } = makeDeps({
		"/stream/with-timestamps": { ndjson: [audioFrame("a"), { normalizedAlignment: ALIGNMENT }] },
	});
	const frames = await collect(elevenLabsProvider.synthesize("hi you", "v1", deps));
	assert.ok(frames.find((f) => f.type === "alignment"), "normalizedAlignment is the fallback the API sometimes sends");
});

test("synthesize prefers the raw alignment over the normalized one", async () => {
	const normalized = { ...ALIGNMENT, characters: ["z", "z"], character_start_times_seconds: [0, 1], character_end_times_seconds: [1, 2] };
	const { deps } = makeDeps({
		"/stream/with-timestamps": { ndjson: [{ normalizedAlignment: normalized }, { alignment: ALIGNMENT }] },
	});
	const frames = await collect(elevenLabsProvider.synthesize("hi you", "v1", deps));
	assert.deepEqual(frames.find((f) => f.type === "alignment").words.map((w) => w.word), ["hi", "you"]);
});

test("synthesize sends the voice id in the request path", async () => {
	const { deps, calls } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a")] } });
	await collect(elevenLabsProvider.synthesize("Speak.", "voice-42", deps));
	assert.match(calls[0].url, /text-to-speech\/voice-42\/stream\/with-timestamps/);
});

test("synthesize strips bracketed stage directions before sending them to be spoken", async () => {
	const { deps, calls } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a")] } });
	await collect(elevenLabsProvider.synthesize("He waits [nervously] by the door.", "v1", deps));
	assert.equal(JSON.parse(calls[0].options.body).text, "He waits  by the door.");
});

test("synthesize splits text longer than the request limit into several calls", async () => {
	const { deps, calls } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a")] } });
	const long = new Array(400).fill("wordy").join(" ");   // ~2400 characters
	await collect(elevenLabsProvider.synthesize(long, "v1", deps));
	assert.ok(calls.length > 1, `${long.length} characters should exceed one request, got ${calls.length} call(s)`);
});

test("synthesize carries the time offset forward across text chunks", async () => {
	const { deps } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a"), { alignment: ALIGNMENT }] } });
	const long = new Array(400).fill("wordy").join(" ");
	const alignments = (await collect(elevenLabsProvider.synthesize(long, "v1", deps))).filter((f) => f.type === "alignment");
	assert.ok(alignments.length > 1, "each chunk contributes its own alignment");
	assert.ok(
		alignments[1].words[0].start >= alignments[0].words.at(-1).end,
		"the second chunk's words must be timed after the first chunk's, not restart at zero",
	);
});

test("synthesize carries the word index forward across text chunks", async () => {
	const { deps } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a"), { alignment: ALIGNMENT }] } });
	const long = new Array(400).fill("wordy").join(" ");
	const alignments = (await collect(elevenLabsProvider.synthesize(long, "v1", deps))).filter((f) => f.type === "alignment");
	assert.equal(
		alignments[1].words[0].index,
		alignments[0].words.at(-1).index + 1,
		"restarting the index would highlight the wrong span",
	);
});

test("synthesize yields nothing for empty text without calling out", async () => {
	const { deps, calls } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a")] } });
	assert.deepEqual(await collect(elevenLabsProvider.synthesize("", "v1", deps)), []);
	assert.equal(calls.length, 0);
});

test("synthesize yields nothing when the text is only a stage direction", async () => {
	const { deps, calls } = makeDeps({ "/stream/with-timestamps": { ndjson: [audioFrame("a")] } });
	assert.deepEqual(await collect(elevenLabsProvider.synthesize("[a long silence]", "v1", deps)), []);
	assert.equal(calls.length, 0);
});

test("synthesize skips malformed lines rather than abandoning the stream", async () => {
	const { deps, calls } = makeDeps({
		"/stream/with-timestamps": () => ({
			ok: true,
			status: 200,
			body: Readable.from([Buffer.from(`{"bad json\n${JSON.stringify(audioFrame("good"))}`)]),
		}),
	});
	const frames = await collect(elevenLabsProvider.synthesize("Speak.", "v1", deps));
	assert.equal(Buffer.concat(frames.filter((f) => f.type === "audio").map((f) => f.data)).toString(), "good");
	assert.equal(calls.length, 1);
});

test("synthesize throws on a rejected request", async () => {
	const { deps } = makeDeps({ "/stream/with-timestamps": { status: 429, json: {} } });
	await assert.rejects(() => collect(elevenLabsProvider.synthesize("Speak.", "v1", deps)), { message: /429|status 429/ });
});

test("synthesize propagates a transport failure", async () => {
	const { deps } = makeDeps({ "/stream/with-timestamps": () => { throw new Error("ECONNRESET"); } });
	await assert.rejects(() => collect(elevenLabsProvider.synthesize("Speak.", "v1", deps)), { message: /ECONNRESET/ });
});

// ===== preview =====

test("preview returns playable audio and its content type", async () => {
	const mp3 = Buffer.from("fake-mp3-bytes");
	const { deps } = makeDeps({ "/v1/text-to-speech/": { buffer: mp3 } });
	const result = await elevenLabsProvider.preview("v1", deps);
	assert.equal(result.contentType, "audio/mpeg");
	assert.deepEqual(result.body, mp3);
});

test("preview throws when the request is rejected", async () => {
	const { deps } = makeDeps({ "/v1/text-to-speech/": { status: 401, json: {} } });
	await assert.rejects(() => elevenLabsProvider.preview("v1", deps), { message: /401|status 401/ });
});

// ===== provider descriptor =====

test("the provider declares the mpeg format so the client streams it", () => {
	assert.equal(elevenLabsProvider.audioFormat, "mpeg");
});

test("the provider declares the id the lobby setting stores", () => {
	assert.equal(elevenLabsProvider.id, "elevenlabs");
});
