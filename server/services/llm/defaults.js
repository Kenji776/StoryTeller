/**
 * What provider and model a brand-new lobby starts on.
 *
 * A small module of its own because two things need it — `LobbyStore.create` and
 * `getLLMSettings` — and its previous home, `services/llmService.js`, has been
 * retired. Which provider a lobby *may* use is a policy question answered by
 * `services/credentials/`; this is only the value a lobby is stamped with before
 * anyone has chosen.
 *
 * The default provider id is canonical. `DEFAULT_LLM_PROVIDER=claude` in an
 * existing deployment still works, because `llmGateway` aliases the old id, but
 * a new lobby is stamped with the name the registry actually uses.
 *
 * **Where the fallback comes from.** It used to be a hardcoded `gpt-4o`, which
 * meant an unconfigured deployment started every lobby on whatever model happened
 * to be current when that line was written. It now comes from the bake-off's
 * recommendation in `client/config/model_ratings.json` — the best measured
 * price-to-performance model that actually ran the game — so re-running a sweep
 * moves the default with it instead of leaving this to drift.
 *
 * The environment still wins. An operator who set `DEFAULT_LLM_MODEL` meant it,
 * and silently overriding an explicit choice would be worse than a stale default.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalProviderId } from "./registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the bake-off writes its verdicts. Served to browsers from the same file. */
const RATINGS_PATH = path.join(__dirname, "..", "..", "..", "client", "config", "model_ratings.json");

/** Last-resort fallbacks, used only when the ratings file is unreadable too. */
const FALLBACK_PROVIDER = "openai";
const FALLBACK_MODEL = "gpt-4o-mini";

// The alias table lived here as a second copy of `llmGateway`'s. It is now the registry's,
// which is the only place that knows which providers exist.

/**
 * Reads the bake-off's recommended model.
 *
 * @description Tolerates every failure by returning null: the ratings file is generated
 *   output that may be absent on a fresh checkout, and a missing recommendation must cost
 *   a good default rather than the server's ability to start.
 * @param {object} [fsImpl=fs] - Filesystem, injected so this is testable without one.
 * @param {string} [file=RATINGS_PATH] - The ratings file to read.
 * @returns {{provider: string, model: string}|null} The recommendation, or null.
 */
export function readRecommendedDefault(fsImpl = fs, file = RATINGS_PATH) {
	try {
		const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
		const key = typeof parsed?.recommended === "string" ? parsed.recommended : "";
		const slash = key.indexOf("/");
		if (slash <= 0 || slash === key.length - 1) return null;
		// Split on the *first* slash only: some gateways serve ids that contain more.
		return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
	} catch {
		return null;
	}
}

/** Read once at load, the same way `lobbyPrompts` reads its mood list. */
const RECOMMENDED = readRecommendedDefault();

/**
 * @description Reads the provider and model a new lobby should start on.
 * @param {object} [env=process.env] - The environment to read, injected for tests.
 * @param {{provider: string, model: string}|null} [recommended=RECOMMENDED] - The
 *   bake-off's pick, injected for tests. Used only where the environment is silent.
 * @returns {{provider: string, model: string}} The starting settings; both fields are
 *   always non-empty strings.
 */
export function getDefaultLLMSettings(env = process.env, recommended = RECOMMENDED) {
	return {
		provider: canonicalProviderId(env.DEFAULT_LLM_PROVIDER || recommended?.provider || FALLBACK_PROVIDER),
		model: env.DEFAULT_LLM_MODEL || env.OPENAI_MODEL || recommended?.model || FALLBACK_MODEL,
	};
}
