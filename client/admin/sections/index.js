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

import { h } from "../ui/dom.js";

/**
 * @description Placeholder for a section whose rebuild has not landed yet.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} A panel explaining what will live here.
 */
function notYetBuilt(ctx) {
	return h("div.panel",
		h("h2", ctx.section.label),
		h("p.muted", "This section has not been rebuilt yet."),
		h("p.muted.small", "The shell, routing and permissions are in place; the controls arrive in a later phase."),
	);
}

/**
 * Renderers by section id. Every id in `nav.js` must appear here, which
 * `sections.test.js` enforces — a missing entry would render a blank frame with no
 * indication anything was wrong.
 */
const RENDERERS = {
	lobbies: notYetBuilt,
	dashboard: notYetBuilt,
	party: notYetBuilt,
	turn: notYetBuilt,
	narrate: notYetBuilt,
	audio: notYetBuilt,
	health: notYetBuilt,
	activity: notYetBuilt,
	campaign: notYetBuilt,
	model: notYetBuilt,
	raw: notYetBuilt,
	toolbox: notYetBuilt,
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
 */
export function renderSection(ctx) {
	const render = RENDERERS[ctx?.section?.id] ?? notYetBuilt;
	return render(ctx);
}
