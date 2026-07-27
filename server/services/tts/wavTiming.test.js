import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWavHeader, estimateWordTimings } from "./wavTiming.js";

/**
 * Builds a valid RIFF/WAVE buffer with a caller-chosen format and payload size.
 *
 * @description The local TTS server emits 16-bit mono PCM at 24 kHz, so those are
 *   the defaults. Everything is overridable because the parser's whole point is
 *   that it must not assume any particular format.
 * @param {{sampleRate?: number, channels?: number, bitsPerSample?: number, dataBytes?: number, extraChunk?: {id: string, body: Buffer}}} [opts]
 *   - `extraChunk` is inserted between `fmt ` and `data` to prove the parser walks
 *     the chunk list instead of trusting the canonical 44-byte offset.
 * @returns {Buffer} A complete WAV file.
 */
function makeWav(opts = {}) {
	const {
		sampleRate = 24000,
		channels = 1,
		bitsPerSample = 16,
		dataBytes = 48000,
		extraChunk = null,
	} = opts;
	const byteRate = sampleRate * channels * (bitsPerSample / 8);

	const fmt = Buffer.alloc(24);
	fmt.write("fmt ", 0, "ascii");
	fmt.writeUInt32LE(16, 4);
	fmt.writeUInt16LE(1, 8);                        // PCM
	fmt.writeUInt16LE(channels, 10);
	fmt.writeUInt32LE(sampleRate, 12);
	fmt.writeUInt32LE(byteRate, 16);
	fmt.writeUInt16LE(channels * (bitsPerSample / 8), 20);
	fmt.writeUInt16LE(bitsPerSample, 22);

	// RIFF chunk bodies are word-aligned, so an odd-sized body carries a pad byte.
	// Emitting it keeps the fixture a file a real encoder would actually produce.
	const extra = extraChunk
		? Buffer.concat([
			Buffer.from(extraChunk.id, "ascii"),
			(() => { const b = Buffer.alloc(4); b.writeUInt32LE(extraChunk.body.length, 0); return b; })(),
			extraChunk.body,
			Buffer.alloc(extraChunk.body.length % 2),
		])
		: Buffer.alloc(0);

	const dataHeader = Buffer.alloc(8);
	dataHeader.write("data", 0, "ascii");
	dataHeader.writeUInt32LE(dataBytes, 4);

	const body = Buffer.concat([fmt, extra, dataHeader, Buffer.alloc(dataBytes)]);

	const riff = Buffer.alloc(12);
	riff.write("RIFF", 0, "ascii");
	riff.writeUInt32LE(4 + body.length, 4);
	riff.write("WAVE", 8, "ascii");

	return Buffer.concat([riff, body]);
}

// ===== parseWavHeader =====

test("parseWavHeader reads the format fields the local TTS server emits", () => {
	const header = parseWavHeader(makeWav());
	assert.equal(header.sampleRate, 24000);
	assert.equal(header.channels, 1);
	assert.equal(header.bitsPerSample, 16);
	assert.equal(header.byteRate, 48000);
});

test("parseWavHeader derives duration from the declared byte rate", () => {
	// 48000 bytes of 16-bit mono 24 kHz audio is exactly one second.
	assert.equal(parseWavHeader(makeWav({ dataBytes: 48000 })).durationSeconds, 1);
});

test("parseWavHeader derives duration correctly for stereo at a different rate", () => {
	// 44.1 kHz stereo 16-bit is 176400 bytes/sec; half that is half a second.
	const wav = makeWav({ sampleRate: 44100, channels: 2, dataBytes: 88200 });
	assert.equal(parseWavHeader(wav).durationSeconds, 0.5);
});

test("parseWavHeader walks past unrelated chunks to find the data chunk", () => {
	const wav = makeWav({ extraChunk: { id: "LIST", body: Buffer.from("INFOsome metadata.") } });
	const header = parseWavHeader(wav);
	assert.equal(header.dataBytes, 48000, "a LIST chunk before 'data' must not shift the parse");
	assert.equal(header.durationSeconds, 1);
});

test("parseWavHeader tolerates an odd-sized chunk and its pad byte", () => {
	const wav = makeWav({ extraChunk: { id: "fact", body: Buffer.from("odd") } });
	assert.equal(parseWavHeader(wav).dataBytes, 48000);
});

test("parseWavHeader reports zero duration for an empty data chunk", () => {
	const header = parseWavHeader(makeWav({ dataBytes: 0 }));
	assert.equal(header.dataBytes, 0);
	assert.equal(header.durationSeconds, 0);
});

test("parseWavHeader clamps a declared data size larger than the buffer", () => {
	// A truncated response must not be reported as full-length audio, or the
	// highlighter would run on past the end of what actually plays.
	const wav = makeWav({ dataBytes: 48000 });
	const truncated = wav.subarray(0, wav.length - 24000);
	assert.equal(parseWavHeader(truncated).dataBytes, 24000);
});

test("parseWavHeader rejects a non-Buffer argument", () => {
	assert.throws(
		() => parseWavHeader("RIFF....WAVE"),
		{ name: "TypeError", message: /expects a Buffer, received string/ },
	);
});

test("parseWavHeader rejects a buffer too short to be a container", () => {
	assert.throws(() => parseWavHeader(Buffer.from("RIFF")), { message: /too short/ });
});

test("parseWavHeader rejects a buffer with no RIFF marker", () => {
	const notWav = Buffer.alloc(64);
	notWav.write("OggS", 0, "ascii");
	assert.throws(() => parseWavHeader(notWav), { message: /missing RIFF marker/ });
});

test("parseWavHeader rejects a RIFF container that is not WAVE", () => {
	const avi = makeWav();
	avi.write("AVI ", 8, "ascii");
	assert.throws(() => parseWavHeader(avi), { message: /missing WAVE marker/ });
});

test("parseWavHeader rejects a WAV with no format chunk", () => {
	const wav = makeWav();
	wav.write("junk", 12, "ascii");
	assert.throws(() => parseWavHeader(wav), { message: /no 'fmt ' chunk/ });
});

test("parseWavHeader rejects a WAV with no data chunk", () => {
	const wav = makeWav({ dataBytes: 0 });
	wav.write("junk", 36, "ascii");
	assert.throws(() => parseWavHeader(wav), { message: /no 'data' chunk/ });
});

test("parseWavHeader rejects a WAV declaring a zero byte rate", () => {
	const wav = makeWav();
	wav.writeUInt32LE(0, 28);                       // byteRate field inside 'fmt '
	assert.throws(() => parseWavHeader(wav), { message: /byte rate is zero/ });
});

// ===== estimateWordTimings =====

test("estimateWordTimings gives every word a slot in reading order", () => {
	const words = estimateWordTimings("the dragon wakes", 3);
	assert.deepEqual(words.map((w) => w.word), ["the", "dragon", "wakes"]);
	assert.deepEqual(words.map((w) => w.index), [0, 1, 2]);
});

test("estimateWordTimings apportions time by word length", () => {
	// "ab" and "abcdef" are 2 and 6 characters of 8, so 1s and 3s of 4s.
	const words = estimateWordTimings("ab abcdef", 4);
	assert.equal(words[0].start, 0);
	assert.equal(words[0].end, 1);
	assert.equal(words[1].start, 1);
	assert.equal(words[1].end, 4);
});

test("estimateWordTimings gives a lone word the whole clip", () => {
	assert.deepEqual(estimateWordTimings("alone", 2.5), [{ word: "alone", start: 0, end: 2.5, index: 0 }]);
});

test("estimateWordTimings ends exactly on the clip duration", () => {
	// Seven words over a duration that does not divide evenly — the highlight must
	// still finish on the last sample rather than drifting short.
	const words = estimateWordTimings("one two three four five six seven", 1 / 3);
	assert.equal(words.at(-1).end, 1 / 3);
});

test("estimateWordTimings leaves no gaps between consecutive words", () => {
	const words = estimateWordTimings("alpha beta gamma delta", 5);
	for (let i = 1; i < words.length; i++) {
		assert.equal(words[i].start, words[i - 1].end, `word ${i} must begin where word ${i - 1} ended`);
	}
});

test("estimateWordTimings applies the cumulative time and index offsets", () => {
	const words = estimateWordTimings("ab cd", 2, { timeOffset: 10, indexOffset: 7 });
	assert.equal(words[0].start, 10);
	assert.equal(words[0].index, 7);
	assert.equal(words[1].index, 8);
	assert.equal(words.at(-1).end, 12);
});

test("estimateWordTimings skips bracketed stage directions so indices match the DOM spans", () => {
	// client/app.js wrapNarrationWords() does not wrap bracket content, so the
	// nth timing must be the nth wrapped span or the highlight lands on the wrong word.
	const words = estimateWordTimings("Hello [he smiles] world", 2);
	assert.deepEqual(words.map((w) => w.word), ["Hello", "world"]);
	assert.deepEqual(words.map((w) => w.index), [0, 1]);
});

test("estimateWordTimings returns nothing for an empty string", () => {
	assert.deepEqual(estimateWordTimings("", 5), []);
});

test("estimateWordTimings returns nothing for whitespace only", () => {
	assert.deepEqual(estimateWordTimings("   \n\t ", 5), []);
});

test("estimateWordTimings returns nothing when the text is all stage direction", () => {
	assert.deepEqual(estimateWordTimings("[a long pause]", 5), []);
});

test("estimateWordTimings returns nothing for a zero-length clip", () => {
	assert.deepEqual(estimateWordTimings("some words", 0), []);
});

test("estimateWordTimings returns nothing for a negative duration", () => {
	assert.deepEqual(estimateWordTimings("some words", -1), []);
});

test("estimateWordTimings returns nothing for a non-numeric duration", () => {
	assert.deepEqual(estimateWordTimings("some words", NaN), []);
	assert.deepEqual(estimateWordTimings("some words", undefined), []);
});

test("estimateWordTimings rejects a non-string text argument", () => {
	assert.throws(
		() => estimateWordTimings(null, 5),
		{ name: "TypeError", message: /expects a string, received object/ },
	);
});

test("estimateWordTimings composes with parseWavHeader over a real header", () => {
	const duration = parseWavHeader(makeWav({ dataBytes: 96000 })).durationSeconds;
	const words = estimateWordTimings("two seconds of speech", duration);
	assert.equal(duration, 2);
	assert.equal(words.at(-1).end, 2);
});
