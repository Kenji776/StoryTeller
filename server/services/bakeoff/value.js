/**
 * value — which model becomes the game's default.
 *
 * Price is the one input the bake-off cannot measure. Latency and correctness come out of
 * a real game; what a provider charges does not, so it arrives from a hand-maintained
 * table that is deliberately allowed to be incomplete. Most of the logic here is about
 * behaving sensibly when a price is missing rather than pretending to know it.
 *
 * The ordering is lexicographic rather than a single blended figure, because the three
 * inputs are not commensurable and a formula that traded them off would hide its own
 * assumptions:
 *
 *   1. **Correctness is a gate, not a term.** A model that cannot run the game is never
 *      the default however cheap or fast it is, and neither is one whose evidence is a
 *      thin sample — the game's default should rest on a settled result.
 *   2. **Then score**, banded rather than exact, so a one-point difference does not
 *      outweigh a tenfold difference in price.
 *   3. **Then price**, where it is known. A model whose cost nobody has established is a
 *      worse default than one we can reason about, so a priced model wins a tie.
 *   4. **Then latency**, which is the only cost signal left when nothing is priced — and
 *      a slow narrator is its own kind of expensive at a live table.
 *
 * Pure and synchronous.
 */

/**
 * How a narrator's spend splits between reading and writing.
 *
 * @description The DM prompt is substantial but the narration is what it generates every
 * turn, and output tokens are the dearer half on every provider. A 1:3 read/write blend
 * is a rough but honest weighting; it only ever has to rank models, not predict a bill.
 */
const INPUT_WEIGHT = 0.25;
const OUTPUT_WEIGHT = 0.75;

/** Verdicts a default may be chosen from. Anything else is not evidence of working. */
const ELIGIBLE_VERDICTS = new Set(["recommended", "usable"]);

/** Score band width. Within a band, price decides rather than a point of score. */
const SCORE_BAND = 10;

/**
 * Blends a price entry into one comparable number.
 *
 * @description Returns null for anything incomplete, and that is the important case: a
 *   missing price treated as zero would make every unpriced model the cheapest thing on
 *   offer and hand it the default.
 * @param {*} price - `{input, output}` in USD per million tokens.
 * @returns {number|null} The blended price, or null when it is not fully known.
 */
export function blendedPrice(price) {
	if (!price || typeof price !== "object") return null;
	const input = Number(price.input);
	const output = Number(price.output);
	if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
	return input * INPUT_WEIGHT + output * OUTPUT_WEIGHT;
}

/**
 * Picks the model with the best measured value for money.
 *
 * @param {object[]} reports - Graded reports from `scoreRun`.
 * @param {object} prices - Price table keyed `provider/model`, values `{input, output}` in
 *   USD per million tokens. Entries may be missing; that is expected.
 * @returns {{key: string, provider: string, model: string, score: number,
 *   price: number|null, medianMs: number|null, reason: string}|null} The winner and why it
 *   won, or null when nothing on offer is fit to be a default. Never throws.
 */
export function chooseBestValue(reports, prices) {
	if (!Array.isArray(reports)) return null;
	const table = prices && typeof prices === "object" ? prices : {};

	const eligible = reports
		.filter((r) => r && typeof r === "object")
		.filter((r) => ELIGIBLE_VERDICTS.has(r.verdict))
		.filter((r) => !(Array.isArray(r.blockers) && r.blockers.length))
		// A thin sample may well be fine, but it is not the evidence to hang every new
		// lobby's narrator on.
		.filter((r) => r.lowSample !== true)
		.map((r) => {
			const key = `${r.provider}/${r.model}`;
			return {
				key,
				provider: r.provider,
				model: r.model,
				score: Number.isFinite(r.score) ? r.score : 0,
				price: blendedPrice(table[key]),
				medianMs: Number.isFinite(r.latency?.medianMs) ? r.latency.medianMs : null,
			};
		});

	if (!eligible.length) return null;

	eligible.sort((a, b) => {
		// Banded, so a point of score cannot outweigh an order of magnitude of price.
		const band = Math.floor(b.score / SCORE_BAND) - Math.floor(a.score / SCORE_BAND);
		if (band !== 0) return band;

		// A known price beats an unknown one; two known prices compare directly.
		if (a.price !== null && b.price !== null && a.price !== b.price) return a.price - b.price;
		if (a.price !== null && b.price === null) return -1;
		if (a.price === null && b.price !== null) return 1;

		const aMs = a.medianMs ?? Infinity;
		const bMs = b.medianMs ?? Infinity;
		if (aMs !== bMs) return aMs - bMs;
		return a.key.localeCompare(b.key);
	});

	const winner = eligible[0];
	const priced = winner.price !== null;
	const parts = [`scored ${winner.score}/100`];
	if (priced) parts.push(`cheapest of the models that scored as well ($${winner.price.toFixed(2)}/M tokens blended)`);
	else parts.push("no price on record, so chosen on latency");
	if (winner.medianMs !== null) parts.push(`${(winner.medianMs / 1000).toFixed(1)}s median a turn`);

	return { ...winner, reason: `Best measured value: ${parts.join(", ")}.` };
}
