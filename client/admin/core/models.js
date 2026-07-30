/**
 * models — reading the model catalogue the console offers.
 *
 * The old panel carried this list hardcoded in its bundle, which is why it still
 * offered models that had been superseded. It now comes from
 * `client/config/llm_models.json`, served statically the same way `music_moods.json`
 * already is, so updating it is a config edit rather than a code change.
 *
 * Validated on arrival (`CQ-6`): a config file can be hand-edited, and a malformed
 * entry should cost one dropdown option rather than the whole section.
 */

import { parseRatings, annotateModels } from "../../modelRatings.js";

/**
 * @description Reads an entry that needs an id and may carry a label.
 * @param {*} entry - The candidate.
 * @returns {{id: string, label: string}|null} The entry, or null if unusable.
 */
function labelled(entry) {
	const id = typeof entry?.id === "string" ? entry.id.trim() : "";
	if (!id) return null;
	const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id;
	return { id, label };
}

/**
 * @description Parses and validates a fetched model catalogue.
 *
 *   Malformed providers and models are dropped rather than throwing, because one
 *   bad entry should not take the section down; only a catalogue with no usable
 *   provider at all is an error worth reporting.
 * @param {*} json - The parsed contents of `llm_models.json`.
 * @returns {Array<{id: string, label: string, models: Array<{id: string, label: string}>}>}
 *   The usable providers.
 * @throws {TypeError} When the catalogue is not an object with a `providers` array.
 */
export function parseModelCatalogue(json) {
	if (!json || typeof json !== "object" || !Array.isArray(json.providers)) {
		throw new TypeError("The model catalogue must be an object with a providers array.");
	}

	return json.providers.reduce((usable, entry) => {
		const provider = labelled(entry);
		if (!provider) return usable;

		const models = (Array.isArray(entry.models) ? entry.models : []).map(labelled).filter(Boolean);
		// A provider you cannot pick a model for is a dead end in the interface.
		if (models.length) usable.push({ ...provider, models });
		return usable;
	}, []);
}

/**
 * @description Finds the models a provider offers.
 * @param {Array<object>} catalogue - A parsed catalogue.
 * @param {string} providerId - The provider's id.
 * @returns {Array<{id: string, label: string}>} Its models, or an empty list.
 */
export function modelsFor(catalogue, providerId) {
	if (!Array.isArray(catalogue)) return [];
	return catalogue.find((provider) => provider.id === providerId)?.models ?? [];
}

/**
 * The same models, carrying what the bake-off found out about each.
 *
 * @description Shares `client/modelRatings.js` with the lobby's narrator picker rather than
 *   repeating the mapping, because two pickers wording this differently would leave an
 *   operator comparing them with no way to tell which to believe.
 * @param {Array<object>} catalogue - A parsed catalogue.
 * @param {string} providerId - The provider's id.
 * @param {object} [ratings] - Raw `model_ratings.json`; absent means every model is
 *   reported `untested` rather than the list coming back empty.
 * @returns {Array<{id: string, label: string, rating: object}>} Its models, best first and
 *   known failures last.
 */
export function ratedModelsFor(catalogue, providerId, ratings) {
	return annotateModels(parseRatings(ratings), providerId, modelsFor(catalogue, providerId), { sort: true });
}

/**
 * @description Describes the model a lobby is running on, for display.
 *
 *   A lobby can be running something the catalogue no longer lists — a model
 *   removed from the config, or one set before this build. Naming it raw beats
 *   reporting "not set", which would be a lie about what is actually answering.
 * @param {Array<object>} catalogue - A parsed catalogue.
 * @param {string|null} providerId - The lobby's provider.
 * @param {string|null} modelId - The lobby's model.
 * @returns {string} A human label, falling back to the raw ids.
 */
export function describeModel(catalogue, providerId, modelId) {
	if (!providerId && !modelId) return "not set";

	const provider = (Array.isArray(catalogue) ? catalogue : []).find((p) => p.id === providerId);
	const providerLabel = provider?.label ?? providerId ?? "?";
	const modelLabel = provider?.models.find((m) => m.id === modelId)?.label ?? modelId ?? "?";
	return `${providerLabel} · ${modelLabel}`;
}
