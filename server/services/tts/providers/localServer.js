/**
 * TTS adapter for a self-hosted, OpenAI-compatible speech server.
 *
 * The reference target is the Python server on `http://127.0.0.1:8199`, which
 * exposes `GET /health`, `GET /voices`, and `POST /v1/audio/speech`. It differs
 * from ElevenLabs in two ways that shape everything below: it returns a complete
 * PCM WAV rather than a stream, and it returns no alignment data. Word timings are
 * therefore reconstructed from the clip duration, and the audio is cut into frames
 * small enough for Socket.IO to carry.
 */

import { parseWavHeader, estimateWordTimings } from "../wavTiming.js";

/**
 * Largest audio payload placed in a single `narration:audio` frame.
 *
 * Socket.IO's default `maxHttpBufferSize` is 1 MB and the frame is base64-encoded
 * on the way out, inflating it by 4/3. 64 KB leaves an order of magnitude of head
 * room and keeps any single dropped frame cheap.
 */
export const AUDIO_FRAME_BYTES = 64 * 1024;

/** Seconds of speech the server produces per second of wall clock, measured ~11x. */
const DEFAULT_SYNTH_TIMEOUT_MS = 120_000;

/** Health probing runs at boot and must not stall startup. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** Sample line spoken by the preview button. */
const PREVIEW_TEXT = "Greetings, traveler. I am the voice of your adventure.";

/**
 * Validates and canonicalises the configured base URL.
 *
 * @description Runs once at the edge per `CQ-6` so that every path join below can
 *   assume a scheme-qualified origin with no trailing slash. Rejecting early gives
 *   a message naming the offending value rather than an opaque fetch failure on the
 *   first narration of a session.
 * @param {string} url - Raw value, typically straight from `LOCAL_TTS_URL`.
 * @returns {string} The origin with trailing slashes removed.
 * @throws {Error} If the value is absent, not a string, or not an absolute http(s) URL.
 */
export function normalizeBaseUrl(url) {
	const trimmed = typeof url === "string" ? url.trim() : "";
	if (!/^https?:\/\/\S+$/i.test(trimmed)) {
		throw new Error(`LOCAL_TTS_URL must be an absolute http(s) URL, received: ${JSON.stringify(url)}`);
	}
	return trimmed.replace(/\/+$/, "");
}

/**
 * Resolves the fetch implementation, preferring the injected one.
 *
 * @description Injection is what keeps the unit tier off the network (`TDD-8`).
 * @param {object} deps - Provider dependencies.
 * @returns {Function} A fetch-compatible function.
 */
function fetchOf(deps) {
	return deps.fetchImpl || globalThis.fetch;
}

/**
 * Performs a request under a wall-clock ceiling.
 *
 * @description A local model that wedges would otherwise hang narration forever,
 *   and with it the turn timer that waits on `narration:done`. The timer is
 *   unref'd so it can never hold the process open.
 * @param {number} ms - Timeout in milliseconds.
 * @param {Function} run - Receives an AbortSignal and returns a promise.
 * @returns {Promise<*>} Whatever `run` resolves to.
 * @throws {Error} Whatever `run` rejects with, including an abort error on timeout.
 */
async function withTimeout(ms, run, what = "Request") {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
	if (typeof timer.unref === "function") timer.unref();
	try {
		return await run(controller.signal);
	} catch (err) {
		// "This operation was aborted" is what AbortSignal produces and it tells a
		// host nothing. These messages are shown verbatim in the settings window, so
		// they have to say what to check.
		if (timedOut || err?.name === "AbortError") {
			// Callers prefix this with the address they were dialling, so it says only
			// what happened and not what to check.
			throw new Error(`${what} timed out after ${ms / 1000}s`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Extracts the most useful error message a failed response can offer.
 *
 * @description The server reports faults as `{ok: false, error: "..."}` with a 500,
 *   and those messages are genuinely actionable ("voice 'X' not built"), so they are
 *   worth surfacing verbatim instead of a bare status code.
 * @param {object} res - The fetch Response.
 * @param {string} what - Short label for the operation, used when no body is readable.
 * @returns {Promise<string>} A human-readable failure description.
 */
async function describeFailure(res, what) {
	try {
		const body = await res.json();
		if (body && body.error) return String(body.error);
	} catch { /* body was not JSON — fall through to the status */ }
	return `${what} failed: ${res.status}`;
}

/**
 * Requests synthesis of a single utterance.
 *
 * @description Shared by narration and by the preview button, which differ only in
 *   the text they speak.
 * @param {string} text - Already stripped of stage directions.
 * @param {string} voiceId - A voice id the server has built.
 * @param {object} deps - `{LOCAL_TTS_URL, fetchImpl?, synthTimeoutMs?}`.
 * @returns {Promise<{body: Buffer, contentType: string}>} The audio and its type.
 * @throws {Error} If the request fails, the server reports an error, or the body is empty.
 */
async function requestSpeech(text, voiceId, deps) {
	const base = normalizeBaseUrl(deps.LOCAL_TTS_URL);
	const res = await withTimeout(deps.synthTimeoutMs ?? DEFAULT_SYNTH_TIMEOUT_MS, (signal) =>
		fetchOf(deps)(`${base}/v1/audio/speech`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: text, voice: voiceId, response_format: "wav" }),
			signal,
		}), "Speech synthesis");

	if (!res.ok) throw new Error(await describeFailure(res, "Local TTS synthesis"));

	const body = Buffer.from(await res.arrayBuffer());
	if (!body.length) throw new Error("Local TTS returned an empty audio body");

	return { body, contentType: res.headers?.get?.("content-type") || "audio/wav" };
}

export const localServerProvider = {
	id: "local",
	label: "Local TTS server",

	/**
	 * Buffered PCM, so the client must collect the frames and play one blob rather
	 * than feeding MediaSource — which cannot decode WAV in any browser.
	 */
	audioFormat: "wav",

	/**
	 * Probes whether the server is up and has finished loading its models.
	 *
	 * @description Called at boot to decide the default provider, so an unreachable
	 *   server — the normal case for anyone not running one — resolves false instead
	 *   of throwing.
	 * @param {object} deps - `{LOCAL_TTS_URL, fetchImpl?, probeTimeoutMs?}`.
	 * @returns {Promise<boolean>} True only when the server reports itself ready.
	 */
	async isAvailable(deps) {
		try {
			const base = normalizeBaseUrl(deps.LOCAL_TTS_URL);
			const res = await withTimeout(deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, (signal) =>
				fetchOf(deps)(`${base}/health`, { signal }), "Health check");
			if (!res.ok) return false;
			const body = await res.json();
			return body?.ok === true && body?.ready !== false;
		} catch {
			return false;
		}
	},

	/**
	 * Lists the voices the server has built.
	 *
	 * @description Normalised into the same shape the ElevenLabs adapter produces so
	 *   the settings dropdown needs no per-provider branching. The server's declared
	 *   default is carried through as `isDefault`, which is what a lobby falls back
	 *   to when its stored voice belongs to the other provider.
	 * @param {object} deps - `{LOCAL_TTS_URL, fetchImpl?, probeTimeoutMs?}`.
	 * @returns {Promise<Array<{id: string, name: string, category: string, accent: string, description: string, isDefault: boolean}>>}
	 * @throws {Error} If the request fails, the server reports an error, or the
	 *   payload carries no `voices` array.
	 */
	async listVoices(deps) {
		const base = normalizeBaseUrl(deps.LOCAL_TTS_URL);
		const res = await withTimeout(deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, (signal) =>
			fetchOf(deps)(`${base}/voices`, { signal }), "Voice list request");

		if (!res.ok) throw new Error(await describeFailure(res, "Local TTS voice list"));

		const body = await res.json();
		if (body?.ok === false) throw new Error(String(body.error || "Local TTS voice list unavailable"));
		if (!Array.isArray(body?.voices)) throw new Error("Local TTS voice list malformed: expected a 'voices' array");

		return body.voices
			.filter((v) => v && v.id)
			.map((v) => ({
				id: String(v.id),
				name: String(v.name || v.id),
				category: "",
				accent: "",
				description: "",
				isDefault: body.default != null && String(v.id) === String(body.default),
			}));
	},

	/**
	 * Synthesises narration and yields it as transport-sized frames.
	 *
	 * @description Stage directions in brackets are removed before synthesis — the
	 *   DM writes them for the reader, not the narrator — using the same pattern
	 *   `client/app.js` uses to decide which words get an indexed span, so the
	 *   alignment indices line up with the DOM. The alignment frame is emitted last
	 *   because it describes audio the client has by then already received.
	 * @param {string} text - Narration text, stage directions included.
	 * @param {string} voiceId - A voice id the server has built.
	 * @param {object} deps - `{LOCAL_TTS_URL, fetchImpl?, synthTimeoutMs?, log?}`.
	 * @yields {{type: "audio", data: Buffer} | {type: "alignment", words: Array}}
	 * @throws {Error} If the request fails, the server reports an error, or the body is empty.
	 */
	async *synthesize(text, voiceId, deps) {
		const spoken = String(text ?? "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
		if (!spoken) return;

		const { body } = await requestSpeech(spoken, voiceId, deps);

		for (let offset = 0; offset < body.length; offset += AUDIO_FRAME_BYTES) {
			yield { type: "audio", data: body.subarray(offset, Math.min(offset + AUDIO_FRAME_BYTES, body.length)) };
		}

		// Highlighting is a nicety; narration is not. A body we cannot parse still
		// plays, it just scrolls without the word following along.
		let durationSeconds = 0;
		try {
			durationSeconds = parseWavHeader(body).durationSeconds;
		} catch (err) {
			deps.log?.(`⚠️  Local TTS audio carried no readable WAV header — skipping word timings: ${err.message}`);
			return;
		}

		const words = estimateWordTimings(spoken, durationSeconds);
		if (words.length) yield { type: "alignment", words };
	},

	/**
	 * Synthesises the fixed preview line for the settings dropdown's play button.
	 *
	 * @param {string} voiceId - The voice to demonstrate.
	 * @param {object} deps - `{LOCAL_TTS_URL, fetchImpl?, synthTimeoutMs?}`.
	 * @returns {Promise<{contentType: string, body: Buffer}>} Audio ready to send to the browser.
	 * @throws {Error} If the request fails or the voice does not exist.
	 */
	async preview(voiceId, deps) {
		const { body, contentType } = await requestSpeech(PREVIEW_TEXT, voiceId, deps);
		return { contentType, body };
	},
};
