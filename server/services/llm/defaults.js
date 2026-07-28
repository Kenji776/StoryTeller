/**
 * What provider and model a brand-new lobby starts on.
 *
 * A small module of its own because two things need it — `LobbyStore.create` and
 * `getLLMSettings` — and its previous home, `services/llmService.js`, has been
 * retired. It reads the environment and nothing else: which provider a lobby
 * *may* use is a policy question answered by `services/credentials/`, while this
 * is only the value a lobby is stamped with before anyone has chosen.
 *
 * The default provider id is canonical. `DEFAULT_LLM_PROVIDER=claude` in an
 * existing deployment still works, because `llmGateway` aliases the old id, but
 * a new lobby is stamped with the name the registry actually uses.
 */

/** Fallbacks when the environment says nothing. */
const FALLBACK_PROVIDER = "openai";
const FALLBACK_MODEL = "gpt-4o";

/** Provider ids that changed name, mirroring `llmGateway`'s alias table. */
const ALIASES = Object.freeze({ claude: "anthropic" });

/**
 * @description Reads the provider and model a new lobby should start on.
 * @param {object} [env=process.env] - The environment to read, injected for tests.
 * @returns {{provider: string, model: string}} The starting settings.
 */
export function getDefaultLLMSettings(env = process.env) {
	const raw = String(env.DEFAULT_LLM_PROVIDER || FALLBACK_PROVIDER).trim().toLowerCase();
	return {
		provider: ALIASES[raw] ?? raw,
		model: env.DEFAULT_LLM_MODEL || env.OPENAI_MODEL || FALLBACK_MODEL,
	};
}
