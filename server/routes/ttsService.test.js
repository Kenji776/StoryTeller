import { test } from "node:test";
import assert from "node:assert/strict";

import { streamNarrationToClients } from "./ttsService.js";

/**
 * Builds a Socket.IO stand-in that records every broadcast.
 *
 * @description `streamNarrationToClients` takes `io` as a parameter, so the emission
 *   behaviour is observable without a server or a network. The recorder keeps the
 *   room alongside each frame so tests can assert targeting as well as content.
 * @returns {{io: object, sent: Array<{room: string, event: string, payload: object}>}}
 *   The double and its recording.
 */
function makeIo() {
	const sent = [];
	return {
		sent,
		io: { to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) },
	};
}

/**
 * Standard dependency bundle for the dev-mode path.
 *
 * @description Mirrors what server.js injects. The API key is deliberately a fake
 *   placeholder (`TDD-14`); dev mode short-circuits before any network call, so no
 *   real credential is ever needed here.
 * @param {object} [over] - Overrides.
 * @returns {object} The deps bundle.
 */
function makeDeps(over = {}) {
	return {
		ELEVEN_API_KEY: "test-key-DO-NOT-USE",
		ELEVEN_VOICE_ID: "test-voice",
		devMode: true,
		REJECTED_REQUEST_STATUS: 204,
		room: (id) => id,
		...over,
	};
}

test("dev mode announces the narration stream so the client can stop waiting", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps());
	const start = sent.find((s) => s.event === "narration:start");
	assert.ok(start, "narration:start must be emitted");
	assert.equal(start.payload.status, 204);
});

test("dev mode always ends the audio stream so the client is never left hanging", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps());
	assert.ok(sent.some((s) => s.event === "narration:audio:end"), "narration:audio:end must be emitted");
});

test("dev mode pairs every narration:start with the same streamId as its audio end", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps());
	const start = sent.find((s) => s.event === "narration:start");
	const end = sent.find((s) => s.event === "narration:audio:end");
	assert.equal(start.payload.streamId, end.payload.streamId);
});

test("dev mode does not emit a narration frame with no content", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps());
	const empty = sent.filter((s) => s.event === "narration" && !s.payload?.content);
	assert.deepEqual(
		empty,
		[],
		"a contentless narration frame makes the client append an empty 'DM:' line and the admin feed print 'null'",
	);
});

test("dev mode does not emit the story text a second time as a narration frame", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps());
	assert.equal(
		sent.filter((s) => s.event === "narration").length,
		0,
		"the caller already emitted the narration; the TTS path must not duplicate it",
	);
});

test("dev mode targets the lobby room for every frame", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob7", "Some prose.", "voice", "DM", makeDeps());
	assert.ok(sent.length > 0);
	for (const s of sent) assert.equal(s.room, "lob7");
});

test("dev mode labels the speaker when one is supplied", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "Ayla", makeDeps());
	assert.equal(sent.find((s) => s.event === "narration:start").payload.speaker, "Ayla");
});

test("dev mode falls back to the DM as speaker when none is supplied", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", undefined, makeDeps());
	assert.equal(sent.find((s) => s.event === "narration:start").payload.speaker, "DM");
});

test("a missing API key still ends the audio stream rather than stranding the client", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps({ devMode: false, ELEVEN_API_KEY: "" }));
	assert.ok(sent.some((s) => s.event === "narration:audio:end"), "narration:audio:end must still be emitted");
});

test("a missing API key does not emit a contentless narration frame either", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "voice", "DM", makeDeps({ devMode: false, ELEVEN_API_KEY: "" }));
	assert.deepEqual(sent.filter((s) => s.event === "narration" && !s.payload?.content), []);
});
