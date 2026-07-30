/**
 * model — which AI answers as the Dungeon Master for this lobby.
 *
 * The list comes from `client/config/llm_models.json` rather than the bundle, so
 * a new model is a config edit. Providers the server has no working key for are
 * offered but disabled, with the reason on the option, because "why can I not
 * pick Claude" is otherwise a question only the server log can answer.
 */

import { h, fill } from "../ui/dom.js";
import { panel, button, select, empty, flash } from "../ui/components.js";
import { parseModelCatalogue, ratedModelsFor, describeModel } from "../core/models.js";

/**
 * Marks appended to a model name in the dropdown.
 *
 * Worded identically to the lobby's narrator picker (`client/app.js`): an operator
 * comparing the two screens should not have to work out which one to believe.
 * `untested` gets nothing, because no evidence is not a claim.
 */
const MODEL_MARK = Object.freeze({
	recommended: "★ recommended",
	works: "✓ known to work",
	caution: "⚠ use with caution",
	avoid: "✕ known not to work",
});

/**
 * @description Renders the AI model section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function model(ctx) {
	const { store, bridge } = ctx;

	const pickerHost = h("div");
	const current = h("p.muted.small");
	const ratingNote = h("p");
	const note = flash();

	/** The parsed catalogue, once it has loaded. */
	let catalogue = [];

	/** Bake-off ratings, once they have loaded. Null renders every model unmarked. */
	let ratings = null;

	/**
	 * @description Reports what the lobby is running on now.
	 * @returns {void}
	 */
	function drawCurrent() {
		const state = store.getState().lobbyState;
		current.textContent = `Currently: ${describeModel(catalogue, state?.llmProvider, state?.llmModel)}`;
	}

	ctx.onCleanup(store.watch((s) => `${s.lobbyState?.llmProvider}/${s.lobbyState?.llmModel}`, drawCurrent));
	drawCurrent();

	/**
	 * @description Builds the two dropdowns once the catalogue and the server's
	 *   feature flags have both arrived.
	 * @param {object} features - The `/api/features` response.
	 * @returns {void}
	 */
	function drawPicker(features) {
		if (!catalogue.length) {
			fill(pickerHost, empty("No models are configured in client/config/llm_models.json."));
			return;
		}

		const state = store.getState().lobbyState;
		const providerPicker = select({
			options: catalogue.map((p) => ({ value: p.id, label: p.label })),
			value: state?.llmProvider ?? catalogue[0].id,
			props: { "aria-label": "AI provider" },
		});
		const modelPicker = select({ options: [], props: { "aria-label": "Model" } });

		// A provider with no valid key on the server cannot answer, so offering it
		// as selectable would produce a lobby that silently fails on the next turn.
		for (const option of providerPicker.options) {
			if (features && features[option.value] === false) {
				option.disabled = true;
				option.textContent += " — no valid key";
			}
		}

		/**
		 * @description Refills the model list for the chosen provider.
		 * @returns {void}
		 */
		function refillModels() {
			const models = ratedModelsFor(catalogue, providerPicker.value, ratings);
			// The mark is in the option text rather than a class, because a native <select>
			// renders its options as plain strings on most platforms — styling alone would be
			// invisible exactly where the operator is choosing.
			fill(modelPicker, models.map((m) => h("option", { value: m.id },
				`${m.label}${MODEL_MARK[m.rating?.flag] ? ` ${MODEL_MARK[m.rating.flag]}` : ""}`)));
			if (state?.llmProvider === providerPicker.value && state?.llmModel) {
				modelPicker.value = state.llmModel;
			} else if (models.length) {
				// Lead with the best-rated model rather than whatever the catalogue listed
				// first, which could be one already proven unable to run the game.
				modelPicker.value = models[0].id;
			}
			drawRatingNote(models);
		}

		/**
		 * @description Spells out what the selected model is known for, under the dropdown.
		 * @param {Array<object>} models - The annotated models on offer.
		 * @returns {void}
		 */
		function drawRatingNote(models) {
			const rating = models.find((m) => m.id === modelPicker.value)?.rating ?? null;
			ratingNote.textContent = rating && rating.flag !== "untested"
				? `${rating.label}. ${rating.note}`
				: "";
			ratingNote.className = rating && rating.flag !== "untested"
				? `model-rating model-rating--${rating.flag}`
				: "";
		}

		providerPicker.addEventListener("change", refillModels);
		// Re-read the note when the operator picks a different model, not only a different
		// provider: the evidence shown has to describe what is actually selected.
		modelPicker.addEventListener("change", () => drawRatingNote(ratedModelsFor(catalogue, providerPicker.value, ratings)));
		refillModels();

		fill(pickerHost, h("div.control-row",
			providerPicker,
			modelPicker,
			button({
				label: "Apply",
				variant: "primary",
				onClick: () => {
					if (bridge.setLLM(providerPicker.value, modelPicker.value)) {
						note.show(`Switched to ${providerPicker.value} / ${modelPicker.value}`);
					} else {
						note.show("Not connected to a lobby.", "danger");
					}
				},
			}),
			note.el,
		));
	}

	Promise.all([
		fetch("/config/llm_models.json").then((r) => r.json()),
		fetch("/api/features").then((r) => r.json()).catch(() => null),
		// Ratings are a nicety, not a dependency: a failed fetch leaves every model unmarked
		// rather than taking the section down, which is why this catch returns null instead
		// of rejecting the whole Promise.all.
		fetch("/config/model_ratings.json").then((r) => r.json()).catch(() => null),
	])
		.then(([json, features, ratingsJson]) => {
			catalogue = parseModelCatalogue(json);
			ratings = ratingsJson;
			drawCurrent();
			drawPicker(features);
		})
		.catch((err) => fill(pickerHost, h("p.muted.small", `Could not load the model catalogue: ${err.message}`)));

	return h("div", panel({
		title: "AI model",
		description: "The model this lobby's Dungeon Master runs on. Changing it takes effect on the next turn.",
	},
		current,
		pickerHost,
		ratingNote,
	));
}
