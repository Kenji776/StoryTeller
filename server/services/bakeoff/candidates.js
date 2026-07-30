/**
 * candidates — which of a provider's models are worth spending a game on.
 *
 * A provider catalogue is not a list of Dungeon Masters. OpenAI's is account-wide
 * and mixes in video, speech, embeddings and moderation endpoints, and it lists
 * every model twice: once under a floating alias and again under each dated
 * snapshot. Evaluating the raw list would spend a full game proving that
 * `whisper-1` cannot narrate, and would report `gpt-4o` four times under four
 * names.
 *
 * Two rules, and both are deliberately conservative — a model wrongly excluded
 * never appears in the report at all, which is a worse failure than a wasted run:
 *
 *   1. Reject only endpoints that structurally cannot serve a chat completion.
 *      Capability adjectives are never grounds for rejection: a vision model is
 *      still a chat model, and several of the local ones are the only models on
 *      the machine.
 *   2. Collapse a dated snapshot onto its floating alias, but only when that alias
 *      is actually in the same catalogue. Where the snapshot is the sole route to a
 *      model — which is how Anthropic publishes several of its own — it is kept.
 *
 * Pure and synchronous.
 */

/** Why a listed model was not evaluated. */
export const EXCLUSION_REASONS = {
	NOT_CHAT: "not a chat model",
	DUPLICATE: "date-pinned snapshot of a floating alias",
	MALFORMED: "not a usable model id",
};

/**
 * Endpoints that cannot serve a chat completion, whatever their family.
 *
 * Matched as substrings against the lower-cased id. `search` and `deep-research`
 * earn their place for a subtler reason than the media endpoints: they answer
 * chat-shaped requests but are tuned to retrieve and cite, ignore the response
 * schema, and bill per search. They break the game loop while looking like they
 * should work.
 */
const NON_CHAT = [
	"sora", "dall-e", "whisper", "embedding", "moderation",
	"-audio", "-realtime", "transcribe", "-image", "image-1", "-tts", "-guard", "codex-mini",
	"-instruct", "search", "deep-research",
];

/** A floating alias followed by a dated snapshot suffix, in both published forms. */
const SNAPSHOT_SUFFIXES = [/^(.+)-(\d{4}-\d{2}-\d{2})$/, /^(.+)-(\d{8})$/];

/**
 * Reports whether a model id could plausibly serve as the Dungeon Master.
 *
 * @description Rejects on endpoint kind only, never on capability. `tts-` is
 *   anchored to the start so that a legitimately-named gateway model such as
 *   `tts-tuned-mistral` is not thrown away for containing the substring.
 * @param {string} id - The model id as the provider published it.
 * @returns {boolean} True when the model is worth evaluating.
 */
export function isChatCapable(id) {
	if (typeof id !== "string") return false;
	const lower = id.trim().toLowerCase();
	if (lower === "") return false;
	if (lower.startsWith("tts-")) return false;
	return !NON_CHAT.some((needle) => lower.includes(needle));
}

/**
 * @description Splits a dated snapshot id into its floating alias, if it is one.
 * @param {string} id - A model id.
 * @returns {string|null} The alias, or null when the id carries no date suffix.
 */
function aliasOf(id) {
	for (const pattern of SNAPSHOT_SUFFIXES) {
		const match = pattern.exec(id);
		if (match) return match[1];
	}
	return null;
}

/**
 * Chooses which of a provider's models to evaluate.
 *
 * @description Every input is accounted for in exactly one of the two output
 *   lists, so a report can state what it declined to test and why rather than
 *   silently narrowing its own scope.
 * @param {string} provider - The provider id these models belong to.
 * @param {string[]} catalogue - Model ids exactly as `listModels` returned them.
 * @returns {{selected: Array<{provider: string, model: string}>,
 *   excluded: Array<{model: *, reason: string}>}} The split, with `selected` in
 *   catalogue order. Never throws.
 */
export function selectCandidates(provider, catalogue) {
	const selected = [];
	const excluded = [];
	if (!Array.isArray(catalogue)) return { selected, excluded };

	// Only chat-capable ids can shadow a snapshot: a snapshot must not be dropped
	// in favour of an alias that is itself going to be excluded.
	const chatIds = new Set(catalogue.filter(isChatCapable).map((id) => id.trim()));
	const taken = new Set();

	for (const raw of catalogue) {
		if (typeof raw !== "string" || raw.trim() === "") {
			excluded.push({ model: raw, reason: EXCLUSION_REASONS.MALFORMED });
			continue;
		}
		const id = raw.trim();
		if (!isChatCapable(id)) {
			excluded.push({ model: id, reason: EXCLUSION_REASONS.NOT_CHAT });
			continue;
		}
		const alias = aliasOf(id);
		if (alias && chatIds.has(alias)) {
			excluded.push({ model: id, reason: EXCLUSION_REASONS.DUPLICATE });
			continue;
		}
		if (taken.has(id)) {
			excluded.push({ model: id, reason: EXCLUSION_REASONS.DUPLICATE });
			continue;
		}
		taken.add(id);
		selected.push({ provider, model: id });
	}

	return { selected, excluded };
}
