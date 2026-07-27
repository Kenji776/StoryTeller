/**
 * WAV inspection and approximate word timing.
 *
 * The local TTS server returns a complete PCM WAV and no alignment data, where
 * ElevenLabs streams per-character timings. Rather than lose word highlighting on
 * the local provider, the exact clip duration is recovered from the WAV header and
 * spread across the words in proportion to their length. It is an approximation —
 * it cannot know that "the" is spoken faster than "extraordinary" beyond their
 * character counts — but it tracks well enough to follow prose, and it costs one
 * pass over a header we already have in hand.
 */

/** Bytes required before a RIFF/WAVE container can even be identified. */
const RIFF_PREAMBLE_BYTES = 12;

/** Bytes of chunk descriptor (4-byte id + 4-byte little-endian size). */
const CHUNK_HEADER_BYTES = 8;

/**
 * Reads the format and data chunks out of a RIFF/WAVE buffer.
 *
 * @description Walks the chunk list rather than assuming the canonical 44-byte
 *   layout, because encoders are free to emit `LIST`, `fact`, or padding chunks
 *   ahead of `data`. Duration is derived from the declared byte rate, which stays
 *   correct for any sample rate, channel count, or bit depth the server might
 *   switch to later.
 * @param {Buffer} buffer - Complete WAV file contents.
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number, byteRate: number, dataBytes: number, durationSeconds: number}}
 *   The parsed header fields and the clip duration in seconds.
 * @throws {TypeError} If `buffer` is not a Buffer.
 * @throws {Error} If the buffer is too short, is not a RIFF/WAVE container, is
 *   missing the `fmt ` or `data` chunk, or declares a zero byte rate.
 */
export function parseWavHeader(buffer) {
	if (!Buffer.isBuffer(buffer)) {
		throw new TypeError(`parseWavHeader expects a Buffer, received ${typeof buffer}`);
	}
	if (buffer.length < RIFF_PREAMBLE_BYTES) {
		throw new Error(`WAV buffer too short: ${buffer.length} bytes, need at least ${RIFF_PREAMBLE_BYTES}`);
	}
	if (buffer.toString("ascii", 0, 4) !== "RIFF") {
		throw new Error("Not a WAV file: missing RIFF marker");
	}
	if (buffer.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("Not a WAV file: missing WAVE marker");
	}

	let fmt = null;
	let dataBytes = null;

	let offset = RIFF_PREAMBLE_BYTES;
	while (offset + CHUNK_HEADER_BYTES <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + CHUNK_HEADER_BYTES;

		if (id === "fmt " && body + 16 <= buffer.length) {
			fmt = {
				channels: buffer.readUInt16LE(body + 2),
				sampleRate: buffer.readUInt32LE(body + 4),
				byteRate: buffer.readUInt32LE(body + 8),
				bitsPerSample: buffer.readUInt16LE(body + 14),
			};
		} else if (id === "data") {
			// Trust the declared size only as far as the buffer actually goes — a
			// truncated download would otherwise report a duration it cannot play.
			dataBytes = Math.min(size, Math.max(0, buffer.length - body));
		}

		// Chunk bodies are word-aligned: an odd size carries one pad byte.
		offset = body + size + (size % 2);
	}

	if (!fmt) throw new Error("Malformed WAV: no 'fmt ' chunk found");
	if (dataBytes === null) throw new Error("Malformed WAV: no 'data' chunk found");
	if (!fmt.byteRate) throw new Error("Malformed WAV: byte rate is zero");

	return { ...fmt, dataBytes, durationSeconds: dataBytes / fmt.byteRate };
}

/**
 * Spreads a known clip duration across the words of the spoken text.
 *
 * @description Emits the same `{word, start, end, index}` shape ElevenLabs
 *   alignment is converted to, so the client highlighter needs no knowledge of
 *   which provider produced it. Word splitting deliberately mirrors
 *   `wrapNarrationWords` in `client/app.js`: bracketed stage directions are
 *   skipped, because they are never spoken and never wrapped in an indexed span.
 *   Keeping both splits identical is what makes `index` line up with the DOM.
 *   Time is apportioned by character count, so longer words hold the highlight
 *   longer.
 * @param {string} text - The text that was synthesised, brackets optional.
 * @param {number} durationSeconds - Clip length from `parseWavHeader`.
 * @param {{timeOffset?: number, indexOffset?: number}} [opts] - Cumulative offsets
 *   from previously synthesised chunks of the same narration.
 * @returns {Array<{word: string, start: number, end: number, index: number}>}
 *   Word timings, or an empty array when there is nothing to highlight.
 * @throws {TypeError} If `text` is not a string.
 */
export function estimateWordTimings(text, durationSeconds, opts = {}) {
	if (typeof text !== "string") {
		throw new TypeError(`estimateWordTimings expects a string, received ${typeof text}`);
	}
	const { timeOffset = 0, indexOffset = 0 } = opts;

	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

	const spoken = text.replace(/\[[^\]]*\]/g, " ");
	const words = spoken.split(/\s+/).filter(Boolean);
	if (!words.length) return [];

	const totalChars = words.reduce((sum, w) => sum + w.length, 0);
	const timings = [];
	let cursor = timeOffset;

	for (let i = 0; i < words.length; i++) {
		const share = (words[i].length / totalChars) * durationSeconds;
		// The last word absorbs any rounding drift so the run always ends exactly
		// on the clip duration; a highlight that stops short looks like a stall.
		const end = i === words.length - 1 ? timeOffset + durationSeconds : cursor + share;
		timings.push({ word: words[i], start: cursor, end, index: indexOffset + i });
		cursor = end;
	}

	return timings;
}
