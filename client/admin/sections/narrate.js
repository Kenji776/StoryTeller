/**
 * narrate — speaking as the Dungeon Master, and reading what the story has become.
 *
 * The summary sits beside the composer rather than in a tab of its own: what you
 * write should follow from where the story actually is, and the model is reading
 * that same summary when it narrates.
 */

import { h, fill } from "../ui/dom.js";
import { panel, button, textArea, empty, flash } from "../ui/components.js";

/**
 * @description Renders the narration section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function narrate(ctx) {
	const { store, bridge } = ctx;

	const summaryHost = h("div");
	const note = flash();
	const composer = textArea({
		rows: 5,
		placeholder: "Speak as the Dungeon Master. This is appended to the story and read aloud to the lobby.",
	});

	/**
	 * @description Draws the running story summary.
	 * @returns {void}
	 */
	function drawSummary() {
		const context = store.getState().lobbyState?.storyContext;
		fill(summaryHost, context && context !== "—"
			? h("pre.readout", context)
			: empty("No summary yet — one is generated after a few turns."));
	}

	ctx.onCleanup(store.watch((s) => s.lobbyState?.storyContext ?? null, drawSummary));
	drawSummary();

	/**
	 * @description Sends what has been written, if anything.
	 * @returns {void}
	 */
	function send() {
		const content = composer.value.trim();
		if (!content) return note.show("Write something first.", "warn");
		if (!bridge.sendDM(content)) return note.show("Not connected to a lobby.", "danger");
		composer.value = "";
		note.show("Sent to the lobby");
	}

	return h("div",
		panel({ title: "Speak as the DM" },
			composer,
			h("div.control-row", { style: { marginTop: "0.6rem" } },
				button({ label: "Send", variant: "primary", onClick: send }),
				note.el,
			),
		),
		panel({ title: "Story so far", description: "The summary the model is given as context." },
			summaryHost,
			h("div.control-row",
				button({
					label: "Copy",
					variant: "ghost",
					small: true,
					onClick: () => {
						const text = summaryHost.textContent ?? "";
						navigator.clipboard.writeText(text).then(
							() => note.show("Copied"),
							() => note.show("The browser refused clipboard access.", "warn"),
						);
					},
				}),
			),
		),
	);
}
