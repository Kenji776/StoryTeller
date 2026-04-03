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

function loadLibrary() {
	try {
		_library = JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf-8"));
	} catch (err) {
		console.warn("⚠️ SFX library load failed:", err.message);
		_library = { categories: {}, effects: [] };
	}
	return _library;
}

function getLibrary() {
	if (!_library) loadLibrary();
	return _library;
}

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
