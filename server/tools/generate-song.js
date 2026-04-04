#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════
 *  ElevenLabs Song Generator — LLM-Invokable Edition
 * ═══════════════════════════════════════════════════════════════════
 *
 * A streamlined music generation script designed to be easily called
 * by an LLM or any automated pipeline. No interactive prompts — all
 * parameters are passed via CLI arguments or environment variables.
 *
 * @usage
 *   # Minimal — uses .env for API key, defaults for output
 *   node generate-song.js --prompt "A peaceful Celtic harp melody with gentle rain"
 *
 *   # Full control
 *   node generate-song.js \
 *     --api-key "sk_your_key_here" \
 *     --prompt "Epic orchestral battle music with brass and timpani" \
 *     --output "./output/battle_theme.mp3" \
 *     --duration 180000
 *
 *   # Dry run — validate inputs without calling the API
 *   node generate-song.js --prompt "Test prompt" --dry-run
 *
 *   # With metadata (from generate-description.js output)
 *   node generate-song.js \
 *     --prompt "Thundering taiko drums..." \
 *     --title "Winds of the Warring States" \
 *     --mood "battle"
 *
 * @arguments
 *   --api-key <key>       ElevenLabs API key (overrides .env / env var)
 *   --prompt <text>       Music generation prompt (required)
 *   --title <text>        Song title — written to the MP3 ID3 tag (optional)
 *   --mood <text>         Mood/genre — written to the MP3 ID3 tag (optional)
 *   --output <path>       Output file path (default: ./output/<timestamp>.mp3)
 *   --duration <ms>       Track duration in milliseconds (default: 120000, range: 3000-600000)
 *   --dry-run             Validate inputs and log what would happen, skip API call
 *   --help                Show this help message
 *
 * @env
 *   ELEVENLABS_API_KEY    Fallback API key (auto-loaded from .env files)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// ─── Constants ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
const MAX_PROMPT_CHARS = 4100;
const MIN_DURATION_MS = 3000;
const MAX_DURATION_MS = 600000;
const DEFAULT_DURATION_MS = 120000;
const DEFAULT_OUTPUT_DIR = 'output';

// ─── Logging ────────────────────────────────────────────────────

/**
 * Log levels with ANSI colours and severity labels.
 * Every log line includes an ISO timestamp for traceability.
 */
const LOG_COLOURS = {
	info:    '\x1b[36m',   // cyan
	success: '\x1b[32m',   // green
	warn:    '\x1b[33m',   // yellow
	error:   '\x1b[31m',   // red
	debug:   '\x1b[90m',   // dim grey
	step:    '\x1b[35m',   // magenta
};

const LOG_LABELS = {
	info:    'INFO   ',
	success: 'OK     ',
	warn:    'WARN   ',
	error:   'ERROR  ',
	debug:   'DEBUG  ',
	step:    'STEP   ',
};

function log(level, ...args) {
	const colour = LOG_COLOURS[level] ?? '';
	const label = LOG_LABELS[level] ?? level.toUpperCase().padEnd(7);
	const reset = '\x1b[0m';
	const dim = '\x1b[90m';
	const ts = new Date().toISOString();
	console.log(`${dim}[${ts}]${reset} ${colour}${label}${reset}`, ...args);
}

/**
 * Log a key-value detail line, indented for readability under a step.
 */
function logDetail(key, value) {
	const dim = '\x1b[90m';
	const reset = '\x1b[0m';
	console.log(`${dim}                              ├─ ${key}:${reset} ${value}`);
}

/**
 * Log a separator line for visual grouping.
 */
function logSeparator(char = '─', width = 60) {
	log('debug', char.repeat(width));
}

// ─── .env File Discovery ────────────────────────────────────────

/**
 * Search for a .env file starting from startDir and walking up to
 * the filesystem root. Returns the first .env path found, or null.
 *
 * @param {string} startDir  Directory to start searching from
 * @return {string|null}     Absolute path to .env, or null
 */
function findEnvFile(startDir) {
	let dir = path.resolve(startDir);
	const root = path.parse(dir).root;

	while (true) {
		const candidate = path.join(dir, '.env');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir || dir === root) {
			break;
		}
		dir = parent;
	}
	return null;
}

/**
 * Parse a .env file and load its variables into process.env.
 * Only sets variables that are not already defined (env vars take precedence).
 *
 * @param {string} envPath  Path to the .env file
 * @return {string[]}       List of variable names that were loaded
 */
function loadEnvFile(envPath) {
	const loaded = [];
	const content = fs.readFileSync(envPath, 'utf-8');

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		// Skip comments and empty lines
		if (!trimmed || trimmed.startsWith('#')) continue;

		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;

		const [, key, rawValue] = match;
		// Strip surrounding quotes if present
		const value = rawValue.replace(/^["']|["']$/g, '');

		if (process.env[key] === undefined) {
			process.env[key] = value;
			loaded.push(key);
		}
	}
	return loaded;
}

// ─── Argument Parsing ───────────────────────────────────────────

/**
 * Parse CLI arguments into a structured options object.
 * Supports --key value and --flag forms.
 *
 * @param {string[]} argv  Raw process.argv.slice(2)
 * @return {object}        Parsed options
 */
function parseArgs(argv) {
	const opts = {
		apiKey: null,
		prompt: null,
		title: null,
		mood: null,
		output: null,
		duration: DEFAULT_DURATION_MS,
		dryRun: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--api-key':
				opts.apiKey = argv[++i];
				break;
			case '--prompt':
				opts.prompt = argv[++i];
				break;
			case '--title':
				opts.title = argv[++i];
				break;
			case '--mood':
				opts.mood = argv[++i];
				break;
			case '--output':
				opts.output = argv[++i];
				break;
			case '--duration':
				opts.duration = parseInt(argv[++i], 10);
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--help':
			case '-h':
				opts.help = true;
				break;
			default:
				log('warn', `Unknown argument: ${arg}`);
				break;
		}
	}

	return opts;
}

/**
 * Print usage information and exit.
 */
function printHelp() {
	console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║       ElevenLabs Song Generator — LLM-Invokable          ║
  ╚═══════════════════════════════════════════════════════════╝

  Usage:
    node generate-song.js --prompt "Your music description"

  Arguments:
    --api-key <key>       ElevenLabs API key (overrides .env / env var)
    --prompt <text>       Music generation prompt (required)
    --title <text>        Song title — embedded in the MP3 as an ID3 tag
    --mood <text>         Mood/genre — embedded in the MP3 as an ID3 tag
    --output <path>       Output file path (default: ./output/<timestamp>.mp3)
    --duration <ms>       Track duration in ms (default: 120000, range: 3000-600000)
    --dry-run             Validate inputs, skip API call
    --help, -h            Show this help message

  Metadata (ID3 tags):
    When --title and/or --mood are provided, they are written into the
    MP3 file as ID3v2.3 tags so media players display the song info:
      --title  →  TIT2 (Title)
      --mood   →  TCON (Genre) and TALB (Album)
    The generation prompt is always saved as a COMM (Comment) tag.

  Environment:
    ELEVENLABS_API_KEY    Fallback API key if --api-key not provided.
                          Automatically loaded from .env in project or parent dirs.

  Examples:
    node generate-song.js --prompt "Gentle piano lullaby with soft strings"
    node generate-song.js --prompt "Epic battle drums" --output ./songs/battle.mp3
    node generate-song.js --prompt "Jazz cafe" --title "Midnight at the Café" --mood "tavern"
    node generate-song.js --api-key sk_xxx --prompt "Jazz cafe" --duration 180000
`);
}

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate all options and resolve defaults. Returns the final
 * config object or throws with a descriptive error.
 *
 * @param {object} opts  Parsed CLI options
 * @return {object}      Validated and resolved configuration
 */
function validateAndResolve(opts) {
	const errors = [];

	// Prompt is required and must respect ElevenLabs character limit
	if (!opts.prompt || opts.prompt.trim().length === 0) {
		errors.push('--prompt is required and must not be empty');
	} else if (opts.prompt.trim().length > MAX_PROMPT_CHARS) {
		log('warn', `Prompt is ${opts.prompt.trim().length} chars (max ${MAX_PROMPT_CHARS}) — truncating`);
		opts.prompt = opts.prompt.trim().slice(0, MAX_PROMPT_CHARS);
	}

	// Resolve API key: CLI arg > env var
	const apiKey = opts.apiKey || process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
	if (!apiKey && !opts.dryRun) {
		errors.push(
			'ElevenLabs API key is required. Provide via --api-key, ELEVENLABS_API_KEY env var, or .env file'
		);
	}

	// Validate duration
	if (isNaN(opts.duration) || opts.duration < MIN_DURATION_MS || opts.duration > MAX_DURATION_MS) {
		errors.push(
			`--duration must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS} ms (got: ${opts.duration})`
		);
	}

	// Resolve output path
	let outputPath = opts.output;
	if (!outputPath) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const safePrompt = opts.prompt
			? opts.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
			: 'song';
		outputPath = path.join(DEFAULT_OUTPUT_DIR, `${safePrompt}_${timestamp}.mp3`);
	}

	// Ensure output path ends with .mp3
	if (!outputPath.toLowerCase().endsWith('.mp3')) {
		outputPath += '.mp3';
	}

	if (errors.length > 0) {
		for (const err of errors) {
			log('error', err);
		}
		throw new Error(`Validation failed with ${errors.length} error(s)`);
	}

	return {
		apiKey,
		prompt: opts.prompt.trim(),
		title: opts.title ? opts.title.trim() : null,
		mood: opts.mood ? opts.mood.trim() : null,
		outputPath: path.resolve(outputPath),
		duration: opts.duration,
		dryRun: opts.dryRun,
	};
}

// ─── ID3v2.3 Tag Writer (zero dependencies) ────────────────────

/**
 * Write ID3v2.3 metadata tags into an existing MP3 file.
 *
 * This is a minimal, zero-dependency implementation that prepends an
 * ID3v2.3 header to the MP3 data. It supports the following frames:
 *   - TIT2 (Title)        ← from --title
 *   - TCON (Genre)        ← from --mood
 *   - TALB (Album)        ← from --mood (so mood shows in album field too)
 *   - TPE1 (Artist)       ← always "ElevenLabs AI"
 *   - COMM (Comment)      ← the generation prompt
 *   - TDRC (Year)         ← current year
 *
 * The function reads the existing MP3, prepends the ID3 header, and
 * writes it back. If the file already has an ID3v2 header, it is
 * stripped and replaced.
 *
 * @param {string} filePath          Path to the MP3 file
 * @param {object} metadata          Tag values to write
 * @param {string} [metadata.title]  Song title (TIT2)
 * @param {string} [metadata.mood]   Mood/genre (TCON + TALB)
 * @param {string} [metadata.prompt] Generation prompt (COMM)
 */
function writeId3Tags(filePath, metadata) {
	log('step', '>>> Writing ID3v2.3 metadata tags...');

	let mp3Data = fs.readFileSync(filePath);

	// Strip existing ID3v2 header if present (starts with "ID3")
	if (mp3Data[0] === 0x49 && mp3Data[1] === 0x44 && mp3Data[2] === 0x33) {
		// ID3v2 header is 10 bytes; size is stored in bytes 6-9 as synchsafe integer
		const size = (mp3Data[6] << 21) | (mp3Data[7] << 14) | (mp3Data[8] << 7) | mp3Data[9];
		const headerEnd = 10 + size;
		log('debug', `Stripping existing ID3v2 header (${headerEnd} bytes)`);
		mp3Data = mp3Data.subarray(headerEnd);
	}

	// Build ID3v2.3 text frames
	const frames = [];

	/**
	 * Create an ID3v2.3 text frame (e.g., TIT2, TPE1, TALB, TCON, TDRC).
	 * Format: 4-byte frame ID + 4-byte size + 2-byte flags + 1-byte encoding + UTF-8 string
	 */
	function addTextFrame(frameId, text) {
		if (!text) return;
		const textBuf = Buffer.from(text, 'utf-8');
		// Frame data = 1 byte encoding (0x03 = UTF-8) + text bytes
		const frameDataSize = 1 + textBuf.length;
		const frame = Buffer.alloc(10 + frameDataSize);
		// Frame ID (4 bytes)
		frame.write(frameId, 0, 4, 'ascii');
		// Frame size (4 bytes, big-endian, NOT synchsafe in ID3v2.3)
		frame.writeUInt32BE(frameDataSize, 4);
		// Flags (2 bytes, all zero)
		frame.writeUInt16BE(0, 8);
		// Encoding byte: 0x03 = UTF-8
		frame[10] = 0x03;
		// Text content
		textBuf.copy(frame, 11);
		frames.push(frame);
		logDetail(frameId, text.length > 80 ? text.slice(0, 77) + '...' : text);
	}

	/**
	 * Create an ID3v2.3 comment frame (COMM).
	 * Format: 4-byte "COMM" + 4-byte size + 2-byte flags +
	 *         1-byte encoding + 3-byte language + null-terminated description + text
	 */
	function addCommentFrame(text, description = '') {
		if (!text) return;
		const descBuf = Buffer.from(description, 'utf-8');
		const textBuf = Buffer.from(text, 'utf-8');
		// Frame data = encoding(1) + lang(3) + description + null(1) + text
		const frameDataSize = 1 + 3 + descBuf.length + 1 + textBuf.length;
		const frame = Buffer.alloc(10 + frameDataSize);
		frame.write('COMM', 0, 4, 'ascii');
		frame.writeUInt32BE(frameDataSize, 4);
		frame.writeUInt16BE(0, 8);
		// Encoding: UTF-8
		frame[10] = 0x03;
		// Language: "eng"
		frame.write('eng', 11, 3, 'ascii');
		// Description (can be empty) + null terminator
		descBuf.copy(frame, 14);
		frame[14 + descBuf.length] = 0x00;
		// Comment text
		textBuf.copy(frame, 14 + descBuf.length + 1);
		frames.push(frame);
		logDetail('COMM', text.length > 80 ? text.slice(0, 77) + '...' : text);
	}

	// Populate frames
	if (metadata.title)  addTextFrame('TIT2', metadata.title);
	if (metadata.mood) {
		addTextFrame('TCON', metadata.mood);
		addTextFrame('TALB', metadata.mood);
	}
	addTextFrame('TPE1', 'ElevenLabs AI');
	addTextFrame('TDRC', new Date().getFullYear().toString());
	if (metadata.prompt) addCommentFrame(metadata.prompt, 'Generation Prompt');

	if (frames.length === 0) {
		log('debug', 'No metadata to write — skipping ID3 tags');
		return;
	}

	// Calculate total frame data size
	const allFrames = Buffer.concat(frames);
	const totalFrameSize = allFrames.length;

	// Build ID3v2.3 header (10 bytes)
	// "ID3" + version 2.3 + no flags + synchsafe size
	const header = Buffer.alloc(10);
	header.write('ID3', 0, 3, 'ascii');
	header[3] = 0x03; // Version major: 3
	header[4] = 0x00; // Version minor: 0
	header[5] = 0x00; // Flags: none
	// Size as synchsafe integer (4 bytes, 7 bits per byte)
	header[6] = (totalFrameSize >> 21) & 0x7F;
	header[7] = (totalFrameSize >> 14) & 0x7F;
	header[8] = (totalFrameSize >> 7) & 0x7F;
	header[9] = totalFrameSize & 0x7F;

	// Concatenate: ID3 header + frames + original MP3 data
	const finalFile = Buffer.concat([header, allFrames, mp3Data]);

	fs.writeFileSync(filePath, finalFile);

	const addedBytes = header.length + allFrames.length;
	log('success', `ID3v2.3 tags written (${frames.length} frames, ${addedBytes} bytes added)`);
}

// ─── ElevenLabs Music API ───────────────────────────────────────

/**
 * Generate an instrumental music track via the ElevenLabs Music API
 * and stream the MP3 result to disk.
 *
 * @param {object} config         Validated configuration
 * @param {string} config.apiKey  ElevenLabs API key
 * @param {string} config.prompt  Music generation prompt
 * @param {number} config.duration  Track duration in ms
 * @param {string} config.outputPath  Destination file path
 * @return {Promise<{filePath: string, fileSizeBytes: number, durationMs: number}>}
 */
async function generateMusic(config) {
	const { apiKey, prompt, duration, outputPath } = config;

	// Ensure output directory exists
	const outputDir = path.dirname(outputPath);
	if (!fs.existsSync(outputDir)) {
		log('info', `Creating output directory: ${outputDir}`);
		fs.mkdirSync(outputDir, { recursive: true });
	}

	// Build request
	const url = new URL(`${ELEVENLABS_BASE_URL}/v1/music`);
	url.searchParams.set('output_format', 'mp3_44100_192');

	const requestBody = {
		prompt: prompt,
		music_length_ms: duration,
		force_instrumental: true,
	};

	log('step', '>>> Sending request to ElevenLabs Music API...');
	logDetail('Endpoint', url.toString());
	logDetail('Prompt', prompt);
	logDetail('Duration', `${duration} ms (${(duration / 1000).toFixed(1)}s)`);
	logDetail('Output format', 'MP3 44100Hz 192kbps');
	logDetail('Instrumental', 'true');

	const startTime = Date.now();

	const res = await fetch(url.toString(), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'xi-api-key': apiKey,
		},
		body: JSON.stringify(requestBody),
	});

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	if (!res.ok) {
		const body = await res.text();
		log('error', `API responded with HTTP ${res.status} after ${elapsed}s`);
		log('debug', `Response headers: ${JSON.stringify(Object.fromEntries(res.headers))}`);

		// Try to extract structured error info
		let detail = body;
		try {
			const parsed = JSON.parse(body);
			if (parsed?.detail?.status === 'bad_prompt' && parsed?.detail?.data?.prompt_suggestion) {
				detail = `Copyright/content issue. Suggested prompt: "${parsed.detail.data.prompt_suggestion}"`;
				log('warn', `The API rejected the prompt. Suggestion: "${parsed.detail.data.prompt_suggestion}"`);
			} else if (parsed?.detail?.message) {
				detail = parsed.detail.message;
			} else if (typeof parsed?.detail === 'string') {
				detail = parsed.detail;
			}
		} catch { /* use raw body */ }

		log('error', `API error detail: ${detail}`);
		throw new Error(`ElevenLabs API error ${res.status}: ${detail}`);
	}

	log('success', `API responded with HTTP ${res.status} after ${elapsed}s`);
	log('info', `Content-Type: ${res.headers.get('content-type')}`);
	const contentLength = res.headers.get('content-length');
	if (contentLength) {
		log('info', `Content-Length: ${contentLength} bytes (${(parseInt(contentLength) / 1024).toFixed(1)} KB)`);
	}

	// Stream the audio response to disk
	log('step', `>>> Streaming audio to: ${outputPath}`);
	const fileStream = fs.createWriteStream(outputPath);

	try {
		await pipeline(Readable.fromWeb(res.body), fileStream);
	} catch (streamErr) {
		log('error', `Failed to write audio stream to disk: ${streamErr.message}`);
		// Clean up partial file
		if (fs.existsSync(outputPath)) {
			fs.unlinkSync(outputPath);
			log('debug', 'Cleaned up partial output file');
		}
		throw streamErr;
	}

	// Verify the output file
	if (!fs.existsSync(outputPath)) {
		throw new Error(`Output file was not created: ${outputPath}`);
	}

	const stats = fs.statSync(outputPath);
	if (stats.size === 0) {
		fs.unlinkSync(outputPath);
		throw new Error('Output file is empty (0 bytes) — removed');
	}

	return {
		filePath: outputPath,
		fileSizeBytes: stats.size,
		durationMs: duration,
	};
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
	const startTime = Date.now();
	const argv = process.argv.slice(2);
	const opts = parseArgs(argv);

	// Help
	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	// Banner
	console.log('');
	log('info', '═══════════════════════════════════════════════════════════');
	log('info', '  ElevenLabs Song Generator — LLM-Invokable Edition');
	log('info', '═══════════════════════════════════════════════════════════');
	console.log('');

	// Step 1: Discover and load .env file
	log('step', '>>> Step 1/5: Loading environment configuration...');

	const envFile = findEnvFile(__dirname);
	if (envFile) {
		const loaded = loadEnvFile(envFile);
		log('success', `Found .env file: ${envFile}`);
		if (loaded.length > 0) {
			log('info', `Loaded ${loaded.length} variable(s): ${loaded.join(', ')}`);
		} else {
			log('debug', 'All .env variables were already set in environment');
		}
	} else {
		log('debug', 'No .env file found in project directory or parents');
	}

	// Step 2: Validate inputs
	log('step', '>>> Step 2/5: Validating inputs...');

	let config;
	try {
		config = validateAndResolve(opts);
	} catch (err) {
		log('error', err.message);
		log('info', 'Run with --help for usage information');
		process.exit(1);
	}

	logDetail('API Key', config.apiKey ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)} (${config.apiKey.length} chars)` : '(dry-run, not required)');
	logDetail('Prompt', config.prompt);
	logDetail('Prompt length', `${config.prompt.length} chars`);
	logDetail('Title', config.title ?? '(not provided)');
	logDetail('Mood', config.mood ?? '(not provided)');
	logDetail('Duration', `${config.duration} ms (${(config.duration / 1000).toFixed(1)}s)`);
	logDetail('Output path', config.outputPath);
	logDetail('Dry run', config.dryRun ? 'YES' : 'no');

	log('success', 'All inputs validated');
	console.log('');

	// Step 3: Generate music
	log('step', '>>> Step 3/5: Generating music...');

	if (config.dryRun) {
		log('warn', 'DRY RUN — skipping ElevenLabs API call');
		log('info', 'The following request would have been sent:');
		logDetail('Endpoint', `${ELEVENLABS_BASE_URL}/v1/music?output_format=mp3_44100_192`);
		logDetail('Method', 'POST');
		logDetail('Body', JSON.stringify({
			prompt: config.prompt,
			music_length_ms: config.duration,
			force_instrumental: true,
		}, null, 2));
		console.log('');
		log('success', 'Dry run complete — no API call was made');

		const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
		log('info', `Total elapsed time: ${totalTime}s`);
		process.exit(0);
	}

	let result;
	try {
		result = await generateMusic(config);
	} catch (err) {
		console.log('');
		log('error', '═══════════════════════════════════════════════════════════');
		log('error', `  Generation FAILED: ${err.message}`);
		log('error', '═══════════════════════════════════════════════════════════');
		process.exit(1);
	}

	console.log('');

	// Step 4: Write ID3 metadata tags
	log('step', '>>> Step 4/5: Writing MP3 metadata...');

	const hasMetadata = config.title || config.mood || config.prompt;
	if (hasMetadata) {
		try {
			writeId3Tags(result.filePath, {
				title: config.title,
				mood: config.mood,
				prompt: config.prompt,
			});
			// Re-read file size after ID3 tags were prepended
			result.fileSizeBytes = fs.statSync(result.filePath).size;
		} catch (tagErr) {
			// ID3 failure is non-fatal — the MP3 audio is still valid
			log('warn', `Failed to write ID3 tags (non-fatal): ${tagErr.message}`);
			log('debug', tagErr.stack);
		}
	} else {
		log('debug', 'No --title or --mood provided — skipping ID3 tags');
	}

	console.log('');

	// Step 5: Summary
	log('step', '>>> Step 5/5: Generation complete!');
	logSeparator('═', 59);

	const fileSizeKb = (result.fileSizeBytes / 1024).toFixed(1);
	const fileSizeMb = (result.fileSizeBytes / (1024 * 1024)).toFixed(2);
	const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

	log('success', `File saved: ${result.filePath}`);
	logDetail('File size', `${fileSizeKb} KB (${fileSizeMb} MB)`);
	logDetail('Duration', `${result.durationMs} ms (${(result.durationMs / 1000).toFixed(1)}s)`);
	if (config.title) logDetail('Title (ID3)', config.title);
	if (config.mood)  logDetail('Mood (ID3)', config.mood);
	logDetail('Total time', `${totalTime}s`);

	logSeparator('═', 59);
	console.log('');

	// Output a clean JSON summary on the last line for easy LLM parsing
	const summary = {
		success: true,
		filePath: result.filePath,
		fileSizeBytes: result.fileSizeBytes,
		durationMs: result.durationMs,
		prompt: config.prompt,
		title: config.title ?? null,
		mood: config.mood ?? null,
		elapsedSeconds: parseFloat(totalTime),
	};
	console.log(JSON.stringify(summary));
}

main().catch(err => {
	log('error', `Fatal unhandled error: ${err.message}`);
	if (err.stack) {
		log('debug', err.stack);
	}
	process.exit(1);
});
