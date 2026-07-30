/**
 * modelRatings — turning bake-off results into picker badges.
 *
 * The picker is where a host decides what narrates their game, and until now it offered
 * every model a provider lists with nothing to distinguish them. Several of those models
 * demonstrably cannot run the game: the bake-off found local models that emit clean JSON
 * while omitting `combat_over` and `updates` on every turn, so combat could never end and
 * no damage would ever land. A host had no way to know that before losing an evening to it.
 *
 * The ratings themselves come from `client/config/model_ratings.json`, generated from
 * bake-off results and served statically the same way `llm_models.json` and
 * `music_moods.json` already are — so refreshing them after a sweep is a data change
 * rather than a code change.
 *
 * Two rules govern the mapping, and both are about not overclaiming:
 *
 *   - **A thin sample is a caution, not a condemnation.** `claude-opus-5` failed on 1 of
 *     16 screen turns. That is a real defect and it is not an established frequency, so
 *     the badge says "watch out" and quotes the evidence rather than telling a host the
 *     flagship model does not work.
 *   - **Untested is not broken.** A model the provider throttled, or one released since
 *     the last sweep, carries no badge claim at all. Absence of evidence is displayed as
 *     absence of evidence.
 *
 * Everything here is pure, so the whole mapping is testable without a browser.
 */

/** Badges a model can carry in a picker. */
export const FLAGS = {
	RECOMMENDED: "recommended",
	WORKS: "works",
	CAUTION: "caution",
	AVOID: "avoid",
	UNTESTED: "untested",
};

/** Sort order when the picker asks for it: best first, known-bad last. */
const FLAG_RANK = {
	[FLAGS.RECOMMENDED]: 0,
	[FLAGS.WORKS]: 1,
	[FLAGS.CAUTION]: 2,
	[FLAGS.UNTESTED]: 3,
	[FLAGS.AVOID]: 4,
};

/** Short human labels. Kept here so the two pickers cannot word them differently. */
const FLAG_LABEL = {
	[FLAGS.RECOMMENDED]: "Recommended",
	[FLAGS.WORKS]: "Known to work",
	[FLAGS.CAUTION]: "Use with caution",
	[FLAGS.AVOID]: "Known not to work",
	[FLAGS.UNTESTED]: "Untested",
};

/** Fallback copy when an entry carries no note of its own. */
const FLAG_NOTE = {
	[FLAGS.RECOMMENDED]: "Best measured value for money, and the default.",
	[FLAGS.WORKS]: "Ran the game correctly in testing.",
	[FLAGS.CAUTION]: "Mostly worked, but showed a fault worth knowing about.",
	[FLAGS.AVOID]: "Failed to run the game correctly in testing.",
	[FLAGS.UNTESTED]: "Not tested yet — no evidence either way.",
};

/**
 * @description Reports whether a value is a plain, non-array object.
 * @param {*} v - Any value.
 * @returns {boolean} True for `{}`-shaped values only.
 */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reads and validates a ratings document.
 *
 * @description Validated on arrival (`CQ-6`), and degrades rather than throwing: this file
 *   can be hand-edited, and a malformed entry should cost one badge rather than the whole
 *   picker. A picker that fails to render is worse than a picker with no badges.
 * @param {*} json - The parsed contents of `model_ratings.json`.
 * @returns {{models: object, recommended: string|null, generatedOn: string|null}} The
 *   usable ratings. Never throws.
 */
export function parseRatings(json) {
	const empty = { models: {}, recommended: null, generatedOn: null };
	if (!isPlainObject(json) || !isPlainObject(json.models)) return empty;

	const models = {};
	for (const [key, entry] of Object.entries(json.models)) {
		if (!isPlainObject(entry) || typeof entry.verdict !== "string") continue;
		models[key] = {
			verdict: entry.verdict,
			score: Number.isFinite(entry.score) ? entry.score : null,
			medianMs: Number.isFinite(entry.medianMs) ? entry.medianMs : null,
			turns: Number.isFinite(entry.turns) ? entry.turns : null,
			lowSample: entry.lowSample === true,
			note: typeof entry.note === "string" ? entry.note : "",
		};
	}

	return {
		models,
		recommended: typeof json.recommended === "string" && models[json.recommended] ? json.recommended : null,
		generatedOn: typeof json.generatedOn === "string" ? json.generatedOn : null,
	};
}

/**
 * @description Maps a bake-off verdict onto a picker badge.
 * @param {object} entry - A parsed ratings entry.
 * @param {boolean} isRecommended - Whether this is the globally recommended model.
 * @returns {string} One of {@link FLAGS}.
 */
function flagFor(entry, isRecommended) {
	if (isRecommended) return FLAGS.RECOMMENDED;
	switch (entry.verdict) {
		case "recommended":
		case "usable":
			return FLAGS.WORKS;
		case "marginal":
			return FLAGS.CAUTION;
		case "unusable":
			// A defect seen a handful of times is worth a warning and is not worth calling a
			// verdict. Overclaiming here would steer hosts away from working models.
			return entry.lowSample ? FLAGS.CAUTION : FLAGS.AVOID;
		default:
			// "not evaluated", "assumed failure", or anything a future sweep invents.
			return FLAGS.UNTESTED;
	}
}

/**
 * Looks up what is known about one model.
 *
 * @description Keyed `provider/model`, because the same model id can be served by more
 *   than one provider and a rating earned through one is not evidence about the other.
 * @param {object} ratings - Output of {@link parseRatings}.
 * @param {string} providerId - The provider id.
 * @param {string} modelId - The model id.
 * @returns {{flag: string, label: string, note: string, score: number|null,
 *   medianMs: number|null, turns: number|null}} The rating. Unknown models come back
 *   `untested` rather than absent, so a caller never has to null-check. Never throws.
 */
export function rateModel(ratings, providerId, modelId) {
	const key = typeof providerId === "string" && typeof modelId === "string" && modelId.trim()
		? `${providerId}/${modelId}`
		: null;
	const entry = key && isPlainObject(ratings?.models) ? ratings.models[key] : null;

	if (!entry) {
		return {
			flag: FLAGS.UNTESTED,
			label: FLAG_LABEL[FLAGS.UNTESTED],
			note: FLAG_NOTE[FLAGS.UNTESTED],
			score: null, medianMs: null, turns: null,
		};
	}

	const flag = flagFor(entry, key === ratings.recommended);
	return {
		flag,
		label: FLAG_LABEL[flag],
		note: entry.note || FLAG_NOTE[flag],
		score: entry.score,
		medianMs: entry.medianMs,
		turns: entry.turns,
	};
}

/**
 * Attaches a rating to every model in a picker list.
 *
 * @description Returns fresh objects so a caller mutating one cannot corrupt the
 *   catalogue, which is shared between renders.
 * @param {object} ratings - Output of {@link parseRatings}.
 * @param {string} providerId - The provider whose dropdown this is.
 * @param {Array<{id: string}>} models - Models on offer.
 * @param {object} [options] - Options.
 * @param {boolean} [options.sort=false] - Order best-first and sink known-bad to the
 *   bottom. Ties keep their original order, so a sorted list is still stable.
 * @returns {Array<object>} The models, each with a `rating`. Never throws.
 */
export function annotateModels(ratings, providerId, models, options = {}) {
	if (!Array.isArray(models)) return [];
	const annotated = models
		.filter(isPlainObject)
		.map((model, index) => ({ ...model, index, rating: rateModel(ratings, providerId, model.id) }));

	if (options?.sort) {
		annotated.sort((a, b) => {
			const rank = FLAG_RANK[a.rating.flag] - FLAG_RANK[b.rating.flag];
			return rank !== 0 ? rank : a.index - b.index;
		});
	}
	return annotated.map(({ index, ...model }) => model);
}

/**
 * Chooses which model a picker should land on.
 *
 * @description Prefers the globally recommended model when this provider offers it, and
 *   otherwise the best-rated thing available. The fallback matters more than the happy
 *   path: the picker previously defaulted to `models[0]`, which is whatever order the
 *   provider's catalogue happened to be in, and could therefore land a new lobby on a
 *   model already known to fail.
 * @param {object} ratings - Output of {@link parseRatings}.
 * @param {string} providerId - The provider whose dropdown this is.
 * @param {Array<{id: string}>} models - Models on offer.
 * @returns {string|null} The model id to select, or null when there is nothing to pick.
 */
export function pickRecommended(ratings, providerId, models) {
	if (!Array.isArray(models) || models.length === 0) return null;
	const annotated = annotateModels(ratings, providerId, models, { sort: true });
	return annotated[0]?.id ?? null;
}
