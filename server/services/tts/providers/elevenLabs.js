/**
 * TTS adapter for ElevenLabs.
 *
 * Extracted from `routes/ttsService.js`, which used to hold the key, the wire
 * format, the chunking rules, and the Socket.IO emission in one file. Only the
 * first three belong here; emission is the caller's job.
 *
 * The `stream/with-timestamps` endpoint returns newline-delimited JSON carrying
 * base64 audio fragments interleaved with character-level timings, so this adapter
 * is the streaming counterpart to the local server's buffered one.
 */

import fs from "fs";
import path from "path";

/** Largest text ElevenLabs accepts in one synthesis request. */
const MAX_REQUEST_CHARS = 1800;

/** Audio is batched to this size before being yielded, to limit frame count. */
const AUDIO_BATCH_BYTES = 8 * 1024;

/** Politeness gap between consecutive chunk requests, in milliseconds. */
const DEFAULT_CHUNK_DELAY_MS = 250;

/** Sample line spoken by the preview button. */
const PREVIEW_TEXT = "Greetings, traveler. I am the voice of your adventure.";

/**
 * Resolves the fetch implementation, preferring the injected one.
 *
 * @param {object} deps - Provider dependencies.
 * @returns {Function} A fetch-compatible function.
 */
function fetchOf(deps) {
	return deps.fetchImpl || globalThis.fetch;
}

/**
 * Resolves the filesystem implementation, preferring the injected one.
 *
 * @description Injected so the voice cache can be exercised without touching a
 *   real path (`TDD-8`).
 * @param {object} deps - Provider dependencies.
 * @returns {object} An fs-shaped object.
 */
function fsOf(deps) {
	return deps.fsImpl || fs;
}

/**
 * Converts ElevenLabs character-level alignment into word-level timings.
 *
 * @description Characters arrive with individual start and end times; the client
 *   highlights whole words. A word runs from the start of its first character to
 *   the end of its last. Offsets are supplied by the caller because a long
 *   narration is synthesised as several requests and the timings of each must
 *   continue from the previous rather than restart at zero.
 * @param {object} alignment - `{characters, character_start_times_seconds, character_end_times_seconds}`.
 * @param {number} timeOffset - Cumulative seconds from prior text chunks.
 * @param {number} indexOffset - Cumulative word count from prior text chunks.
 * @returns {Array<{word: string, start: number, end: number, index: number}>}
 *   Word timings, or an empty array if the alignment is unusable.
 */
export function charAlignmentToWords(alignment, timeOffset, indexOffset) {
	const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment || {};
	if (!characters || !starts || !ends) return [];

	const words = [];
	let wordStart = null;
	let wordChars = "";

	for (let i = 0; i < characters.length; i++) {
		const ch = characters[i];
		if (ch === " " || ch === "\n" || ch === "\t") {
			if (wordChars) {
				words.push({ word: wordChars, start: wordStart + timeOffset, end: ends[i - 1] + timeOffset, index: indexOffset + words.length });
				wordChars = "";
				wordStart = null;
			}
		} else {
			if (wordStart === null) wordStart = starts[i];
			wordChars += ch;
		}
	}
	if (wordChars && characters.length > 0) {
		words.push({ word: wordChars, start: wordStart + timeOffset, end: ends[characters.length - 1] + timeOffset, index: indexOffset + words.length });
	}
	return words;
}

/**
 * Fetches the raw voice list from the API.
 *
 * @param {object} deps - `{ELEVEN_API_KEY, fetchImpl?}`.
 * @returns {Promise<Array>} The provider's own voice objects.
 * @throws {Error} If the request is rejected.
 */
async function fetchVoiceList(deps) {
	const res = await fetchOf(deps)("https://api.elevenlabs.io/v1/voices", {
		headers: { "xi-api-key": deps.ELEVEN_API_KEY },
	});
	if (!res.ok) throw new Error(`Failed to fetch voices: ${res.status}`);
	const data = await res.json();
	return data.voices || [];
}

/**
 * Reads the last known good voice list off disk.
 *
 * @description A container that boots before its network is up should still show a
 *   populated dropdown rather than an empty one.
 * @param {object} deps - `{VOICE_CACHE_FILE, fsImpl?, log?}`.
 * @returns {Array} The cached voices, or an empty array if unreadable.
 */
function readVoiceCache(deps) {
	try {
		const fsi = fsOf(deps);
		if (!fsi.existsSync(deps.VOICE_CACHE_FILE)) return [];
		const cached = JSON.parse(fsi.readFileSync(deps.VOICE_CACHE_FILE, "utf8"));
		return Array.isArray(cached) ? cached : [];
	} catch (err) {
		deps.log?.(`⚠️  Voice cache read failed: ${err.message}`);
		return [];
	}
}

/**
 * Normalises a provider voice object into the shared dropdown shape.
 *
 * @param {object} v - An ElevenLabs voice object.
 * @returns {{id: string, name: string, category: string, accent: string, description: string, isDefault: boolean}}
 */
function toVoice(v) {
	return {
		id: v.voice_id,
		name: v.name,
		category: v.category || "",
		accent: v.labels?.accent || "",
		description: v.description || "",
		// ElevenLabs nominates no default; the lobby's configured voice wins.
		isDefault: false,
	};
}

export const elevenLabsProvider = {
	id: "elevenlabs",
	label: "ElevenLabs",

	// Credential metadata, read by services/credentials/. Narration here is billed
	// per character, so whether the instance pays or the host does is a policy
	// decision like any other rather than the fixed operator key it once was.
	requiresApiKey: true,
	requiresBaseUrl: false,
	defaultBaseUrl: null,
	isLocal: false,
	keyUrl: "https://elevenlabs.io/app/settings/api-keys",

	/** MP3, which MediaSource can accept incrementally. */
	audioFormat: "mpeg",

	/**
	 * Probes whether the configured key actually works.
	 *
	 * @description Called at boot to decide the default provider, so every failure
	 *   resolves false rather than throwing.
	 * @param {object} deps - `{ELEVEN_API_KEY, fetchImpl?}`.
	 * @returns {Promise<boolean>} True when the key returns a voice list.
	 */
	async isAvailable(deps) {
		if (!deps.ELEVEN_API_KEY) return false;
		try {
			return (await fetchVoiceList(deps)).length > 0;
		} catch {
			return false;
		}
	},

	/**
	 * Lists the account's voices, falling back to the on-disk cache.
	 *
	 * @description A successful fetch refreshes the cache, so the fallback is always
	 *   the last list the account actually had rather than a stale shipped default.
	 * @param {object} deps - `{ELEVEN_API_KEY, VOICE_CACHE_FILE, fetchImpl?, fsImpl?, log?}`.
	 * @returns {Promise<Array<{id: string, name: string, category: string, accent: string, description: string, isDefault: boolean}>>}
	 *   Voices, or an empty array when the API fails and no cache exists.
	 */
	async listVoices(deps) {
		if (!deps.ELEVEN_API_KEY) return [];
		try {
			const voices = await fetchVoiceList(deps);
			try {
				const fsi = fsOf(deps);
				fsi.mkdirSync(path.dirname(deps.VOICE_CACHE_FILE), { recursive: true });
				fsi.writeFileSync(deps.VOICE_CACHE_FILE, JSON.stringify(voices, null, 2));
			} catch (err) {
				deps.log?.(`⚠️  Voice cache write failed: ${err.message}`);
			}
			return voices.map(toVoice);
		} catch (err) {
			deps.log?.(`⚠️  ElevenLabs API fetch failed: ${err.message} — checking cache...`);
			return readVoiceCache(deps).map(toVoice);
		}
	},

	/**
	 * Synthesises narration, yielding audio and timings as the stream arrives.
	 *
	 * @description Text is split to stay under the request limit, and each request's
	 *   alignment is offset by everything already spoken so the client's word indices
	 *   stay continuous. Bracketed stage directions are removed before synthesis —
	 *   the DM writes them for the reader, not the narrator — matching the tokens
	 *   `wrapNarrationWords` in `client/app.js` chooses to wrap.
	 * @param {string} text - Narration text, stage directions included.
	 * @param {string} voiceId - An ElevenLabs voice id.
	 * @param {object} deps - `{ELEVEN_API_KEY, fetchImpl?, chunkDelayMs?}`.
	 * @yields {{type: "audio", data: Buffer} | {type: "alignment", words: Array}}
	 * @throws {Error} If any request is rejected or the transport fails.
	 */
	async *synthesize(text, voiceId, deps) {
		const chunks = String(text ?? "").match(new RegExp(`[\\s\\S]{1,${MAX_REQUEST_CHARS}}(?=\\s|$)`, "g")) || [String(text ?? "")];
		const delay = deps.chunkDelayMs ?? DEFAULT_CHUNK_DELAY_MS;

		let cumulativeDuration = 0;
		let wordOffset = 0;

		for (let i = 0; i < chunks.length; i++) {
			const cleanText = chunks[i].replace(/\[[^\]]*\]/g, "").trim();
			if (!cleanText) continue;

			const res = await fetchOf(deps)(
				`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream/with-timestamps`,
				{
					method: "POST",
					headers: { "xi-api-key": deps.ELEVEN_API_KEY, "Content-Type": "application/json" },
					body: JSON.stringify({
						text: cleanText,
						model_id: "eleven_flash_v2_5",
						voice_settings: { stability: 0.4, similarity_boost: 0.8 },
					}),
				},
			);
			if (!res.ok) throw new Error(`TTS request failed: ${res.statusText || res.status}`);

			let pending = [];
			let pendingBytes = 0;
			let tail = "";
			let alignmentChars = null;

			/**
			 * Consumes one NDJSON line, buffering audio and capturing alignment.
			 *
			 * @param {string} line - A single line from the response stream.
			 * @returns {Buffer|null} A batch ready to yield, or null if still filling.
			 */
			const takeLine = (line) => {
				if (!line.trim()) return null;
				let obj;
				try {
					obj = JSON.parse(line);
				} catch {
					return null;                    // a partial or corrupt line is not worth failing the narration over
				}
				if (obj.audio_base64) {
					const buf = Buffer.from(obj.audio_base64, "base64");
					pending.push(buf);
					pendingBytes += buf.length;
					if (pendingBytes >= AUDIO_BATCH_BYTES) {
						const batch = Buffer.concat(pending);
						pending = [];
						pendingBytes = 0;
						return batch;
					}
				}
				// The raw alignment is authoritative; the normalized one is a fallback.
				if (obj.alignment) alignmentChars = obj.alignment;
				else if (obj.normalizedAlignment && !alignmentChars) alignmentChars = obj.normalizedAlignment;
				return null;
			};

			for await (const raw of res.body) {
				tail += raw.toString();
				const lines = tail.split("\n");
				tail = lines.pop();                 // an incomplete line waits for the next read
				for (const line of lines) {
					const batch = takeLine(line);
					if (batch) yield { type: "audio", data: batch };
				}
			}

			const lastBatch = takeLine(tail);
			if (lastBatch) yield { type: "audio", data: lastBatch };
			if (pending.length) yield { type: "audio", data: Buffer.concat(pending) };

			if (alignmentChars) {
				const words = charAlignmentToWords(alignmentChars, cumulativeDuration, wordOffset);
				if (words.length) {
					yield { type: "alignment", words };
					wordOffset += words.length;
					const ends = alignmentChars.character_end_times_seconds;
					if (ends?.length) cumulativeDuration += ends[ends.length - 1];
				}
			}

			if (i < chunks.length - 1 && delay > 0) await new Promise((r) => setTimeout(r, delay));
		}
	},

	/**
	 * Synthesises the fixed preview line for the settings dropdown's play button.
	 *
	 * @param {string} voiceId - The voice to demonstrate.
	 * @param {object} deps - `{ELEVEN_API_KEY, fetchImpl?}`.
	 * @returns {Promise<{contentType: string, body: Buffer}>} Audio ready to send to the browser.
	 * @throws {Error} If the request is rejected.
	 */
	async preview(voiceId, deps) {
		const res = await fetchOf(deps)(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
			method: "POST",
			headers: { "xi-api-key": deps.ELEVEN_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
			body: JSON.stringify({
				text: PREVIEW_TEXT,
				model_id: "eleven_multilingual_v2",
				voice_settings: { stability: 0.4, similarity_boost: 0.8 },
			}),
		});
		if (!res.ok) throw new Error(`Preview failed: ${res.statusText || res.status}`);
		return { contentType: "audio/mpeg", body: Buffer.from(await res.arrayBuffer()) };
	},
};
