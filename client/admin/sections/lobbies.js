/**
 * lobbies — every game on this server, and the way into one.
 *
 * `/api/lobbies` already published who is in each lobby, which of them are
 * connected, which one is the host, when it last did anything and whether it is
 * private. The old panel showed a code, a player count and a phase, and discarded
 * the rest — so deciding which lobby someone was asking about meant connecting to
 * each in turn.
 */

import { h, fill } from "../ui/dom.js";
import { panel, dataTable, button, chip, empty } from "../ui/components.js";
import { selectLobbyCards } from "../core/selectors.js";
import { CAP, can } from "../core/capabilities.js";

/** Phases that mean the game is over rather than waiting. */
const FINISHED = new Set(["wiped", "completed"]);

/**
 * @description Renders the lobby browser.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function lobbies(ctx) {
	const { store, bridge, role, navigate } = ctx;
	const listHost = h("div");

	/**
	 * @description Describes how long ago something happened.
	 * @param {number|null} at - A timestamp.
	 * @returns {string} A short phrase.
	 */
	function ago(at) {
		if (!at) return "—";
		const minutes = Math.floor((Date.now() - at) / 60000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	/**
	 * @description Draws the lobby list.
	 * @returns {void}
	 */
	function draw() {
		const cards = selectLobbyCards(store.getState().lobbies, store.getState().lobby);
		if (!cards.length) {
			fill(listHost, empty("No lobbies on this server."));
			return;
		}

		fill(listHost, dataTable({
			rows: cards,
			rowKey: (l) => l.code,
			selectedKey: store.getState().lobby,
			empty: "No lobbies on this server.",
			columns: [
				{
					label: "Adventure",
					render: (l) => h("span",
						h("strong", l.adventureName),
						l.hasPassword ? chip("private", "info") : "",
						l.isConnected ? chip("connected", "ok") : "",
					),
				},
				{ label: "Code", render: (l) => h("span.mono", l.code) },
				{
					label: "Phase",
					render: (l) => chip(l.phase, FINISHED.has(l.phase) ? "danger" : l.phase === "running" ? "ok" : undefined),
				},
				{
					label: "Party",
					render: (l) => h("span",
						h("span", `${l.connectedCount}/${l.playerCount} here`),
						l.hostName ? h("span.muted.small", ` · host ${l.hostName}`) : "",
					),
				},
				{
					label: "Who",
					render: (l) => l.players.length
						? h("span", l.players.map((p) => chip(
							`${p.name}${p.isHost ? " ★" : ""}`,
							p.connected ? "ok" : undefined,
						)))
						: h("span.muted", "empty"),
				},
				{ label: "Last active", align: "right", render: (l) => h("span.muted.small", ago(l.lastActivity)) },
				{
					label: "",
					align: "right",
					render: (l) => h("span.control-row",
						button({
							label: l.isConnected ? "Open" : "Connect",
							variant: l.isConnected ? "ghost" : "primary",
							small: true,
							onClick: () => navigate({ lobby: l.code, section: "dashboard" }),
						}),
						can(role, CAP.LOBBY_DELETE) && button({
							label: "Delete",
							variant: "danger",
							small: true,
							confirm: `Delete ${l.adventureName} (${l.code})? Everyone in it is disconnected and the game is gone.`,
							onClick: () => bridge.deleteLobby(l.code),
						}),
					),
				},
			],
		}));
	}

	// The list is polled rather than pushed, so redraw whenever it or the connected
	// lobby changes.
	ctx.onCleanup(store.watch(
		(s) => (s.lobbies ?? []).map((l) => `${l.code}:${l.phase}:${l.playerCount}:${l.lastActivity}`).join("|"),
		draw,
	));
	ctx.onCleanup(store.watch((s) => s.lobby, draw));
	draw();

	return h("div", panel({
		title: "Lobbies",
		description: "Every game on this server. Connect to one to manage it.",
	}, listHost));
}
