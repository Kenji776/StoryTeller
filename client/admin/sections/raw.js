/**
 * raw — the lobby exactly as the server publishes it.
 *
 * The escape hatch. Every other section is a considered view of this object, and
 * when one of them is wrong or does not cover what you need, this is the ground
 * truth to check it against.
 */

import { h, fill } from "../ui/dom.js";
import { panel, button, empty, flash } from "../ui/components.js";

/**
 * @description Renders the raw state section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function raw(ctx) {
	const { store, bridge } = ctx;
	const host = h("div");
	const note = flash();

	/**
	 * @description Draws the serialised state.
	 * @returns {void}
	 */
	function draw() {
		const state = store.getState().lobbyState;
		fill(host, state
			? h("pre.readout.readout-tall", JSON.stringify(state, null, 2))
			: empty("Connect to a lobby to see its state."));
	}

	ctx.onCleanup(store.watch((s) => s.lobbyState, draw));
	draw();

	return h("div", panel({
		title: "Raw state",
		description: "What LobbyStore.publicState publishes for this lobby, updated live.",
	},
		h("div.control-row",
			button({
				label: "Copy",
				small: true,
				onClick: () => {
					const text = JSON.stringify(store.getState().lobbyState ?? null, null, 2);
					navigator.clipboard.writeText(text).then(
						() => note.show("Copied"),
						() => note.show("The browser refused clipboard access.", "warn"),
					);
				},
			}),
			button({
				label: "Refresh",
				variant: "ghost",
				small: true,
				// State arrives unprompted, but a reconnect is the honest way to ask
				// for it again rather than redrawing what is already held.
				onClick: () => bridge.connectLobby(store.getState().lobby),
			}),
			note.el,
		),
		host,
	));
}
