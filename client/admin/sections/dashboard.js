/**
 * dashboard — the first screen after connecting: what state is this game in?
 *
 * Deliberately read-mostly. It answers "is anything wrong, whose turn is it, and
 * what just happened", and the two actions it does carry are the ones an admin
 * reaches for without needing context — advancing a stuck turn and pushing state
 * to clients that have drifted.
 */

import { h, fill } from "../ui/dom.js";
import { panel, tileGrid, button, chip, empty } from "../ui/components.js";
import { selectVitals } from "../core/selectors.js";
import { lobbyRepairs } from "../core/repairs.js";

/** Activity lines shown before "see all in Activity" takes over. */
const RECENT = 8;

/**
 * @description Renders the dashboard.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function dashboard(ctx) {
	const { store, bridge, navigate } = ctx;

	const tilesHost = h("div");
	const alertHost = h("div");
	const activityHost = h("div");

	/**
	 * @description Draws the headline numbers.
	 * @returns {void}
	 */
	function drawTiles() {
		const v = selectVitals(store.getState().lobbyState);
		fill(tilesHost, tileGrid([
			{ label: "Phase", value: v.phase },
			{ label: "Round", value: v.round },
			{ label: "Turn", value: v.turn ?? "nobody", tone: v.turn ? undefined : "warn" },
			{ label: "Alive", value: `${v.alive} of ${v.total}`, tone: v.dead > 0 ? "warn" : "ok" },
			{ label: "Connected", value: v.connectedCount },
			{ label: "Music", value: v.music, tone: "muted" },
			{ label: "Model", value: v.model, tone: "muted" },
			{ label: "Turn timer", value: v.timer, tone: "muted" },
		]));
	}

	/**
	 * @description Draws the unresolved-incident callout, or nothing.
	 *
	 *   The sidebar badge says how many; this says what, because an admin landing
	 *   on the dashboard should not have to go looking to find out the game is
	 *   broken.
	 * @returns {void}
	 */
	function drawAlert() {
		const open = (store.getState().incidents ?? []).filter((i) => !i.resolved);
		if (!open.length) {
			fill(alertHost);
			return;
		}
		fill(alertHost, panel({ title: `${open.length} unresolved incident${open.length === 1 ? "" : "s"}` },
			h("ul.plain-list", open.slice(0, 4).map((incident) => h("li",
				chip(incident.severity ?? "info", incident.severity === "error" ? "danger" : "warn"),
				h("span", " ", incident.message ?? incident.kind ?? "Unknown problem"),
			))),
			h("div.control-row",
				button({ label: "Open Health", variant: "primary", small: true,
					onClick: () => navigate({ lobby: store.getState().lobby, section: "health" }) }),
			),
		));
	}

	/**
	 * @description Draws the most recent activity.
	 * @returns {void}
	 */
	function drawActivity() {
		const feed = store.getState().feed ?? [];
		const recent = feed.slice(-RECENT).reverse();
		fill(activityHost, recent.length
			? h("ul.plain-list.activity-brief", recent.map((entry) => h("li",
				h("span.mono.muted", new Date(entry.at).toLocaleTimeString()),
				h("span.chip.is-info", entry.type),
				h("span", entry.message),
			)))
			: empty("Nothing has happened since this console connected."));
	}

	ctx.onCleanup(store.watch((s) => s.lobbyState, drawTiles));
	ctx.onCleanup(store.watch((s) => (s.incidents ?? []).filter((i) => !i.resolved).length, drawAlert));
	ctx.onCleanup(store.watch((s) => (s.feed ?? []).length, drawActivity));

	drawTiles();
	drawAlert();
	drawActivity();

	const resync = lobbyRepairs(store.getState().repairs).find((r) => r.type === "resync:force");

	return h("div",
		alertHost,
		panel({ title: "At a glance" }, tilesHost),
		panel({ title: "Quick actions" },
			h("div.control-row",
				button({ label: "Next turn", onClick: () => bridge.nextTurn() }),
				resync && button({
					label: "Force resync",
					title: resync.note ?? "",
					onClick: () => bridge.sendRepair("resync:force", {}),
				}),
				button({ label: "Party", variant: "ghost",
					onClick: () => navigate({ lobby: store.getState().lobby, section: "party" }) }),
			),
		),
		panel({ title: "Recent activity" },
			activityHost,
			h("div.control-row",
				button({ label: "See all activity", variant: "ghost", small: true,
					onClick: () => navigate({ lobby: store.getState().lobby, section: "activity" }) }),
			),
		),
	);
}
