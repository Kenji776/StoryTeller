import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { randomUUID } from "crypto";
import { PassThrough } from "stream";

// Module-level voice cache
let ELEVEN_VOICES = [];

// ===== VOICE FETCHING =====

/**
 * Fetch voices from ElevenLabs API, with local cache file fallback.
 * @param {{ ELEVEN_API_KEY: string, VOICE_CACHE_FILE: string, log: Function }} deps
 * @returns {Promise<Array>}
 */
export async function fetchVoices(deps) {
	const { ELEVEN_API_KEY, VOICE_CACHE_FILE, log } = deps;
	try {
		// If voices already loaded in memory, reuse them
		if (ELEVEN_VOICES.length) return ELEVEN_VOICES;
		const res = await fetch("https://api.elevenlabs.io/v1/voices", {
			headers: { "xi-api-key": ELEVEN_API_KEY },
		});
		if (!res.ok) throw new Error(`Failed to fetch voices: ${res.status}`);
		const data = await res.json();

		ELEVEN_VOICES = data.voices || [];

		// Save to cache file
		fs.mkdirSync(path.dirname(VOICE_CACHE_FILE), { recursive: true });
		fs.writeFileSync(VOICE_CACHE_FILE, JSON.stringify(ELEVEN_VOICES, null, 2));

		return ELEVEN_VOICES;

	} catch (err) {
		log(`⚠️  ElevenLabs API fetch failed: ${err.message} — checking cache...`);

		// Fall back to cached voices file
		try {
			if (fs.existsSync(VOICE_CACHE_FILE)) {
				const cached = JSON.parse(fs.readFileSync(VOICE_CACHE_FILE, "utf8"));
				if (Array.isArray(cached) && cached.length) {
					ELEVEN_VOICES = cached;
					log(`✅ Loaded ${cached.length} voices from cache`);
					return ELEVEN_VOICES;
				}
			}
		} catch (cacheErr) {
			log(`⚠️  Voice cache read failed: ${cacheErr.message}`);
		}

		return [];
	}
}

// ===== ElevenLabs streaming helper =====

/**
 * Convert ElevenLabs character-level alignment to word-level timing data.
 * @param {object}  alignment   - { characters, character_start_times_seconds, character_end_times_seconds }
 * @param {number}  timeOffset  - cumulative seconds from prior text chunks
 * @param {number}  indexOffset - cumulative word count from prior text chunks
 * @returns {Array<{word:string, start:number, end:number, index:number}>}
 */
export function charAlignmentToWords(alignment, timeOffset, indexOffset) {
	const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
	if (!characters || !character_start_times_seconds || !character_end_times_seconds) return [];

	const words = [];
	let wordStart = null;
	let wordChars = "";

	for (let i = 0; i < characters.length; i++) {
		const ch = characters[i];
		if (ch === " " || ch === "\n" || ch === "\t") {
			if (wordChars) {
				words.push({
					word: wordChars,
					start: wordStart + timeOffset,
					end: character_end_times_seconds[i - 1] + timeOffset,
					index: indexOffset + words.length,
				});
				wordChars = "";
				wordStart = null;
			}
		} else {
			if (wordStart === null) wordStart = character_start_times_seconds[i];
			wordChars += ch;
		}
	}
	if (wordChars && characters.length > 0) {
		words.push({
			word: wordChars,
			start: wordStart + timeOffset,
			end: character_end_times_seconds[characters.length - 1] + timeOffset,
			index: indexOffset + words.length,
		});
	}
	return words;
}

// ===== TTS STREAMING =====

/**
 * Stream TTS narration audio to all connected clients in a Socket.IO lobby room.
 *
 * The input text is split into ≤1800-character chunks to stay within ElevenLabs
 * request limits. Each chunk is sent to ElevenLabs' `stream/with-timestamps`
 * endpoint, which returns a newline-delimited JSON stream containing
 * `audio_base64` fragments and character-level alignment data. Audio fragments
 * are buffered client-side in 8 KB batches before being forwarded as
 * `narration:audio` Socket.IO events, minimising round-trips. After each chunk
 * completes, word-level timing data (derived from `charAlignmentToWords`) is
 * emitted as a `narration:alignment` event with cumulative time and word
 * offsets, so the client can synchronise text highlighting with playback.
 *
 * In `devMode` or when no API key is configured the function short-circuits and
 * emits stub events so the client UI still transitions through its states.
 *
 * Emitted Socket.IO events (in order):
 *   - `narration:start`        – sent once before streaming begins
 *   - `narration:audio`        – sent one or more times with base64 audio data
 *   - `narration:alignment`    – sent once per text chunk with word timing data
 *   - `narration:audio:end`    – sent when all chunks have been processed
 *
 * @param {object} io         - Socket.IO server instance
 * @param {string} lobbyId    - Lobby identifier used to resolve the socket room
 * @param {string} text       - Full narration text to synthesise
 * @param {string|null} voiceId     - ElevenLabs voice ID; falls back to `deps.ELEVEN_VOICE_ID` when falsy
 * @param {string} playerName - Speaker label sent to clients (defaults to "DM")
 * @param {{ ELEVEN_API_KEY: string, ELEVEN_VOICE_ID: string, devMode: boolean, REJECTED_REQUEST_STATUS: string, room: Function }} deps
 *   - `ELEVEN_API_KEY`          ElevenLabs API key
 *   - `ELEVEN_VOICE_ID`         Default voice ID used when `voiceId` is not supplied
 *   - `devMode`                 When true, emits stub events and skips API calls
 *   - `REJECTED_REQUEST_STATUS` Status string attached to stub events in dev/no-key mode
 *   - `room`                    Helper that converts a lobbyId to a Socket.IO room string
 * @returns {Promise<void>} Resolves when all audio chunks have been streamed, or
 *   immediately if short-circuited by devMode / missing API key
 */
export async function streamNarrationToClients(io, lobbyId, text, voiceId, playerName, deps) {
	const { ELEVEN_API_KEY, ELEVEN_VOICE_ID, devMode, REJECTED_REQUEST_STATUS, room } = deps;
	const streamId = randomUUID();
	try {
		if (devMode) {
			io.to(room(lobbyId)).emit("narration", { content: null, status: REJECTED_REQUEST_STATUS });

			io.to(room(lobbyId)).emit("narration:start", {
				speaker: playerName || "DM",
				streamId,
				status: REJECTED_REQUEST_STATUS,
			});

			io.to(room(lobbyId)).emit("narration:audio:end", { streamId, status: REJECTED_REQUEST_STATUS });
			return;
		}

		if (!ELEVEN_API_KEY) {
			console.warn("⚠️ ElevenLabs API key not set, skipping TTS.");
			io.to(room(lobbyId)).emit("narration:start", {
				speaker: playerName || "DM",
				streamId,
				status: REJECTED_REQUEST_STATUS,
			});
			io.to(room(lobbyId)).emit("narration:audio:end", { streamId, status: REJECTED_REQUEST_STATUS });
			return;
		}

		voiceId = voiceId ? voiceId : ELEVEN_VOICE_ID;

		const chunks = text.match(/[\s\S]{1,1800}(?=\s|$)/g) || [text];

		io.to(room(lobbyId)).emit("narration:start", {
			speaker: playerName || "DM",
			streamId,
		});

		let cumulativeDuration = 0;
		let wordOffset = 0;

		for (let i = 0; i < chunks.length; i++) {
			const part = chunks[i].trim();
			if (!part) continue;
			let cleanText = part.replace(/\[[^\]]*\]/g, "").trim();
			if (!cleanText) {
				continue;
			}

			// Use with-timestamps endpoint for word-level alignment data
			const response = await fetch(
				`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream/with-timestamps`,
				{
					method: "POST",
					headers: {
						"xi-api-key": ELEVEN_API_KEY,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						text: cleanText,
						model_id: "eleven_flash_v2_5",
						voice_settings: { stability: 0.4, similarity_boost: 0.8 },
					}),
				}
			);

			if (!response.ok) {
				throw new Error(`TTS request failed: ${response.statusText}`);
			}

			// Response is newline-delimited JSON with audio_base64 and alignment fields
			const nodeStream = response.body instanceof PassThrough
				? response.body
				: response.body.pipe(new PassThrough());

			let audioBuffer = [];
			let jsonLine = "";
			let alignmentChars = null;
			const CHUNK_SIZE = 8 * 1024;

			await new Promise((resolve, reject) => {
				nodeStream.on("data", (rawChunk) => {
					jsonLine += rawChunk.toString();
					const lines = jsonLine.split("\n");
					jsonLine = lines.pop(); // keep incomplete tail

					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const obj = JSON.parse(line);
							if (obj.audio_base64) {
								const audioBuf = Buffer.from(obj.audio_base64, "base64");
								audioBuffer.push(audioBuf);
								const total = audioBuffer.reduce((s, b) => s + b.length, 0);
								if (total >= CHUNK_SIZE) {
									const combined = Buffer.concat(audioBuffer);
									io.to(room(lobbyId)).emit("narration:audio", {
										data: combined.toString("base64"),
										streamId,
									});
									audioBuffer = [];
								}
							}
							if (obj.alignment) {
								alignmentChars = obj.alignment;
							} else if (obj.normalizedAlignment && !alignmentChars) {
								alignmentChars = obj.normalizedAlignment;
							}
						} catch { /* skip malformed JSON lines */ }
					}
				});

				nodeStream.on("end", () => {
					// Process remaining partial JSON line
					if (jsonLine.trim()) {
						try {
							const obj = JSON.parse(jsonLine);
							if (obj.audio_base64) {
								audioBuffer.push(Buffer.from(obj.audio_base64, "base64"));
							}
							if (obj.alignment) alignmentChars = obj.alignment;
							else if (obj.normalizedAlignment && !alignmentChars) alignmentChars = obj.normalizedAlignment;
						} catch { /* ignore */ }
					}
					// Flush remaining audio
					if (audioBuffer.length > 0) {
						const combined = Buffer.concat(audioBuffer);
						io.to(room(lobbyId)).emit("narration:audio", {
							data: combined.toString("base64"),
							streamId,
						});
					}
					resolve();
				});

				nodeStream.on("error", reject);
			});

			// Emit word-level alignment data for this chunk
			if (alignmentChars) {
				const words = charAlignmentToWords(alignmentChars, cumulativeDuration, wordOffset);
				if (words.length > 0) {
					io.to(room(lobbyId)).emit("narration:alignment", { streamId, words });
					wordOffset += words.length;
					// Advance cumulative duration using the last character's end time
					const endTimes = alignmentChars.character_end_times_seconds;
					if (endTimes && endTimes.length > 0) {
						cumulativeDuration += endTimes[endTimes.length - 1];
					}
				}
			}

			if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 250));
		}

		io.to(room(lobbyId)).emit("narration:audio:end", { streamId });
	} catch (err) {
		console.error("💥 TTS Streaming Error:", err);
		io.to(lobbyId).emit("narration:audio:end", { streamId });
	}
}

// ===== ROUTE REGISTRATION =====

/**
 * Register ElevenLabs TTS HTTP routes on the Express application.
 *
 * Registers two routes:
 *   - `GET /api/voices`
 *       Returns a JSON array of available ElevenLabs voices, each trimmed to
 *       `{ id, name, category, accent, description }` for use in dropdowns.
 *       If ElevenLabs was unavailable at startup but an API key is now present,
 *       a single retry is attempted before responding. Responds with
 *       `{ ok: false }` if the service is still unavailable.
 *
 *   - `GET /api/voice-preview/:id`
 *       Streams an MP3 audio preview of the specified voice directly to the
 *       browser. Disabled in `devMode` (returns HTTP 204). The preview text is
 *       a fixed sample sentence synthesised via `eleven_multilingual_v2`.
 *
 * @param {object} app - Express application instance
 * @param {{ ELEVEN_API_KEY: string, VOICE_CACHE_FILE: string, devMode: boolean, serviceStatus: object, log: Function }} deps
 *   - `ELEVEN_API_KEY`   ElevenLabs API key used for route-level retries and previews
 *   - `VOICE_CACHE_FILE` Path to the local JSON cache written by `fetchVoices`
 *   - `devMode`          When true, voice-preview returns 204 with no audio
 *   - `serviceStatus`    Shared mutable object; `serviceStatus.elevenlabs` is
 *                        set to `true` if a startup-time failure is recovered
 *   - `log`              Application-level logging function
 * @returns {void}
 */
export function registerTTSRoutes(app, deps) {
	const { ELEVEN_API_KEY, devMode, serviceStatus, log } = deps;

	// === ELEVENLABS VOICE ENDPOINT ===
	app.get("/api/voices", async (req, res) => {
		// If ElevenLabs wasn't available at startup but we have a key, retry now
		// (Docker containers often have network delays at boot)
		if (!serviceStatus.elevenlabs && ELEVEN_API_KEY) {
			const retried = await fetchVoices(deps);
			if (retried.length) {
				serviceStatus.elevenlabs = true;
				log("✅ ElevenLabs recovered on retry — voices now available");
			} else {
				return res.json({ ok: false, voices: [], error: "ElevenLabs is not available" });
			}
		} else if (!serviceStatus.elevenlabs) {
			return res.json({ ok: false, voices: [], error: "ElevenLabs is not available" });
		}
		try {
			let voices = ELEVEN_VOICES;

			// if not already cached
			if (!voices || !voices.length) {
				voices = await fetchVoices(deps);
			}

			// Minimal payload for dropdown
			const list = voices.map(v => ({
				id: v.voice_id,
				name: v.name,
				category: v.category || "",
				accent: v.labels?.accent || "",
				description: v.description || "",
			}));

			res.json({ ok: true, voices: list });
		} catch (err) {
			console.error("💥 Failed to fetch voice list:", err);
			res.status(500).json({ ok: false, error: "Failed to fetch voices" });
		}
	});

	// === PREVIEW ENDPOINT (for play button) ===
	app.get("/api/voice-preview/:id", async (req, res) => {
		try {

			if (devMode) {
				res.status(204).json({ ok: true, message: "Voice preview disabled in dev mode." });
				return;
			}
			const voiceId = req.params.id;
			const text = "Greetings, traveler. I am the voice of your adventure.";

			const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
				method: "POST",
				headers: {
					"xi-api-key": ELEVEN_API_KEY,
					"Content-Type": "application/json",
					Accept: "audio/mpeg",
				},
				body: JSON.stringify({
					text,
					model_id: "eleven_multilingual_v2",
					voice_settings: { stability: 0.4, similarity_boost: 0.8 },
				}),
			});

			if (!r.ok) throw new Error(`Preview failed: ${r.statusText}`);

			// Stream audio directly to browser
			res.setHeader("Content-Type", "audio/mpeg");
			r.body.pipe(res);
		} catch (err) {
			console.error("💥 Error generating preview:", err);
			res.status(500).send("Preview unavailable");
		}
	});
}
