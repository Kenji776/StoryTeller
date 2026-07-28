/**
 * activity — the live log of everything the lobby has done since connecting.
 *
 * Appends rather than redrawing. The feed reaches five hundred lines and a busy
 * combat round emits a dozen events a second; rebuilding the list each time would
 * fight the scroll position and drop the selection out from under anyone reading.
 */

import { h, fill } from "../ui/dom.js";
import { panel, button, select, empty } from "../ui/components.js";
import { FEED_TYPES, matchesFilter } from "../core/feed.js";

/**
 * @description Renders the activity section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function activity(ctx) {
	const { store } = ctx;

	/** How many feed entries have been rendered, so only new ones are appended. */
	let rendered = 0;

	/** Entries hidden by the filter rather than absent, so changing it is instant. */
	let filter = "all";

	const listHost = h("div.feed");
	const autoScroll = h("input", { type: "checkbox", checked: true, id: "feedAutoScroll" });

	/**
	 * @description Builds one line.
	 * @param {object} entry - A feed entry.
	 * @returns {HTMLElement} The line.
	 */
	function line(entry) {
		const el = h("div.feed-line", { class: `is-${entry.type}`, dataset: { type: entry.type } },
			h("span.feed-time", new Date(entry.at).toLocaleTimeString("en-GB", { hour12: false })),
			h("span.feed-type", entry.type),
			h("span.feed-message", entry.message),
		);
		el.hidden = !matchesFilter(entry, filter);
		return el;
	}

	/**
	 * @description Appends whatever has arrived since the last draw.
	 * @returns {void}
	 */
	function drawNew() {
		const feed = store.getState().feed ?? [];

		// The feed is capped, so once it is full the oldest are dropped and the
		// count stops growing; a shrunken or reset feed means a full redraw.
		if (feed.length < rendered) {
			rendered = 0;
			fill(listHost);
		}

		if (!feed.length) {
			fill(listHost, empty("Nothing yet. Events appear here as the lobby plays."));
			rendered = 0;
			return;
		}
		if (rendered === 0) fill(listHost);

		for (const entry of feed.slice(rendered)) listHost.append(line(entry));
		rendered = feed.length;

		if (autoScroll.checked) listHost.scrollTop = listHost.scrollHeight;
	}

	/**
	 * @description Applies the filter to what is already on screen.
	 * @returns {void}
	 */
	function applyFilter() {
		for (const el of listHost.children) {
			if (!el.dataset?.type) continue;
			el.hidden = !matchesFilter({ type: el.dataset.type }, filter);
		}
	}

	const picker = select({
		options: FEED_TYPES.map((t) => ({ value: t.id, label: t.label })),
		props: { "aria-label": "Filter activity" },
		onChange: (event) => {
			filter = event.target.value;
			applyFilter();
		},
	});

	ctx.onCleanup(store.watch((s) => (s.feed ?? []).length, drawNew));
	drawNew();

	return h("div", panel({
		title: "Activity",
		description: "Everything this console has seen since it connected. The server's journal is the permanent record.",
	},
		h("div.control-row.feed-controls",
			picker,
			button({
				label: "Clear",
				small: true,
				onClick: () => {
					// Clears the view, not the store: the feed is shared with the
					// dashboard, and emptying it there would be a surprise.
					fill(listHost, empty("Cleared. New events will appear here."));
					rendered = store.getState().feed?.length ?? 0;
				},
			}),
			h("label.feed-autoscroll", autoScroll, h("span", " Follow")),
		),
		listHost,
	));
}
