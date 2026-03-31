import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

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
export async function getLLMResponse(messages, { provider, model } = {}) {
	const resolvedProvider = provider || DEFAULT_PROVIDER;
	const resolvedModel    = model    || DEFAULT_MODEL;

	if (resolvedProvider === "claude") {
		return _claudeResponse(messages, resolvedModel);
	}
	return _openaiResponse(messages, resolvedModel);
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
 * Generate a character portrait image via DALL-E 3.
 * Returns the raw base64 PNG string.
 */
export async function generateCharacterImage(sheet) {
	if (!openaiClient) throw new Error("No OpenAI client configured (missing OPENAI_API_KEY) — image generation requires OpenAI");

	const { race, class: cls, gender, age, height, weight, description } = sheet || {};

	const traits = [
		race && cls ? `${race} ${cls}` : (race || cls || "adventurer"),
		gender,
		[age && `${age} years old`, height, weight].filter(Boolean).join(", "),
		description || null,
	].filter(Boolean).join(", ");

	const prompt = `IMPORTANT: absolutely no text, letters, words, numbers, labels, captions, name tags, scrolls with writing, or any written characters anywhere in the image. `
		+ `A detailed fantasy character portrait: ${traits}. `
		+ `Epic fantasy art style, dramatic lighting, richly detailed painterly illustration, full body dramatic pose. `
		+ `Pure illustration only — no text overlays, no UI elements, no written words of any kind.`;

	console.log("Generating image using prompt: " + prompt);
	const response = await openaiClient.images.generate({
		model: "dall-e-3",
		prompt,
		n: 1,
		size: "1024x1024",
		response_format: "b64_json",
	});

	return response.data[0].b64_json;
}
