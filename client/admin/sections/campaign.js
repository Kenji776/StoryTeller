/**
 * campaign — how this game was set up.
 *
 * Read-only. Every one of these is chosen when the lobby is created, and the
 * server has no event to change any of them; adding one would mean a socket
 * handler and a validator per field. Showing them still matters — "why is this
 * game so lethal" is answered by the brutality setting, and until now that answer
 * was only in the raw JSON.
 */

import { h, fill } from "../ui/dom.js";
import { panel, dataTable, empty } from "../ui/components.js";
import { selectCampaign, selectVitals } from "../core/selectors.js";

/**
 * @description Renders the campaign section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function campaign(ctx) {
	const { store } = ctx;
	const host = h("div");

	/**
	 * @description Draws the settings table.
	 * @returns {void}
	 */
	function draw() {
		const state = store.getState().lobbyState;
		const rows = selectCampaign(state);
		if (!rows.length) {
			fill(host, empty("Connect to a lobby to see how it was set up."));
			return;
		}

		const vitals = selectVitals(state);
		fill(host,
			h("p.muted.small", `${vitals.adventureName} · ${vitals.code}`),
			dataTable({
				rows,
				columns: [
					{ label: "Setting", render: (r) => h("strong", r.label) },
					{ label: "Value", render: (r) => r.value },
				],
			}),
		);
	}

	ctx.onCleanup(store.watch((s) => s.lobbyState, draw));
	draw();

	return h("div", panel({
		title: "Campaign",
		description: "Chosen when the game was created. The server offers no way to change these once it is running.",
	}, host));
}
