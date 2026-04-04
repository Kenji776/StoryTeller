// === SFX Service ===
// Matches LLM sound-effect descriptions to the local sfx-library.json using
// token-overlap scoring.  When no match meets the threshold, generates a new
// effect via the ElevenLabs Sound Generation API, saves it to disk, and
// updates the library JSON so future requests can reuse it.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SFX_DIR      = path.join(__dirname, "..", "..", "client", "sfx", "game");
const LIBRARY_PATH = path.join(__dirname, "..", "..", "client", "config", "sfx-library.json");

// Minimum tag-overlap score required to consider a library effect a match.
const MIN_MATCH_SCORE = 1;

// ---------------------------------------------------------------------------
// Library helpers
// ---------------------------------------------------------------------------

let _library = null;

/**
 * Reads and parses the sfx-library.json file from disk, storing the result in
 * the module-level `_library` cache.  On any read or parse failure the cache is
 * initialised to an empty library so callers always receive a usable object.
 *
 * @returns {{ categories: Object.<string, string[]>, effects: Array<Object> }}
 *   The parsed SFX library, or an empty library stub on error.
 */
function loadLibrary() {
	try {
		_library = JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf-8"));
	} catch (err) {
		console.warn("⚠️ SFX library load failed:", err.message);
		_library = { categories: {}, effects: [] };
	}
	return _library;
}

/**
 * Returns the in-memory SFX library, loading it from disk on the first call
 * (lazy initialisation via {@link loadLibrary}).
 *
 * @returns {{ categories: Object.<string, string[]>, effects: Array<Object> }}
 *   The cached (or freshly loaded) SFX library object.
 */
function getLibrary() {
	if (!_library) loadLibrary();
	return _library;
}

/**
 * Serialises the current in-memory `_library` to sfx-library.json using
 * tab indentation.  Errors are logged but not re-thrown so that a failed
 * save does not crash an in-progress generation request.
 *
 * @returns {void}
 */
function saveLibrary() {
	try {
		fs.writeFileSync(LIBRARY_PATH, JSON.stringify(_library, null, "\t"), "utf-8");
	} catch (err) {
		console.error("💥 Failed to save SFX library:", err.message);
	}
}

// ---------------------------------------------------------------------------
// Tokenise an LLM description into lowercase words for matching
// ---------------------------------------------------------------------------

/**
 * Converts a free-text string into an array of lowercase alphanumeric tokens
 * suitable for tag-overlap scoring.  Punctuation (except hyphens) is stripped
 * and both whitespace and hyphens are treated as word boundaries.
 *
 * @param {string} text - The raw text to tokenise (e.g. an LLM description or
 *   an effect name).
 * @returns {string[]} Array of lowercase word tokens with empty strings removed.
 */
function tokenize(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.split(/[\s-]+/)
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Find best matching effect for a description string
// ---------------------------------------------------------------------------

/**
 * Searches the SFX library for the effect whose tags and name best match the
 * given description using a token-overlap scoring algorithm:
 *
 *  1. The description is tokenised into lowercase words via {@link tokenize}.
 *  2. Each library effect's `tags` array is lowercased and merged with the
 *     tokens derived from the effect's `name`, forming a deduplicated `allTags`
 *     set for that effect.
 *  3. For every description token the score is incremented as follows:
 *     - **+1.0** for an exact match against any tag in `allTags`.
 *     - **+0.5** for a partial/substring match (either the token contains a tag
 *       or a tag contains the token), enabling compound phrases like "war cry"
 *       to partially match a "warcry" tag.
 *  4. The effect with the highest cumulative score is selected, provided that
 *     score meets or exceeds `MIN_MATCH_SCORE` (currently 1).
 *
 * @param {string} description - A natural-language SFX description produced by
 *   the LLM (e.g. "thunderous sword clash").
 * @returns {{ name: string, file: string, tags: string[] } | null}
 *   The best-matching library effect object, or `null` if no effect scores at
 *   or above the minimum threshold.
 */
function findMatch(description) {
	const lib    = getLibrary();
	const tokens = tokenize(description);
	if (!tokens.length) return null;

	let bestScore = 0;
	let best      = null;

	for (const effect of lib.effects) {
		const tags  = (effect.tags || []).map(t => t.toLowerCase());
		// Also match against the effect name tokens
		const nameTokens = tokenize(effect.name);
		const allTags = [...new Set([...tags, ...nameTokens])];

		let score = 0;
		for (const tok of tokens) {
			if (allTags.includes(tok)) score += 1;
			// Partial / substring matching for compound tags like "war cry"
			else if (allTags.some(t => t.includes(tok) || tok.includes(t))) score += 0.5;
		}

		if (score > bestScore) {
			bestScore = score;
			best      = effect;
		}
	}

	return bestScore >= MIN_MATCH_SCORE ? best : null;
}

// ---------------------------------------------------------------------------
// Resolve a list of LLM sfx descriptions → file paths (matching or generating)
// ---------------------------------------------------------------------------

/**
 * Resolves an array of LLM-provided SFX descriptions to playable audio files.
 *
 * For each description (up to a maximum of three):
 *  1. {@link findMatch} is called to check the local sfx-library.json.  If a
 *     match is found its file path and display name are added to the results.
 *  2. If no match is found and an ElevenLabs API key is provided, the effect is
 *     generated via {@link generateSfx}, persisted to disk, added to the
 *     library, and its entry is appended to the results.
 *  3. If no match and no API key are available the description is silently
 *     skipped (a warning is logged).
 *
 * @param {string[]} descriptions - Array of natural-language SFX descriptions
 *   from the LLM.  Non-string or blank entries are ignored.
 * @param {string | undefined} elevenApiKey - ElevenLabs API key used to call
 *   the Sound Generation endpoint.  Pass `undefined` to disable generation.
 * @returns {Promise<Array<{ file: string, name: string }>>}
 *   Resolves to an array of objects each containing the relative `file` name
 *   (usable as a client-side audio src) and a human-readable `name`.
 */
export async function resolveSfx(descriptions, elevenApiKey) {
	if (!Array.isArray(descriptions) || !descriptions.length) return [];

	const results = [];

	for (const desc of descriptions.slice(0, 3)) {
		if (typeof desc !== "string" || !desc.trim()) continue;

		const match = findMatch(desc);
		if (match) {
			console.log(`🔊 SFX matched "${desc}" → ${match.file}`);
			results.push({ file: match.file, name: match.name });
			continue;
		}

		// No match — try to generate via ElevenLabs
		if (!elevenApiKey) {
			console.warn(`🔊 SFX no match for "${desc}" and no ElevenLabs key — skipping`);
			continue;
		}

		try {
			const generated = await generateSfx(desc, elevenApiKey);
			if (generated) {
				results.push({ file: generated.file, name: generated.name });
			}
		} catch (err) {
			console.error(`💥 SFX generation failed for "${desc}":`, err.message);
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Generate a new SFX via ElevenLabs Sound Generation API
// ---------------------------------------------------------------------------

/**
 * Calls the ElevenLabs Sound Generation API to synthesise a 3-second audio
 * clip from the given description, saves the resulting MP3 to the local SFX
 * directory, and registers a new entry in the in-memory library (persisted via
 * {@link saveLibrary}).
 *
 * The prompt sent to the API is prefixed with "A sound effect of " to improve
 * generation quality.  The saved filename is a URL-safe slug derived from the
 * description combined with a short time-based unique suffix to avoid
 * collisions.  Tags are built from the description tokens plus any category
 * tags from the library whose strings overlap with the description tokens.
 *
 * @param {string} description - A natural-language SFX description
 *   (e.g. "crackling campfire").
 * @param {string} apiKey - A valid ElevenLabs API key with Sound Generation
 *   access.
 * @returns {Promise<{ name: string, file: string, tags: string[], _generated: Object }>}
 *   Resolves to the newly created library entry object.
 * @throws {Error} If the ElevenLabs API returns a non-OK HTTP status.
 */
async function generateSfx(description, apiKey) {
	const prompt = `A sound effect of ${description}`;
	console.log(`🔊 Generating SFX: "${prompt}"`);

	const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
		method: "POST",
		headers: {
			"xi-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			text: prompt,
			duration_seconds: 3,
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ElevenLabs SFX API ${res.status}: ${body}`);
	}

	// Save the audio to disk
	const buffer   = Buffer.from(await res.arrayBuffer());
	const slug     = description.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
	const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	const filename = `${slug}_${uniqueId}.mp3`;
	const filepath = path.join(SFX_DIR, filename);

	fs.writeFileSync(filepath, buffer);
	console.log(`🔊 SFX saved: ${filename} (${buffer.length} bytes)`);

	// Build tags from the description tokens + infer category tags
	const tokens = tokenize(description);
	const lib    = getLibrary();
	const categoryTags = [];
	for (const [, catTags] of Object.entries(lib.categories || {})) {
		for (const ct of catTags) {
			if (tokens.some(t => t === ct || ct.includes(t) || t.includes(ct))) {
				categoryTags.push(ct);
			}
		}
	}
	const tags = [...new Set([...tokens, ...categoryTags])];

	// Friendly display name
	const name = description
		.split(/\s+/)
		.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(" ");

	const entry = {
		name,
		file: filename,
		tags,
		_generated: {
			prompt,
			durationSec: 3,
			generatedAt: new Date().toISOString(),
		},
	};

	lib.effects.push(entry);
	saveLibrary();

	return entry;
}

export { findMatch, loadLibrary, getLibrary };
