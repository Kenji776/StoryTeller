#!/usr/bin/env node

/**
 * generate-world-music.js
 * Batch generates songs for a campaign world by chaining
 * generate-description.js → generate-song.js for each mood.
 *
 * Usage:
 *   node generate-world-music.js --world ancient_egypt
 *   node generate-world-music.js --world pirate --moods "tavern,battle"
 *   node generate-world-music.js --world scifi --dry-run
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load moods from the single source of truth
const MUSIC_MOODS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'config', 'music_moods.json'), 'utf8')).moods;
const ALL_MOODS = MUSIC_MOODS.map(m => m.id);

// Theme descriptions for each world setting (what Claude needs for cultural context)
const WORLD_THEMES = {
	standard:              'standard high fantasy with kingdoms, dungeons, elves, dwarves, and magic',
	dark_ages:             'dark ages low fantasy, harsh medieval Europe with scarce magic and brutal survival',
	steampunk:             'steampunk Victorian magitech with clockwork machinery and arcane factories',
	pirate:                'golden age of piracy with treasure maps, naval battles, and Caribbean island ports',
	scifi:                 'sci-fi fantasy hybrid with ancient tech ruins, spaceships, laser swords, and alien worlds',
	ancient_egypt:         'ancient Egypt with pharaoh-sorcerers, pyramid tombs, cursed relics, and hieroglyphic magic',
	ancient_rome:          'ancient Rome with legions, gladiatorial arenas, senators, and Olympian deities',
	warring_states_japan:  'Sengoku-era feudal Japan with samurai clans, shinobi, bushido honor, and yokai spirits',
	prehistory:            'prehistoric primal world with megafauna, tribal shamans, and primordial wilderness',
	renaissance:           'Renaissance Europe with merchant princes, alchemists, inquisitors, and city-state intrigue',
};

const MUSIC_DIR = path.join(__dirname, '..', '..', 'client', 'music', 'game');

function parseArgs(argv) {
	const opts = { world: null, moods: null, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--world': opts.world = argv[++i]; break;
			case '--moods': opts.moods = argv[++i].split(',').map(s => s.trim()); break;
			case '--dry-run': opts.dryRun = true; break;
		}
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (!opts.world || !WORLD_THEMES[opts.world]) {
		console.error(`Usage: node generate-world-music.js --world <world>`);
		console.error(`Available worlds: ${Object.keys(WORLD_THEMES).join(', ')}`);
		process.exit(1);
	}

	const theme = WORLD_THEMES[opts.world];
	const moods = opts.moods || ALL_MOODS;
	const descScript = path.join(__dirname, 'generate-description.js');
	const songScript = path.join(__dirname, 'generate-song.js');

	console.log(`\n🌍 Generating ${moods.length} songs for world: ${opts.world}`);
	console.log(`   Theme: "${theme}"\n`);

	let generated = 0;
	let failed = 0;

	for (const mood of moods) {
		console.log(`\n${'═'.repeat(60)}`);
		console.log(`🎵 [${generated + failed + 1}/${moods.length}] ${opts.world} / ${mood}`);
		console.log(`${'═'.repeat(60)}\n`);

		try {
			// Step 1: Generate description via Claude
			console.log(`📝 Generating description for mood: ${mood}...`);
			const descCmd = `node "${descScript}" --theme "${theme}" --mood "${mood}"`;

			if (opts.dryRun) {
				console.log(`   [DRY RUN] Would run: ${descCmd}`);
				generated++;
				continue;
			}

			const descOutput = execSync(descCmd, {
				encoding: 'utf8',
				timeout: 60000,
				cwd: __dirname,
			});

			// Parse the JSON summary from the last line
			const lines = descOutput.trim().split('\n');
			const jsonLine = lines[lines.length - 1];
			const desc = JSON.parse(jsonLine);

			if (!desc.success || !desc.prompt) {
				throw new Error('Description generation failed — no prompt returned');
			}

			console.log(`   ✅ Title: "${desc.title}"`);
			console.log(`   📝 Prompt: ${desc.prompt.slice(0, 100)}...`);

			// Step 2: Generate the song via ElevenLabs
			// Build a clean filename from the title
			const safeName = desc.title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_|_$/g, '')
				.slice(0, 50);
			const outputFile = path.join(MUSIC_DIR, opts.world, mood, `${mood}_${safeName}.mp3`);

			console.log(`\n🔊 Generating audio...`);
			console.log(`   Output: ${outputFile}`);

			const songCmd = `node "${songScript}" --prompt "${desc.prompt.replace(/"/g, '\\"')}" --output "${outputFile}"`;
			execSync(songCmd, {
				encoding: 'utf8',
				timeout: 300000, // 5 min timeout for audio generation
				stdio: 'inherit',
				cwd: __dirname,
			});

			generated++;
			console.log(`\n   ✅ Song ${generated}/${moods.length} complete!`);

		} catch (err) {
			failed++;
			console.error(`\n   ❌ Failed: ${err.message}`);
			console.error(`   Continuing to next mood...\n`);
		}
	}

	console.log(`\n${'═'.repeat(60)}`);
	console.log(`🏁 Done! Generated: ${generated}, Failed: ${failed}`);
	console.log(`   Output: ${path.join(MUSIC_DIR, opts.world, '/')}`);
	console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
	console.error(`Fatal: ${err.message}`);
	process.exit(1);
});
