import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

// ── LLM I/O logger ────────────────────────────────────────────────────────
// Writes one JSONL entry per call to server/logs/llm-YYYY-MM-DD.jsonl
// Each entry: { ts, provider, model, messages (input), response (output), durationMs, error? }
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function _llmLogPath(lobbyId) {
	if (lobbyId) return path.join(LOG_DIR, `llm-${lobbyId}.jsonl`);
	const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	return path.join(LOG_DIR, `llm-${d}.jsonl`);
}

function _writeLLMLog(entry) {
	try {
		fs.appendFileSync(_llmLogPath(entry.lobbyId), JSON.stringify(entry) + "\n");
	} catch (err) {
		console.warn("⚠️ Failed to write LLM log:", err.message);
	}
}

// ── Test / stub responses for dev mode ──────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testResponses = JSON.parse(
	fs.readFileSync(path.join(__dirname, "..", "data", "testLLMResponses.json"), "utf-8")
);

// ── OpenAI ──────────────────────────────────────────────────────────────────
const openaiKey   = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || "gpt-4o";
const openaiClient = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

// ── Anthropic / Claude ───────────────────────────────────────────────────────
const claudeKey    = process.env.CLAUDE_API_KEY;
const claudeClient = claudeKey ? new Anthropic({ apiKey: claudeKey }) : null;

// ── Defaults from env ────────────────────────────────────────────────────────
const DEFAULT_PROVIDER = process.env.DEFAULT_LLM_PROVIDER || "openai";
const DEFAULT_MODEL    = process.env.DEFAULT_LLM_MODEL    || openaiModel;

export const OPENAI_NAME_MAX = 64;

export function hasLLM() {
	return !!(openaiClient || claudeClient);
}

export function hasOpenAI()  { return !!openaiClient; }
export function hasClaude()  { return !!claudeClient; }

export function getDefaultLLMSettings() {
	return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

/**
 * Validate API keys by making lightweight API calls.
 * Returns { openai: { ok, error? }, claude: { ok, error? } }
 */
export async function validateLLMKeys() {
	const results = { openai: { ok: false }, claude: { ok: false } };

	// Test OpenAI — list models (minimal call)
	if (openaiClient) {
		try {
			await openaiClient.models.list({ limit: 1 });
			results.openai.ok = true;
		} catch (err) {
			results.openai.error = err.message || String(err);
		}
	} else {
		results.openai.error = "No API key configured";
	}

	// Test Claude — send a tiny message
	if (claudeClient) {
		try {
			await claudeClient.messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 1,
				messages: [{ role: "user", content: "hi" }],
			});
			results.claude.ok = true;
		} catch (err) {
			// A 401/403 means the key is bad; other errors (rate limit, etc.) mean the key is valid
			const status = err?.status || err?.statusCode;
			if (status === 401 || status === 403) {
				results.claude.error = err.message || String(err);
			} else {
				// Key is valid, just hit a different error
				results.claude.ok = true;
			}
		}
	} else {
		results.claude.error = "No API key configured";
	}

	return results;
}

// ── Shared entry point ───────────────────────────────────────────────────────
export async function getLLMResponse(messages, { provider, model, lobbyId } = {}) {
	const resolvedProvider = provider || DEFAULT_PROVIDER;
	const resolvedModel    = model    || DEFAULT_MODEL;

	const t0 = Date.now();
	let response, error;
	try {
		if (resolvedProvider === "test") {
			response = await _testResponse(messages);
		} else if (resolvedProvider === "claude") {
			response = await _claudeResponse(messages, resolvedModel);
		} else {
			response = await _openaiResponse(messages, resolvedModel);
		}
		return response;
	} catch (err) {
		error = err.message || String(err);
		throw err;
	} finally {
		_writeLLMLog({
			ts: new Date().toISOString(),
			lobbyId: lobbyId || null,
			provider: resolvedProvider,
			model: resolvedModel,
			durationMs: Date.now() - t0,
			messages,
			response: response ?? null,
			...(error ? { error } : {}),
		});
	}
}

// ── OpenAI implementation ────────────────────────────────────────────────────
async function _openaiResponse(messages, model) {
	if (!openaiClient) return "[Stubbed LLM] No OpenAI key configured.";

	messages = _sanitizeNames(messages);
	const wantsJson = _wantsJson(messages);

	try {
		const options = { model, messages, temperature: 0.7 };
		if (wantsJson) options.response_format = { type: "json_object" };

		const res    = await openaiClient.chat.completions.create(options);
		const choice = res?.choices?.[0]?.message?.content;
		if (choice) console.log("🧩 [OpenAI] Content extracted");
		else        console.warn("⚠️ [OpenAI] No content in response");
		return choice ?? "[Error: no content returned]";
	} catch (err) {
		console.error("💥 [OpenAI] LLM call failed:", err);
		return "[Error: LLM unavailable or failed to respond]";
	}
}

// ── Claude implementation ────────────────────────────────────────────────────
async function _claudeResponse(messages, model) {
	if (!claudeClient) return "[Stubbed LLM] No Claude API key configured.";

	messages = _sanitizeNames(messages);

	// Claude separates system content from the messages array.
	// Collapse all system messages into a single system string.
	const systemParts = messages
		.filter(m => m.role === "system")
		.map(m => m.content)
		.filter(Boolean);
	const systemPrompt = systemParts.join("\n\n");

	// Only user/assistant messages go in the messages array; strip name field.
	const chatMessages = messages
		.filter(m => m.role === "user" || m.role === "assistant")
		.map(({ role, content }) => ({ role, content: content ?? "" }));

	// Claude requires at least one message
	if (!chatMessages.length) {
		chatMessages.push({ role: "user", content: "(begin)" });
	}

	try {
		const params = {
			model,
			max_tokens: 4096,
			messages: chatMessages,
		};
		if (systemPrompt) params.system = systemPrompt;

		const res  = await claudeClient.messages.create(params);
		let   text = res?.content?.[0]?.text ?? "";

		if (text) console.log("🧩 [Claude] Content extracted");
		else      console.warn("⚠️ [Claude] No content in response");
		return text || "[Error: no content returned]";
	} catch (err) {
		console.error("💥 [Claude] LLM call failed:", err);
		return "[Error: LLM unavailable or failed to respond]";
	}
}

// ── Test / stub implementation (dev mode) ───────────────────────────────────
const TEST_ADVENTURE_NAMES = [
	"Shadows of the Forgotten Keep",
	"The Ember Crown Prophecy",
	"Blood Beneath the Mountain",
	"Whispers in the Pale Wood",
	"The Last Light of Valdris",
];

async function _testResponse(messages) {
	const allContent = messages.map(m => m.content || "").join(" ");

	// Adventure name generation — return a plain title string
	if (allContent.includes("adventure title") || allContent.includes("naming a Dungeons")) {
		const name = TEST_ADVENTURE_NAMES[Math.floor(Math.random() * TEST_ADVENTURE_NAMES.length)];
		console.log("🧪 [Test LLM] Returning canned adventure name: %s", name);
		return name;
	}

	// Determine if this is a setup prompt or an action prompt
	const isSetup = allContent.includes("opening") || allContent.includes("introducing a new") || allContent.includes("opening scene");

	const pool = isSetup ? testResponses.setup : testResponses.action;
	const pick = pool[Math.floor(Math.random() * pool.length)];

	// For action responses, substitute __ACTIVE_PLAYER__ with the actual player name if available
	let json = JSON.stringify(pick);
	const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
	const playerName = lastUserMsg?.name || "Adventurer";
	json = json.replace(/__ACTIVE_PLAYER__/g, playerName);

	// hp new_total placeholders (0) — the server's JSON parser handles downstream logic
	console.log("🧪 [Test LLM] Returning canned response (setup=%s)", isSetup);
	return json;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _wantsJson(messages) {
	return messages.some(m => typeof m?.content === "string" && m.content.toLowerCase().includes("json"));
}

function _sanitizeNames(messages) {
	return (messages || []).map(m =>
		m && typeof m === "object"
			? { ...m, ...(m.name ? { name: sanitizeForLLMName(String(m.name)) } : {}) }
			: m
	);
}

// Returns a safe identifier for message names (OpenAI constraint)
export function sanitizeForLLMName(name) {
	if (!name || typeof name !== "string") return "Player";
	let s = name.normalize("NFKC");
	s = s.replace(/[\s<|\\/>"'\u0000-\u001F\u007F]/g, "_");
	s = s.replace(/[^\p{L}\p{N}_-]/gu, "_");
	s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	if (!s) s = "Player";
	return s.slice(0, OPENAI_NAME_MAX);
}

/**
 * Image models in descending order of capability.
 *
 * @description Tried in order, because a key that can *list* a model cannot always
 *   *call* it — access is granted per organisation, and the difference only shows up
 *   on a real request. Probed against this deployment's key: gpt-image-2 answered in
 *   22s, gpt-image-1.5 in 38s, gpt-image-1 in 36s.
 *
 *   dall-e-3 is last and is the reason this list exists. It was hardcoded, and the
 *   endpoint now rejects the `response_format` parameter the old call sent
 *   ("400 Unknown parameter: 'response_format'"), so every portrait had been failing.
 */
const IMAGE_MODELS = ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "dall-e-3"];

/** Remembered across calls so a working model is not re-discovered every time. */
let preferredImageModel = null;

/**
 * @description Builds the request body for one model. The gpt-image family always
 *   returns base64 and rejects `response_format`; dall-e-3 requires it.
 * @param {string} model - The model id.
 * @param {string} prompt - The finalised prompt.
 * @returns {object} Parameters for `images.generate`.
 */
function imageRequest(model, prompt) {
	const params = { model, prompt, n: 1, size: "1024x1024" };
	if (model.startsWith("dall-e")) params.response_format = "b64_json";
	return params;
}

/**
 * Generates a character portrait and returns it as base64 PNG data.
 *
 * @description Takes a finished prompt rather than a sheet, so that the text the
 *   player edited in the browser is the text that is actually sent. Callers build
 *   the default with `buildPortraitPrompt` and finalise it with `finalisePrompt`,
 *   both shared with the client.
 * @param {string} prompt - The finalised prompt.
 * @returns {Promise<{b64: string, model: string}>} The image and the model that made it.
 * @throws {Error} If no OpenAI client is configured, or every candidate model failed.
 */
export async function generateCharacterImage(prompt) {
	if (!openaiClient) throw new Error("No OpenAI client configured (missing OPENAI_API_KEY) — image generation requires OpenAI");
	if (typeof prompt !== "string" || !prompt.trim()) throw new Error("generateCharacterImage: prompt must be a non-empty string");

	// A model known to work goes first; the rest stay as fallbacks in case it is
	// withdrawn or starts refusing mid-session.
	const candidates = preferredImageModel
		? [preferredImageModel, ...IMAGE_MODELS.filter((m) => m !== preferredImageModel)]
		: IMAGE_MODELS;

	const failures = [];
	for (const model of candidates) {
		try {
			console.log(`🎨 Generating portrait with ${model}`);
			const response = await openaiClient.images.generate(imageRequest(model, prompt));
			const b64 = response?.data?.[0]?.b64_json;
			if (!b64) throw new Error("no image data in response");

			preferredImageModel = model;
			return { b64, model };
		} catch (err) {
			const reason = `${model}: ${err?.status ?? ""} ${err?.message ?? err}`.trim();
			console.warn(`⚠️ Portrait model unavailable — ${reason}`);
			failures.push(reason);
		}
	}

	throw new Error(`No image model would answer. Tried ${candidates.length}: ${failures.join(" | ")}`);
}
