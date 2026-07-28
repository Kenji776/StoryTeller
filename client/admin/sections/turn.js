/**
 * turn — the order of play, and the phase the lobby is in.
 *
 * The order and the repairs that fix it belong together: "rebuild the turn order"
 * is only meaningful next to the order it rebuilds. In the old panel the order was
 * not shown anywhere at all, and the repair for it was inside the event-feed tab.
 */

import { h, fill } from "../ui/dom.js";
import { panel, group, button, select, chip, empty, flash } from "../ui/components.js";
import { selectTurn, selectPlayers } from "../core/selectors.js";
import { lobbyRepairs } from "../core/repairs.js";
import { PHASES } from "../core/vocab.js";

/**
 * @description Renders the turn and phase section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function turn(ctx) {
	const { store, bridge } = ctx;

	const orderHost = h("div");
	const handOverHost = h("div");
	const note = flash();

	/**
	 * @description Draws the order of play, marking who is up.
	 * @returns {void}
	 */
	function drawOrder() {
		const state = store.getState().lobbyState;
		const { order, current, round } = selectTurn(state);
		const dead = new Set(selectPlayers(state).filter((p) => p.dead).map((p) => p.name));

		if (!order.length) {
			fill(orderHost, empty("The turn order is empty. Rebuilding it below will fill it from the living party."));
			return;
		}

		fill(orderHost,
			h("p.muted.small", `Round ${round}`),
			h("ol.turn-order", order.map((name, index) => h("li", {
				class: [name === current ? "is-current" : "", dead.has(name) ? "is-dead" : ""]
					.filter(Boolean).join(" "),
			},
				h("span.turn-index", String(index + 1)),
				h("span.turn-name", name),
				name === current && chip("now", "ok"),
				dead.has(name) && chip("dead", "danger"),
			))),
		);
	}

	/**
	 * @description Draws the hand-the-turn-to control, when the server offers it.
	 * @returns {void}
	 */
	function drawHandOver() {
		// Looked up in the whole catalogue rather than through either partition:
		// `turn:set` names a player, so it is a player-scoped repair, but the order
		// is also the only place you can see who is available to hand it to.
		const repair = (store.getState().repairs ?? []).find((r) => r.type === "turn:set");
		const { order } = selectTurn(store.getState().lobbyState);
		if (!repair || !order.length) {
			fill(handOverHost);
			return;
		}

		const who = select({ options: order.map((name) => ({ value: name, label: name })) });
		fill(handOverHost, h("div.control-row",
			who,
			button({
				label: "Hand them the turn",
				small: true,
				title: repair.note ?? "",
				onClick: () => {
					if (bridge.sendRepair("turn:set", { player: who.value })) note.show(`Turn handed to ${who.value}`);
				},
			}),
		));
	}

	ctx.onCleanup(store.watch((s) => s.lobbyState, () => { drawOrder(); drawHandOver(); }));
	ctx.onCleanup(store.watch((s) => (s.repairs ?? []).length, drawHandOver));

	drawOrder();
	drawHandOver();

	const rebuild = lobbyRepairs(store.getState().repairs).find((r) => r.type === "order:rebuild");
	const unlock = lobbyRepairs(store.getState().repairs).find((r) => r.type === "ui:unlock");

	return h("div",
		panel({ title: "Order of play" },
			orderHost,
			h("div.control-row", { style: { marginTop: "0.8rem" } },
				button({ label: "Next turn", variant: "primary", onClick: () => bridge.nextTurn() }),
			),
			handOverHost,
			group("Recovery",
				h("p.muted.small", "For an order that is empty, duplicated, or still holding somebody who left."),
				h("div.control-row",
					rebuild && button({
						label: rebuild.label,
						title: rebuild.note ?? "",
						confirm: "Rebuild the turn order from the living party?",
						onClick: () => {
							if (bridge.sendRepair("order:rebuild", {})) note.show("Order rebuilt");
						},
					}),
					unlock && button({
						label: unlock.label,
						title: unlock.note ?? "",
						onClick: () => {
							if (bridge.sendRepair("ui:unlock", {})) note.show("Overlay released");
						},
					}),
					note.el,
				),
			),
		),
		panel({ title: "Phase", description: "Moves every client in the lobby to another stage of play." },
			h("div.control-row", PHASES.map((phase) => button({
				label: phase.label,
				onClick: () => bridge.setPhase(phase.id),
			}))),
		),
	);
}
