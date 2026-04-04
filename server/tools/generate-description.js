#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Song Description Generator — LLM-Invokable Edition
 * ═══════════════════════════════════════════════════════════════════
 *
 * Uses Claude AI to generate a rich, ElevenLabs-optimized song
 * description for a given campaign theme and mood. The output is
 * designed to be piped directly into generate-song.js.
 *
 * ─── WORKFLOW ───────────────────────────────────────────────────
 *
 *   1. generate-description.js  →  produces a song prompt + tags
 *   2. generate-song.js         →  takes that prompt, calls ElevenLabs,
 *                                   writes the .mp3 to disk
 *
 *   Example (two-step, manual):
 *     node generate-description.js --theme "ancient japan" --mood "exploration"
 *     # Copy the "prompt" value from the JSON output, then:
 *     node generate-song.js --prompt "<the prompt from above>"
 *
 *   Example (piped together via an LLM or script):
 *     The calling LLM reads the JSON output from this tool, extracts
 *     the "prompt" field, and passes it as --prompt to generate-song.js.
 *
 * ─── ARGUMENTS ──────────────────────────────────────────────────
 *
 *   --api-key <key>       Claude (Anthropic) API key. Overrides env/.env.
 *   --theme <text>        Campaign world/setting theme (required).
 *                          Examples: "ancient japan", "dark fantasy",
 *                          "steampunk victorian", "ancient rome",
 *                          "lovecraftian horror", "wild west"
 *   --mood <text>         Musical mood/scene type (required).
 *                          Examples: "battle", "exploration", "tavern",
 *                          "mystery", "sad", "victory", "horror",
 *                          "peaceful", "boss_fight", "town"
 *   --duration <ms>       Intended track duration in ms (default: 120000).
 *                          This is passed to Claude so it can tailor the
 *                          song structure description appropriately.
 *   --dry-run             Show what would be sent to Claude, skip API call.
 *   --help, -h            Show this help message.
 *
 * ─── ENVIRONMENT ────────────────────────────────────────────────
 *
 *   CLAUDE_API_KEY        Fallback API key if --api-key is not provided.
 *                          Automatically loaded from .env files found in
 *                          the project directory or any parent directory.
 *
 * ─── OUTPUT FORMAT ──────────────────────────────────────────────
 *
 *   The final line of stdout is a JSON object:
 *
 *   {
 *     "success": true,
 *     "prompt": "A sweeping orchestral piece featuring...",
 *     "tags": ["epic", "orchestral", "battle", "brass", "japanese"],
 *     "title": "Winds of the Warring States",
 *     "mood": "battle",
 *     "theme": "ancient japan"
 *   }
 *
 *   The "prompt" field is ready to be passed directly to:
 *     node generate-song.js --prompt "<prompt value>"
 *
 *   The "tags" field contains keywords useful for categorizing,
 *   searching, or filtering the generated song in a music library.
 *
 * @usage
 *   node generate-description.js --theme "ancient japan" --mood "battle"
 *   node generate-description.js --theme "dark fantasy" --mood "tavern" --duration 180000
 *   node generate-description.js --api-key sk-ant-xxx --theme "sci-fi" --mood "exploration"
 *   node generate-description.js --theme "test" --mood "test" --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Constants ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_DURATION_MS = 120000;

// Load moods from the single source of truth
const MUSIC_MOODS_PATH = path.join(__dirname, '..', '..', 'client', 'config', 'music_moods.json');
const MUSIC_MOODS = JSON.parse(fs.readFileSync(MUSIC_MOODS_PATH, 'utf8')).moods;

/** Mood ID → keyword array, built from music_moods.json */
const MOOD_TAG_POOLS = {};
for (const m of MUSIC_MOODS) MOOD_TAG_POOLS[m.id] = m.keywords;

/** Alias → canonical mood ID, built from music_moods.json */
const MOOD_ALIASES = {};
for (const m of MUSIC_MOODS) {
	MOOD_ALIASES[m.id] = m.id;                       // direct match
	for (const alias of (m.aliases || [])) MOOD_ALIASES[alias] = m.id;
}

// ─── Logging ────────────────────────────────────────────────────

/**
 * Colourised, timestamped logging.
 * Every line has a full ISO timestamp and severity label for traceability.
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

/** Log an indented key-value detail line under the current step. */
function logDetail(key, value) {
	const dim = '\x1b[90m';
	const reset = '\x1b[0m';
	console.log(`${dim}                              ├─ ${key}:${reset} ${value}`);
}

/** Log a separator line for visual grouping. */
function logSeparator(char = '─', width = 60) {
	log('debug', char.repeat(width));
}

// ─── .env File Discovery ────────────────────────────────────────

/**
 * Search for a .env file starting from startDir and walking up
 * parent directories to the filesystem root.
 *
 * @param {string} startDir  Directory to start searching from
 * @return {string|null}     Absolute path to .env, or null if not found
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
		if (parent === dir || dir === root) break;
		dir = parent;
	}
	return null;
}

/**
 * Parse a .env file and load variables into process.env.
 * Existing env vars take precedence (are not overwritten).
 *
 * @param {string} envPath  Path to the .env file
 * @return {string[]}       Names of variables that were loaded
 */
function loadEnvFile(envPath) {
	const loaded = [];
	const content = fs.readFileSync(envPath, 'utf-8');

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;

		const [, key, rawValue] = match;
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
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @return {object}        Parsed options
 */
function parseArgs(argv) {
	const opts = {
		apiKey: null,
		theme: null,
		mood: null,
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
			case '--theme':
				opts.theme = argv[++i];
				break;
			case '--mood':
				opts.mood = argv[++i];
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

/** Print usage information and exit. */
function printHelp() {
	console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║    Song Description Generator — LLM-Invokable Edition     ║
  ╚═══════════════════════════════════════════════════════════╝

  Generates a detailed song description using Claude AI, ready
  to be passed to generate-song.js for audio generation.

  Usage:
    node generate-description.js --theme "ancient japan" --mood "battle"

  Arguments:
    --api-key <key>       Claude (Anthropic) API key (overrides .env)
    --theme <text>        Campaign world/setting (required)
    --mood <text>         Musical mood/scene type (required)
    --duration <ms>       Target track duration in ms (default: 120000)
    --dry-run             Show Claude prompt, skip API call
    --help, -h            Show this help message

  Environment:
    CLAUDE_API_KEY        Fallback API key if --api-key not provided.
                          Auto-loaded from .env in project/parent dirs.

  Recognized moods:
    battle, boss, tavern, exploration, mystery, sad, victory,
    horror, peaceful, dungeon, town
    (plus full names like tense_battle, peaceful_nature, etc.)

  Themes (free-form text, examples):
    "ancient japan", "dark fantasy", "steampunk victorian",
    "ancient rome", "lovecraftian horror", "wild west",
    "underwater civilization", "post-apocalyptic", "fairy tale"

  Pipeline example:
    1. node generate-description.js --theme "ancient japan" --mood "battle"
       → outputs JSON with "prompt" and "tags"
    2. node generate-song.js --prompt "<prompt from step 1>"
       → generates the .mp3 file
`);
}

// ─── Mood Resolution ────────────────────────────────────────────

/**
 * Resolve a user-provided mood string to a canonical mood key.
 * Tries exact match, alias lookup, then fuzzy substring match.
 *
 * @param {string} moodInput  The mood string from the user
 * @return {{ key: string, tags: string[] } | null}
 */
function resolveMood(moodInput) {
	const normalized = moodInput.toLowerCase().trim().replace(/[\s-]+/g, '_');

	// 1. Exact match on canonical keys
	if (MOOD_TAG_POOLS[normalized]) {
		return { key: normalized, tags: MOOD_TAG_POOLS[normalized] };
	}

	// 2. Alias lookup
	if (MOOD_ALIASES[normalized]) {
		const key = MOOD_ALIASES[normalized];
		return { key, tags: MOOD_TAG_POOLS[key] };
	}

	// 3. Fuzzy: check if input is a substring of any key or alias
	for (const [alias, key] of Object.entries(MOOD_ALIASES)) {
		if (alias.includes(normalized) || normalized.includes(alias)) {
			return { key, tags: MOOD_TAG_POOLS[key] };
		}
	}

	return null;
}

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate options and resolve defaults. Returns the final config
 * or throws with descriptive errors.
 *
 * @param {object} opts  Parsed CLI options
 * @return {object}      Validated configuration
 */
function validateAndResolve(opts) {
	const errors = [];

	// Theme is required
	if (!opts.theme || opts.theme.trim().length === 0) {
		errors.push('--theme is required (e.g., "ancient japan", "dark fantasy", "steampunk")');
	}

	// Mood is required
	if (!opts.mood || opts.mood.trim().length === 0) {
		errors.push('--mood is required (e.g., "battle", "tavern", "exploration", "sad")');
	}

	// Resolve API key: CLI arg > env var
	const apiKey = opts.apiKey || process.env.CLAUDE_API_KEY;
	if (!apiKey && !opts.dryRun) {
		errors.push(
			'Claude API key is required. Provide via --api-key, CLAUDE_API_KEY env var, or .env file'
		);
	}

	// Resolve mood to canonical key
	let moodKey = null;
	let moodTags = [];
	if (opts.mood) {
		const resolved = resolveMood(opts.mood);
		if (resolved) {
			moodKey = resolved.key;
			moodTags = resolved.tags;
		} else {
			// Not a recognized mood — that's OK, Claude can handle freeform moods.
			// We'll pass it through and let Claude interpret it, with an empty tag pool.
			log('warn', `Mood "${opts.mood}" is not a recognized preset — Claude will interpret it freely`);
			log('info', `Recognized moods: ${Object.keys(MOOD_TAG_POOLS).join(', ')}`);
			moodKey = opts.mood.toLowerCase().trim().replace(/[\s-]+/g, '_');
			moodTags = [];
		}
	}

	// Validate duration
	if (isNaN(opts.duration) || opts.duration < 3000 || opts.duration > 600000) {
		errors.push(`--duration must be between 3000 and 600000 ms (got: ${opts.duration})`);
	}

	if (errors.length > 0) {
		for (const err of errors) log('error', err);
		throw new Error(`Validation failed with ${errors.length} error(s)`);
	}

	return {
		apiKey,
		theme: opts.theme.trim(),
		mood: opts.mood.trim(),
		moodKey,
		moodTags,
		duration: opts.duration,
		dryRun: opts.dryRun,
	};
}

// ─── Claude Prompt Construction ─────────────────────────────────

/**
 * Build the system and user prompts for Claude to generate a song
 * description. The system prompt instructs Claude on the exact
 * output format and constraints. The user prompt provides the
 * specific theme, mood, and tag pool.
 *
 * @param {object} config  Validated configuration
 * @return {{ systemPrompt: string, userPrompt: string }}
 */
function buildClaudePrompts(config) {
	const { theme, mood, moodKey, moodTags, duration } = config;

	const durationSec = (duration / 1000).toFixed(0);

	const systemPrompt = `You are a creative music director specializing in generating detailed, \
ElevenLabs-optimized song descriptions for tabletop RPG campaigns.

Your job is to produce a JSON object with exactly three fields:

1. "prompt" (string, max 500 characters):
   A vivid, natural-language description of the desired song, optimized for the
   ElevenLabs Eleven Music AI generator. Be specific about:
   - Instruments (name specific ones, e.g., "shamisen", "war drums", "oud")
   - Tempo (give a BPM range or descriptive pace)
   - Dynamics (soft, building, aggressive, etc.)
   - Atmosphere and emotional quality
   - Structure hints (e.g., "builds from sparse to full", "steady-state energy")
   The description must be culturally and thematically consistent with the
   campaign setting provided. Do NOT use generic fantasy tropes unless the
   theme calls for it — lean hard into the specific cultural/historical flavor.

2. "title" (string, max 80 characters):
   An evocative, thematic track title that fits the campaign world. Use language,
   imagery, or references appropriate to the setting. Avoid generic names like
   "Battle Theme" — be creative and specific.

3. "tags" (array of 8-15 strings):
   Keywords that describe the song for search and categorization. Include:
   - 5-8 tags from the provided mood tag pool (if any)
   - 3-5 additional descriptive tags of your own (instruments, cultural style,
     tempo descriptor, energy level, etc.)
   Tags should be lowercase, single words or short hyphenated phrases.

CRITICAL RULES:
- Do NOT reference any real bands, artists, or copyrighted songs.
- The song MUST be INSTRUMENTAL (no vocals, no lyrics, no singing).
- The song should be designed for LOOPING — the beginning and ending should have
  similar energy so a crossfade loop sounds natural. Avoid fade-ins from silence
  or fade-outs to nothing.
- The song is ${durationSec} seconds long — tailor the structural description accordingly.
- Lean HARD into the cultural/thematic flavor of the campaign setting.
  "Ancient Japan" → use Japanese instruments, scales, and musical traditions.
  "Ancient Rome" → use period-appropriate instruments and Mediterranean modes.
  "Steampunk" → blend Victorian-era instruments with mechanical textures.

Respond ONLY with a valid JSON object. No markdown fences, no explanation, no extra text.
{"prompt":"...","title":"...","tags":[...]}`;

	const tagPoolSection = moodTags.length > 0
		? `\nAvailable mood tag pool (pick 5-8 that fit): ${JSON.stringify(moodTags)}`
		: '\nNo preset tag pool — generate all tags from scratch based on the mood and theme.';

	const userPrompt = `Generate a song description for:

Campaign theme/setting: "${theme}"
Scene mood: "${mood}" (canonical mood category: "${moodKey}")
Target duration: ${durationSec} seconds (${duration} ms)
${tagPoolSection}

Remember:
- Instrumental only, no vocals
- Loop-friendly structure (start and end at similar energy)
- Culturally authentic to "${theme}"
- Emotionally fitting for a "${mood}" scene`;

	return { systemPrompt, userPrompt };
}

// ─── Claude API ─────────────────────────────────────────────────

/**
 * Call the Claude API to generate a song description.
 *
 * @param {string} apiKey        Anthropic API key
 * @param {string} systemPrompt  System instructions for Claude
 * @param {string} userPrompt    User message with theme/mood details
 * @return {Promise<{ prompt: string, title: string, tags: string[] }>}
 */
async function callClaude(apiKey, systemPrompt, userPrompt) {
	const url = `${CLAUDE_BASE_URL}/v1/messages`;

	const requestBody = {
		model: CLAUDE_MODEL,
		max_tokens: 600,
		temperature: 1.0,
		system: systemPrompt,
		messages: [{ role: 'user', content: userPrompt }],
	};

	log('step', '>>> Sending request to Claude API...');
	logDetail('Endpoint', url);
	logDetail('Model', CLAUDE_MODEL);
	logDetail('Max tokens', '600');
	logDetail('Temperature', '1.0');

	const startTime = Date.now();

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify(requestBody),
	});

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	if (!res.ok) {
		const body = await res.text();
		log('error', `Claude API responded with HTTP ${res.status} after ${elapsed}s`);

		let detail = body;
		try {
			const parsed = JSON.parse(body);
			if (parsed?.error?.message) {
				detail = parsed.error.message;
			}
		} catch { /* use raw body */ }

		log('error', `API error detail: ${detail}`);
		throw new Error(`Claude API error ${res.status}: ${detail}`);
	}

	log('success', `Claude API responded with HTTP ${res.status} after ${elapsed}s`);

	const data = await res.json();

	// Log usage info if available
	if (data.usage) {
		logDetail('Input tokens', data.usage.input_tokens);
		logDetail('Output tokens', data.usage.output_tokens);
	}

	// Extract text content from Claude's response
	const text = data.content
		.filter(b => b.type === 'text')
		.map(b => b.text)
		.join('');

	log('debug', `Raw Claude response (${text.length} chars): ${text.slice(0, 200)}...`);

	// Parse the JSON response — strip markdown fences if Claude added them
	const cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();

	let parsed;
	try {
		parsed = JSON.parse(cleaned);
	} catch (parseErr) {
		log('error', `Failed to parse Claude response as JSON: ${parseErr.message}`);
		log('error', `Cleaned text was: ${cleaned}`);
		throw new Error(`Claude returned invalid JSON: ${parseErr.message}`);
	}

	// Validate expected fields
	if (!parsed.prompt || typeof parsed.prompt !== 'string') {
		throw new Error('Claude response missing "prompt" string field');
	}
	if (!parsed.title || typeof parsed.title !== 'string') {
		throw new Error('Claude response missing "title" string field');
	}
	if (!Array.isArray(parsed.tags)) {
		throw new Error('Claude response missing "tags" array field');
	}

	// Enforce prompt length limit
	if (parsed.prompt.length > 500) {
		log('warn', `Prompt is ${parsed.prompt.length} chars (max 500) — truncating`);
		parsed.prompt = parsed.prompt.slice(0, 500);
	}

	return {
		prompt: parsed.prompt,
		title: parsed.title,
		tags: parsed.tags.map(t => String(t).toLowerCase().trim()),
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
	log('info', '  Song Description Generator — LLM-Invokable Edition');
	log('info', '═══════════════════════════════════════════════════════════');
	console.log('');

	// ── Step 1: Load environment ──
	log('step', '>>> Step 1/4: Loading environment configuration...');

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

	// ── Step 2: Validate inputs ──
	log('step', '>>> Step 2/4: Validating inputs...');

	let config;
	try {
		config = validateAndResolve(opts);
	} catch (err) {
		log('error', err.message);
		log('info', 'Run with --help for usage information');
		process.exit(1);
	}

	logDetail('API Key', config.apiKey ? `${config.apiKey.slice(0, 12)}...${config.apiKey.slice(-4)} (${config.apiKey.length} chars)` : '(dry-run, not required)');
	logDetail('Theme', config.theme);
	logDetail('Mood (input)', config.mood);
	logDetail('Mood (resolved)', config.moodKey);
	logDetail('Tag pool', config.moodTags.length > 0 ? `[${config.moodTags.join(', ')}]` : '(none — freeform)');
	logDetail('Duration', `${config.duration} ms (${(config.duration / 1000).toFixed(1)}s)`);
	logDetail('Dry run', config.dryRun ? 'YES' : 'no');

	log('success', 'All inputs validated');
	console.log('');

	// ── Step 3: Build prompts and call Claude ──
	log('step', '>>> Step 3/4: Generating song description via Claude...');

	const { systemPrompt, userPrompt } = buildClaudePrompts(config);

	log('debug', '── System prompt ──');
	log('debug', systemPrompt.slice(0, 300) + '...');
	log('debug', '── User prompt ──');
	log('debug', userPrompt);
	console.log('');

	if (config.dryRun) {
		log('warn', 'DRY RUN — skipping Claude API call');
		log('info', 'The following would have been sent to Claude:');
		console.log('');
		console.log('=== SYSTEM PROMPT ===');
		console.log(systemPrompt);
		console.log('');
		console.log('=== USER PROMPT ===');
		console.log(userPrompt);
		console.log('');
		log('success', 'Dry run complete — no API call was made');

		const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
		log('info', `Total elapsed time: ${totalTime}s`);
		process.exit(0);
	}

	let result;
	try {
		result = await callClaude(config.apiKey, systemPrompt, userPrompt);
	} catch (err) {
		console.log('');
		log('error', '═══════════════════════════════════════════════════════════');
		log('error', `  Description generation FAILED: ${err.message}`);
		log('error', '═══════════════════════════════════════════════════════════');
		process.exit(1);
	}

	console.log('');

	// ── Step 4: Display results ──
	log('step', '>>> Step 4/4: Description generated successfully!');
	logSeparator('═', 59);

	const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

	log('success', `Title: "${result.title}"`);
	log('success', `Prompt (${result.prompt.length} chars):`);
	console.log('');
	console.log(`    ${result.prompt}`);
	console.log('');
	log('success', `Tags (${result.tags.length}): [${result.tags.join(', ')}]`);
	logDetail('Theme', config.theme);
	logDetail('Mood', `${config.mood} → ${config.moodKey}`);
	logDetail('Total time', `${totalTime}s`);

	logSeparator('═', 59);
	console.log('');

	log('info', 'To generate this song as audio, run:');
	log('info', `  node generate-song.js --prompt "${result.prompt.replace(/"/g, '\\"')}"`);
	console.log('');

	// Final line: clean JSON for LLM parsing
	const summary = {
		success: true,
		prompt: result.prompt,
		tags: result.tags,
		title: result.title,
		mood: config.moodKey,
		theme: config.theme,
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
