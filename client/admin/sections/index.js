/**
 * sections — the registry mapping a section id to the thing that renders it.
 *
 * A section renderer is a function of the context and nothing else: it reads from
 * the store, sends through the bridge, and returns an element. It never reaches for
 * another section, the socket, or the DOM outside the tree it returns.
 *
 * Sections that need to re-render register through `ctx.onCleanup`, so the shell
 * can tear them down when the route changes rather than leaving subscriptions
 * accumulating behind it.
 */

import { dashboard } from "./dashboard.js";
import { party } from "./party.js";
import { turn } from "./turn.js";
import { narrate } from "./narrate.js";
import { audio } from "./audio.js";
import { health } from "./health.js";
import { activity } from "./activity.js";
import { lobbies } from "./lobbies.js";
import { model } from "./model.js";
import { campaign } from "./campaign.js";
import { raw } from "./raw.js";
import { toolbox } from "./toolbox.js";
import { providers } from "./providers.js";

/**
 * Renderers by section id. Every id in `nav.js` must appear here, which
 * `sections.test.js` enforces — a missing entry would render a blank frame with no
 * indication anything was wrong.
 */
const RENDERERS = {
	lobbies,
	dashboard,
	party,
	turn,
	narrate,
	audio,
	health,
	activity,
	campaign,
	model,
	raw,
	toolbox,
	providers,
};

/**
 * @description Reports whether a section has a renderer.
 * @param {string} id - The section id.
 * @returns {boolean} Whether it can be rendered.
 */
export function hasRenderer(id) {
	return Object.hasOwn(RENDERERS, id);
}

/**
 * @description Lists every id with a renderer.
 * @returns {Array<string>} The ids.
 */
export function renderableIds() {
	return Object.keys(RENDERERS);
}

/**
 * @description Renders a section.
 * @param {object} ctx - The section context.
 * @param {object} ctx.section - The nav descriptor for the section.
 * @param {object} ctx.store - The panel's store.
 * @param {object} ctx.bridge - The socket action surface.
 * @param {string} ctx.role - The viewer's role.
 * @param {function(Function): void} ctx.onCleanup - Registers teardown for this mount.
 * @param {function(object): void} ctx.navigate - Moves to another route.
 * @returns {HTMLElement} The section's element.
 * @throws {RangeError} When no renderer exists for the section.
 */
export function renderSection(ctx) {
	const id = ctx?.section?.id;
	if (!hasRenderer(id)) {
		// Every nav entry has a renderer, and a test enforces it; reaching here means
		// a route resolved to something the registry has never heard of.
		throw new RangeError(`No renderer for section "${id}".`);
	}
	return RENDERERS[id](ctx);
}
