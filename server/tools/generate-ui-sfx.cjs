#!/usr/bin/env node
/**
 * generate-ui-sfx.js
 * Reads ui-sfx-library.json, finds any effects missing an audio file,
 * and generates them via the ElevenLabs Sound Generation API.
 *
 * Usage:  node server/tools/generate-ui-sfx.js [--key YOUR_KEY]
 *         Or set ELEVENLABS_API_KEY env var.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const LIBRARY_PATH = path.join(__dirname, "../../client/config/ui-sfx-library.json");
const OUTPUT_DIR = path.join(__dirname, "../../client/sfx/ui");
const API_URL = "https://api.elevenlabs.io/v1/sound-generation";

function getApiKey() {
	const argIdx = process.argv.indexOf("--key");
	if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
	if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
	console.error("No API key. Pass --key <key> or set ELEVENLABS_API_KEY.");
	process.exit(1);
}

function generateSfx(apiKey, prompt, durationSec = 2) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({
			text: prompt,
			duration_seconds: durationSec,
			prompt_influence: 0.4,
		});

		const url = new URL(API_URL);
		const options = {
			hostname: url.hostname,
			path: url.pathname,
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		};

		const req = https.request(options, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				if (res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode}: ${buf.toString("utf8").slice(0, 500)}`));
				} else {
					resolve(buf);
				}
			});
		});

		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

async function main() {
	const apiKey = getApiKey();
	const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf8"));

	if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	for (const effect of library.effects) {
		const filePath = path.join(OUTPUT_DIR, effect.file);

		// Skip if file already exists
		if (fs.existsSync(filePath)) {
			console.log(`✅ ${effect.name} — already exists (${effect.file})`);
			continue;
		}

		if (!effect.prompt) {
			console.log(`⏭️  ${effect.name} — no prompt, skipping`);
			continue;
		}

		console.log(`🔊 Generating "${effect.name}"...`);
		console.log(`   Prompt: ${effect.prompt.slice(0, 100)}...`);

		try {
			const audio = await generateSfx(apiKey, effect.prompt, 2);
			fs.writeFileSync(filePath, audio);

			// Update the library entry with generation metadata
			effect._generated = {
				prompt: effect.prompt,
				durationSec: 2,
				generatedAt: new Date().toISOString(),
			};

			console.log(`   ✅ Saved ${effect.file} (${(audio.length / 1024).toFixed(1)} KB)`);
		} catch (err) {
			console.error(`   ❌ Failed: ${err.message}`);
		}
	}

	// Write back updated library with generation metadata
	fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, "\t") + "\n");
	console.log("\n📝 Updated ui-sfx-library.json");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
