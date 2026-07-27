/**
 * Integration tier: narration end-to-end against a real local TTS server.
 *
 * The unit tier pins request construction and response parsing against a fake
 * `fetch`, which cannot catch the server changing its API, returning a format the
 * browser will not play, or emitting frames the client cannot reassemble. This
 * closes that gap for the one provider we can actually run.
 *
 * Skips — rather than fails — when no server answers on `LOCAL_TTS_URL`, so the
 * suite stays runnable on a machine that does not host one.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { localServerProvider } from "../services/tts/providers/localServer.js";
import { streamNarrationToClients } from "../services/tts/narrate.js";
import { parseWavHeader } from "../services/tts/wavTiming.js";

const LOCAL_TTS_URL = process.env.LOCAL_TTS_URL || "http://127.0.0.1:8199";
const deps = { LOCAL_TTS_URL, log: () => {} };

const NARRATION = "The torch [flickers] gutters low, and something vast shifts in the dark beyond the doorway.";

/** Words the client will wrap in indexed spans: whitespace-split, brackets dropped. */
const SPOKEN_WORDS = NARRATION.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean);

let reachable = false;

before(async () => {
	reachable = await localServerProvider.isAvailable(deps);
	if (!reachable) console.log(`# SKIP local TTS server not reachable at ${LOCAL_TTS_URL}`);
});

/**
 * Collects every frame a full narration emits through the real emitter.
 *
 * @returns {Promise<Array<{event: string, payload: object}>>} The broadcast recording.
 */
async function narrate() {
	const sent = [];
	const io = { to: () => ({ emit: (event, payload) => sent.push({ event, payload }) }) };
	await streamNarrationToClients(io, "lobby-integration", NARRATION, null, "DM", {
		resolve: () => ({ provider: localServerProvider, providerDeps: deps, voiceId: "Keiko" }),
		devMode: false,
		REJECTED_REQUEST_STATUS: 204,
		room: (id) => id,
		log: () => {},
	});
	return sent;
}

test("the local server advertises voices the settings dropdown can render", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	const voices = await localServerProvider.listVoices(deps);
	assert.ok(voices.length > 0, "a running server must offer at least one voice");
	for (const v of voices) {
		assert.equal(typeof v.id, "string");
		assert.ok(v.id.length, "a voice with no id cannot be selected");
		assert.equal(typeof v.name, "string");
	}
	assert.equal(voices.filter((v) => v.isDefault).length <= 1, true, "at most one voice may be the default");
});

test("narration announces the wav format so the client buffers instead of streaming", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	const start = (await narrate()).find((s) => s.event === "narration:start");
	assert.equal(start.payload.format, "wav", "MediaSource cannot decode wav; the client needs this to pick its path");
});

test("the emitted audio frames reassemble into a playable WAV", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	const sent = await narrate();
	const audio = Buffer.concat(sent.filter((s) => s.event === "narration:audio").map((s) => Buffer.from(s.payload.data, "base64")));

	const header = parseWavHeader(audio);
	assert.ok(header.durationSeconds > 0, "a narration must produce audible audio");
	assert.equal(header.dataBytes, audio.length - 44, "the payload must be exactly what the header declares");
});

test("no single frame exceeds what Socket.IO will carry", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	// The default maxHttpBufferSize is 1 MB and the payload is base64 by this point.
	const sent = await narrate();
	for (const s of sent.filter((f) => f.event === "narration:audio")) {
		assert.ok(s.payload.data.length < 1_000_000, `a ${s.payload.data.length}-byte frame would be dropped by the transport`);
	}
});

test("alignment covers every spoken word and matches the clip length", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	const sent = await narrate();
	const words = sent.filter((s) => s.event === "narration:alignment").flatMap((s) => s.payload.words);
	const audio = Buffer.concat(sent.filter((s) => s.event === "narration:audio").map((s) => Buffer.from(s.payload.data, "base64")));

	assert.deepEqual(
		words.map((w) => w.word),
		SPOKEN_WORDS,
		"an index that does not match the client's wrapped spans highlights the wrong word",
	);
	assert.deepEqual(words.map((w) => w.index), SPOKEN_WORDS.map((_, i) => i));
	assert.equal(words.at(-1).end, parseWavHeader(audio).durationSeconds, "the highlight must end on the last sample");
});

test("a narration always ends its stream, so the turn timer is released", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	const sent = await narrate();
	assert.equal(sent.at(-1).event, "narration:audio:end");
	assert.equal(
		sent.filter((s) => s.event === "narration:audio:end").length,
		1,
		"exactly one end frame; a second would start the turn timer twice",
	);
});

test("a voice the server has not built fails without stranding the client", async (t) => {
	if (!reachable) return t.skip("local TTS server not reachable");
	const sent = [];
	const io = { to: () => ({ emit: (event, payload) => sent.push({ event, payload }) }) };
	await streamNarrationToClients(io, "lobby-integration", NARRATION, null, "DM", {
		resolve: () => ({ provider: localServerProvider, providerDeps: deps, voiceId: "NoSuchVoiceXYZ" }),
		devMode: false,
		REJECTED_REQUEST_STATUS: 204,
		room: (id) => id,
		log: () => {},
	});
	assert.ok(sent.some((s) => s.event === "narration:audio:end"), "the game must move on even when synthesis fails");
});
