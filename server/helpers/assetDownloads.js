import fs from "fs";
import path from "path";
import readline from "readline";
import fetch from "node-fetch";
import { pipeline } from "stream/promises";
import { execSync } from "child_process";

let MUSIC_DIR, SFX_DIR, log;

/**
 * Initialises the module with the required directory paths and logger.
 * Must be called once before any `ensure*` function is used.
 *
 * @param {object} opts - Configuration options.
 * @param {string} opts.musicDir - Absolute path to the root music assets directory.
 * @param {string} opts.sfxDir   - Absolute path to the root SFX assets directory.
 * @param {Function} opts.log   - Logger function used for status and error messages.
 * @returns {void}
 */
export function configure(opts) {
	MUSIC_DIR = opts.musicDir;
	SFX_DIR = opts.sfxDir;
	log = opts.log;
}

/**
 * Asset pack definitions. Each entry describes one downloadable asset pack
 * with all the metadata needed by the generic `ensureAsset` function.
 */
const ASSET_PACKS = {
	music: {
		emoji: "🎵",
		label: "music files",
		noun: "tracks",
		getDir: () => path.join(MUSIC_DIR, "game", "default"),
		zipUrl: "https://github.com/Kenji776/StoryTeller/releases/download/resource/music.zip",
		zipName: "music.zip",
		getZipDir: () => MUSIC_DIR,
		recursive: true,
	},
	sfx: {
		emoji: "🔊",
		label: "sound effects",
		noun: "effects",
		getDir: () => path.join(SFX_DIR, "game"),
		zipUrl: "https://github.com/Kenji776/StoryTeller/releases/download/sfx/sfx.zip",
		zipName: "sfx.zip",
		getZipDir: () => SFX_DIR,
		recursive: true,
	},
	menuMusic: {
		emoji: "🎶",
		label: "menu music",
		noun: "tracks",
		getDir: () => path.join(MUSIC_DIR, "menu"),
		zipUrl: "https://github.com/Kenji776/StoryTeller/releases/download/menu-music/menu-music.zip",
		zipName: "menu-music.zip",
		getZipDir: () => MUSIC_DIR,
		recursive: false,
	},
	uiSfx: {
		emoji: "🔔",
		label: "UI sound effects",
		noun: "effects",
		getDir: () => path.join(SFX_DIR, "ui"),
		zipUrl: "https://github.com/Kenji776/StoryTeller/releases/download/ui-sfx/ui-sfx.zip",
		zipName: "ui-sfx.zip",
		getZipDir: () => SFX_DIR,
		recursive: false,
	},
};

/**
 * Generic asset download function. Checks whether the target directory already
 * contains MP3 files; if not, prompts the user (TTY) or auto-downloads (non-TTY)
 * a zip pack from the given URL, extracts it, and cleans up.
 *
 * @param {object} pack - An entry from ASSET_PACKS describing the asset to ensure.
 * @returns {Promise<void>}
 */
async function ensureAsset(pack) {
	const targetDir = pack.getDir();
	const readOpts = pack.recursive ? { recursive: true } : undefined;
	const hasMp3s = fs.existsSync(targetDir) && fs.readdirSync(targetDir, readOpts).some(f => String(f).endsWith(".mp3"));
	if (hasMp3s) return;

	if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

	if (process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise(resolve => {
			rl.question(`${pack.emoji} No ${pack.label} found. Download the standard ${pack.label} library? (y/n): `, resolve);
		});
		rl.close();

		if (answer.trim().toLowerCase() !== "y") {
			log(`⏭️  Skipping ${pack.label} download.`);
			log(`   You can manually place MP3 files in: ${targetDir}`);
			return;
		}
	} else {
		log(`${pack.emoji} No ${pack.label} found. Non-interactive environment detected — downloading automatically...`);
	}

	const zipPath = path.join(pack.getZipDir(), pack.zipName);

	log(`${pack.emoji} Downloading ${pack.label} pack...`);
	log(`   ${pack.zipUrl}`);

	try {
		const res = await fetch(pack.zipUrl);
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

		await pipeline(res.body, fs.createWriteStream(zipPath));
		log(`${pack.emoji} Download complete. Extracting...`);

		execSync(`unzip -o "${zipPath}" -d "${targetDir}"`);
		fs.unlinkSync(zipPath);

		const readOpts = pack.recursive ? { recursive: true } : undefined;
		const count = fs.readdirSync(targetDir, readOpts).filter(f => String(f).endsWith(".mp3")).length;
		log(`${pack.emoji} ${pack.label.charAt(0).toUpperCase() + pack.label.slice(1)} ready — ${count} ${pack.noun} extracted.`);
	} catch (err) {
		log(`❌ ${pack.label.charAt(0).toUpperCase() + pack.label.slice(1)} download failed: ${err.message}`);
		log(`   You can manually download ${pack.zipName} from:`);
		log(`   ${pack.zipUrl}`);
		log(`   and extract the MP3 files into: ${targetDir}`);
		if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
	}
}

/** Ensures in-game background music is present. @returns {Promise<void>} */
export function ensureMusic()     { return ensureAsset(ASSET_PACKS.music); }
/** Ensures in-game sound effects are present. @returns {Promise<void>} */
export function ensureSfx()       { return ensureAsset(ASSET_PACKS.sfx); }
/** Ensures menu background music is present. @returns {Promise<void>} */
export function ensureMenuMusic() { return ensureAsset(ASSET_PACKS.menuMusic); }
/** Ensures UI sound effects are present. @returns {Promise<void>} */
export function ensureUiSfx()     { return ensureAsset(ASSET_PACKS.uiSfx); }
