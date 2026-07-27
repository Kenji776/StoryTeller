import { test } from "node:test";
import assert from "node:assert/strict";

import { streamNarrationToClients } from "./narrate.js";

/**
 * Builds a Socket.IO stand-in that records every broadcast.
 *
 * @description `io` is a parameter, so emission is observable without a server or
 *   a network. The room is kept alongside each frame so tests can assert targeting
 *   as well as content.
 * @returns {{io: object, sent: Array<{room: string, event: string, payload: object}>}}
 */
function makeIo() {
	const sent = [];
	return {
		sent,
		io: { to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) },
	};
}

/**
 * Builds a provider double that yields a scripted frame sequence.
 *
 * @param {Array} frames - Frames to yield, or an Error to throw instead.
 * @param {object} [over] - Descriptor overrides, e.g. `audioFormat`.
 * @returns {{provider: object, calls: Array<{text: string, voiceId: string}>}}
 */
function makeProvider(frames, over = {}) {
	const calls = [];
	return {
		calls,
		provider: {
			id: "fake",
			label: "Fake",
			audioFormat: "mpeg",
			async *synthesize(text, voiceId) {
				calls.push({ text, voiceId });
				for (const f of frames) {
					if (f instanceof Error) throw f;
					yield f;
				}
			},
			...over,
		},
	};
}

/**
 * Standard dependency bundle for the emitter.
 *
 * @param {object} [over] - Overrides; `resolve` is the usual one to replace.
 * @returns {object} The deps bundle.
 */
function makeDeps(over = {}) {
	const { provider } = makeProvider([]);
	return {
		devMode: false,
		REJECTED_REQUEST_STATUS: 204,
		room: (id) => id,
		log: () => {},
		resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }),
		...over,
	};
}

/**
 * Finds the first frame of a given event type.
 *
 * @param {Array} sent - The recording from `makeIo`.
 * @param {string} event - Event name.
 * @returns {object|undefined} The recorded frame.
 */
const find = (sent, event) => sent.find((s) => s.event === event);

const audio = (text) => ({ type: "audio", data: Buffer.from(text) });

// ===== the happy path =====

test("narration announces the stream before any audio arrives", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("abc")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.equal(sent[0].event, "narration:start");
});

test("narration forwards audio frames as base64", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("hello")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	const frame = find(sent, "narration:audio");
	assert.equal(Buffer.from(frame.payload.data, "base64").toString(), "hello");
});

test("narration forwards every audio frame in order", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("one"), audio("two"), audio("three")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	const payloads = sent.filter((s) => s.event === "narration:audio").map((s) => Buffer.from(s.payload.data, "base64").toString());
	assert.deepEqual(payloads, ["one", "two", "three"]);
});

test("narration forwards alignment frames", async () => {
	const { io, sent } = makeIo();
	const words = [{ word: "hi", start: 0, end: 1, index: 0 }];
	const { provider } = makeProvider([audio("a"), { type: "alignment", words }]);
	await streamNarrationToClients(io, "lob1", "hi", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.deepEqual(find(sent, "narration:alignment").payload.words, words);
});

test("narration ends the stream when the provider is done", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.equal(sent.at(-1).event, "narration:audio:end");
});

test("every frame in a stream carries the same streamId", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("a"), { type: "alignment", words: [{ word: "x", start: 0, end: 1, index: 0 }] }]);
	await streamNarrationToClients(io, "lob1", "x", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	const ids = new Set(sent.map((s) => s.payload.streamId));
	assert.equal(ids.size, 1, "the client routes frames to a channel by streamId; a mismatch drops the audio");
});

test("narration targets the lobby room for every frame", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob7", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.ok(sent.length > 0);
	for (const s of sent) assert.equal(s.room, "lob7");
});

test("narration applies the room mapper exactly once", async () => {
	// The old call sites passed room(lobbyId) and the emitter applied room() again.
	// That was invisible only because room() was the identity function.
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("a")]);
	const deps = makeDeps({ room: (id) => `lobby:${id}`, resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) });
	await streamNarrationToClients(io, "lob7", "Some prose.", "v1", "DM", deps);
	for (const s of sent) assert.equal(s.room, "lobby:lob7");
});

// ===== speaker and format labelling =====

test("narration labels the speaker when one is supplied", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "Ayla", makeDeps());
	assert.equal(find(sent, "narration:start").payload.speaker, "Ayla");
});

test("narration falls back to the DM as speaker when none is supplied", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", undefined, makeDeps());
	assert.equal(find(sent, "narration:start").payload.speaker, "DM");
});

test("narration tells the client which playback strategy the audio needs", async () => {
	// WAV cannot be fed to MediaSource, so the client must know before the first
	// byte arrives whether to stream or to buffer.
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("a")], { audioFormat: "wav" });
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.equal(find(sent, "narration:start").payload.format, "wav");
});

test("narration reports the mpeg format for a streaming provider", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps());
	assert.equal(find(sent, "narration:start").payload.format, "mpeg");
});

// ===== voice resolution =====

test("narration synthesises with the voice the resolver chose", async () => {
	const { io } = makeIo();
	const { provider, calls } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "requested", "DM", makeDeps({
		resolve: () => ({ provider, providerDeps: {}, voiceId: "resolved" }),
	}));
	assert.equal(calls[0].voiceId, "resolved");
});

test("narration passes the requested voice to the resolver", async () => {
	const { io } = makeIo();
	const seen = [];
	const { provider } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "requested", "DM", makeDeps({
		resolve: (lobbyId, voiceId) => { seen.push({ lobbyId, voiceId }); return { provider, providerDeps: {}, voiceId: "v" }; },
	}));
	assert.deepEqual(seen, [{ lobbyId: "lob1", voiceId: "requested" }]);
});

// ===== short-circuits =====

test("dev mode announces and ends the stream without calling a provider", async () => {
	const { io, sent } = makeIo();
	const { provider, calls } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({
		devMode: true,
		resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }),
	}));
	assert.equal(find(sent, "narration:start").payload.status, 204);
	assert.ok(find(sent, "narration:audio:end"), "the client must never be left waiting");
	assert.equal(calls.length, 0, "dev mode exists to spend nothing");
});

test("no configured provider still ends the stream rather than stranding the client", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => null }));
	assert.equal(find(sent, "narration:start").payload.status, 204);
	assert.ok(find(sent, "narration:audio:end"));
});

test("a resolver returning no provider is treated as nothing configured", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider: null, providerDeps: {} }) }));
	assert.equal(find(sent, "narration:start").payload.status, 204);
});

test("empty narration text short-circuits without calling a provider", async () => {
	const { io, sent } = makeIo();
	const { provider, calls } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob1", "   ", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.equal(calls.length, 0);
	assert.equal(find(sent, "narration:start").payload.status, 204);
	assert.ok(find(sent, "narration:audio:end"));
});

test("narration that is only a stage direction short-circuits too", async () => {
	const { io, sent } = makeIo();
	const { provider, calls } = makeProvider([audio("a")]);
	await streamNarrationToClients(io, "lob1", "[a long silence]", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.equal(calls.length, 0);
	assert.ok(find(sent, "narration:audio:end"));
});

test("no short-circuit path emits a contentless narration frame", async () => {
	// A `narration` frame with no content makes the game client print an empty
	// "DM:" line and the admin feed stringify it to "null".
	for (const deps of [makeDeps({ devMode: true }), makeDeps({ resolve: () => null })]) {
		const { io, sent } = makeIo();
		await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", deps);
		assert.deepEqual(sent.filter((s) => s.event === "narration"), []);
	}
});

// ===== failure =====

test("a provider that throws before any audio still ends the stream", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([new Error("synthesis exploded")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.ok(find(sent, "narration:audio:end"), "the turn timer waits on narration:done, which waits on this");
});

test("a provider that throws mid-stream still ends the stream", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([audio("partial"), new Error("stream died")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.ok(find(sent, "narration:audio"), "audio received before the failure is still worth playing");
	assert.ok(find(sent, "narration:audio:end"));
});

test("a failed stream is ended in the lobby room, not a bare lobby id", async () => {
	// The old error path called io.to(lobbyId) while the success path called
	// io.to(room(lobbyId)) — a latent mismatch the identity room() hid.
	const { io, sent } = makeIo();
	const { provider } = makeProvider([new Error("boom")]);
	const deps = makeDeps({ room: (id) => `lobby:${id}`, resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) });
	await streamNarrationToClients(io, "lob7", "Some prose.", "v1", "DM", deps);
	assert.equal(find(sent, "narration:audio:end").room, "lobby:lob7");
});

test("a failed stream ends with the streamId the client is tracking", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([new Error("boom")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.equal(find(sent, "narration:audio:end").payload.streamId, find(sent, "narration:start").payload.streamId);
});

test("a provider failure is logged with the reason", async () => {
	const logged = [];
	const { io } = makeIo();
	const { provider } = makeProvider([new Error("synthesis exploded")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({
		log: (msg) => logged.push(msg),
		resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }),
	}));
	assert.ok(logged.some((m) => String(m).includes("synthesis exploded")), `expected the reason in the log, got: ${JSON.stringify(logged)}`);
});

test("a resolver that throws does not take the narration down", async () => {
	const { io, sent } = makeIo();
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({
		resolve: () => { throw new Error("settings unreadable"); },
	}));
	assert.ok(find(sent, "narration:audio:end"));
});

test("a provider yielding an unknown frame type is ignored rather than fatal", async () => {
	const { io, sent } = makeIo();
	const { provider } = makeProvider([{ type: "telemetry", data: 1 }, audio("a")]);
	await streamNarrationToClients(io, "lob1", "Some prose.", "v1", "DM", makeDeps({ resolve: () => ({ provider, providerDeps: {}, voiceId: "v1" }) }));
	assert.ok(find(sent, "narration:audio"));
	assert.ok(find(sent, "narration:audio:end"));
	assert.equal(sent.filter((s) => s.event === "telemetry").length, 0);
});
