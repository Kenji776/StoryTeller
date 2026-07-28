/**
 * app — the admin console's bootstrap and shell.
 *
 * Resolves who is looking, builds the chrome once, then does nothing but respond
 * to the route and the store. Sections are mounted and torn down here; no section
 * knows about any other, and none of them touch the socket.
 *
 * The host view (`?host=1&lobby=…&charId=…`) is the same shell with a smaller
 * capability set, not a second page. It is gated by the same server-side
 * authorisation either way — the capability set decides what is drawn, never what
 * is permitted.
 */

import { createStore } from "./core/store.js";
import { createSocketBridge } from "./core/socket.js";
import { parseRoute, buildRoute, GLOBAL_SECTION } from "./core/router.js";
import { ROLES, CAP, can, filterSections } from "./core/capabilities.js";
import { SECTIONS, groupSections, resolveView } from "./nav.js";
import { selectLobbyCards } from "./core/selectors.js";
import { h, fill, plainText } from "./ui/dom.js";
import { renderSection } from "./sections/index.js";

/** How often the lobby list behind the switcher is refreshed, in milliseconds. */
const LOBBY_POLL_MS = 15_000;

/** Human labels for each connection state. */
const STATUS_LABEL = {
	connecting: "Connecting…",
	connected: "Live",
	disconnected: "Disconnected",
	error: "Connection error",
};

// ══════════════════════════════════════════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @description Reads the host-view parameters from the query string.
 * @returns {{isHost: boolean, lobby: string|null, characterId: string|null}} The mode.
 */
function readHostMode() {
	const params = new URLSearchParams(window.location.search);
	return {
		isHost: params.get("host") === "1",
		lobby: params.get("lobby"),
		characterId: params.get("charId"),
	};
}

/**
 * @description Establishes who is looking, sending them to the login page if nobody is.
 * @returns {Promise<string|null>} The role, or null when the caller has been redirected.
 */
async function resolveRole() {
	try {
		const res = await fetch("/api/admin/session");
		const session = await res.json();
		if (!session.authenticated) {
			window.location.href = "/admin/login.html";
			return null;
		}
		return session.authType === "host" ? ROLES.HOST : ROLES.ADMIN;
	} catch {
		window.location.href = "/admin/login.html";
		return null;
	}
}

/**
 * @description Starts the console.
 * @returns {Promise<void>} Resolves once the shell is mounted.
 */
async function boot() {
	const hostMode = readHostMode();
	const role = await resolveRole();
	if (!role) return;

	const store = createStore({
		role,
		status: "connecting",
		statusDetail: "",
		lobby: null,
		lobbyState: null,
		lobbies: [],
		incidents: [],
		repairs: [],
		feed: [],
		sfxResult: null,
	});

	const socket = window.io();
	const bridge = createSocketBridge({ socket, store, toText: plainText });

	if (hostMode.isHost && hostMode.lobby && hostMode.characterId) {
		startHostSession({ socket, bridge, hostMode });
	}

	mountShell({ store, bridge, role, hostMode });
}

/**
 * @description Authenticates the host view and connects it to their lobby.
 *
 *   The host presented a signed character file over HTTP to get here; the socket
 *   needs telling separately, because authorisation is per-socket rather than
 *   per-cookie once the connection is open.
 * @param {object} deps - Collaborators.
 * @param {object} deps.socket - The socket.
 * @param {object} deps.bridge - The action surface.
 * @param {object} deps.hostMode - The parsed query parameters.
 * @returns {void}
 */
function startHostSession({ socket, bridge, hostMode }) {
	document.title = `DM Console — ${hostMode.lobby}`;

	const authenticate = () => bridge.hostAuth(hostMode.lobby, hostMode.characterId);
	socket.on("host:auth:ok", ({ lobbyCode }) => {
		window.location.hash = buildRoute({ lobby: lobbyCode, section: "dashboard" });
		bridge.connectLobby(lobbyCode);
	});

	if (socket.connected) authenticate();
	else socket.on("connect", authenticate);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Shell
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @description Builds the chrome and wires it to the route and the store.
 * @param {object} deps - Collaborators.
 * @param {object} deps.store - The store.
 * @param {object} deps.bridge - The action surface.
 * @param {string} deps.role - The viewer's role.
 * @param {object} deps.hostMode - The parsed query parameters.
 * @returns {void}
 */
function mountShell({ store, bridge, role, hostMode }) {
	const allowed = filterSections(role, SECTIONS);

	/** Teardown callbacks for whatever section is currently mounted. */
	let cleanups = [];

	/**
	 * True while a render is in progress. Connecting to a lobby is a side effect of
	 * routing, and it patches the store, which would otherwise send the chrome
	 * watcher round to redraw a sidebar the render is about to draw anyway.
	 */
	let rendering = false;

	/**
	 * @description Moves to another route by changing the address, so that back,
	 *   forward and reload all behave.
	 * @param {{lobby?: string|null, section?: string}} route - Where to go.
	 * @returns {void}
	 */
	function navigate(route) {
		const next = buildRoute(route);
		if (window.location.hash === next) render();
		else window.location.hash = next;
	}

	// ── chrome ────────────────────────────────────────────────────────────────

	const statusEl = h("span.status-pill", { title: "" });
	const switcherEl = h("select.lobby-switcher", {
		"aria-label": "Connected lobby",
		onChange: (e) => e.target.value && navigate({ lobby: e.target.value, section: currentSectionId() }),
	});
	const navEl = h("nav.shell-nav", { "aria-label": "Sections" });
	const mainEl = h("main.shell-main", { id: "shellMain", tabindex: "-1" });

	const header = h("header.shell-header",
		h("div.brand",
			h("span.brand-mark", "⌘"),
			h("span.brand-name", hostMode.isHost ? "DM Console" : "StoryTeller Admin"),
		),
		hostMode.isHost ? h("span.host-chip", "Host") : switcherEl,
		h("div.header-right",
			statusEl,
			can(role, CAP.SESSION_END) && h("button.btn.btn-ghost", { onClick: logout }, "Log out"),
		),
	);

	// Filled rather than replacing the body, which would tear out the script tags
	// the console is currently running from.
	fill(document.getElementById("root"), h("div.shell", header, navEl, mainEl));

	// ── rendering ─────────────────────────────────────────────────────────────

	/**
	 * @description The section currently on screen, for preserving it across a
	 *   lobby switch.
	 * @returns {string} A section id.
	 */
	function currentSectionId() {
		return parseRoute(window.location.hash).section;
	}

	/**
	 * @description Draws the sidebar, marking the active section and any badges.
	 * @param {object|null} active - The section being shown.
	 * @returns {void}
	 */
	function renderNav(active) {
		const unresolved = (store.getState().incidents ?? []).filter((i) => !i.resolved).length;
		const lobby = store.getState().lobby;

		fill(navEl, groupSections(allowed).map((group) => h("div.nav-group",
			h("h2.nav-heading", group.group),
			group.sections.map((section) => {
				const reachable = section.scope === "global" || lobby !== null;
				const badge = section.badge === "incidents" && unresolved > 0;
				return h("button.nav-item", {
					class: [
						section.id === active?.id ? "is-active" : "",
						reachable ? "" : "is-unreachable",
						badge ? "has-badge" : "",
					].filter(Boolean).join(" "),
					disabled: !reachable,
					title: reachable ? "" : "Connect to a lobby first",
					onClick: () => navigate({
						lobby: section.scope === "lobby" ? lobby : null,
						section: section.id,
					}),
				},
					h("span.nav-label", section.label),
					badge && h("span.nav-badge", { title: `${unresolved} unresolved` }, String(unresolved)),
				);
			}),
		)));
	}

	/**
	 * @description Refreshes the connection pill.
	 * @returns {void}
	 */
	function renderStatus() {
		const { status, statusDetail, lobby } = store.getState();
		statusEl.className = `status-pill is-${status}`;
		statusEl.textContent = status === "connected" && lobby
			? `Live · ${lobby}`
			: (STATUS_LABEL[status] ?? status);
		statusEl.title = statusDetail || "";
	}

	/**
	 * @description Refreshes the lobby switcher without disturbing an open dropdown.
	 * @returns {void}
	 */
	function renderSwitcher() {
		if (hostMode.isHost || document.activeElement === switcherEl) return;
		const { lobbies, lobby } = store.getState();
		const cards = selectLobbyCards(lobbies, lobby);

		fill(switcherEl,
			h("option", { value: "" }, lobby ? "Switch lobby…" : "No lobby connected"),
			cards.map((card) => h("option", { value: card.code },
				`${card.adventureName} · ${card.code} · ${card.playerCount}p`)),
		);
		switcherEl.value = lobby ?? "";
	}

	/**
	 * @description Tears down the mounted section and draws the routed one.
	 * @returns {void}
	 */
	function render() {
		rendering = true;
		try {
			draw();
		} finally {
			rendering = false;
		}
	}

	/**
	 * @description Draws the routed section and the chrome around it.
	 * @returns {void}
	 */
	function draw() {
		const route = parseRoute(window.location.hash);
		const view = resolveView({ route, role });

		// Correct the address rather than leaving it pointing somewhere unreachable,
		// so a reload or a copied link goes where the panel actually is.
		if (view.redirected && view.section) {
			const corrected = buildRoute({
				lobby: view.section.scope === "lobby" ? view.lobby : null,
				section: view.section.id,
			});
			if (window.location.hash !== corrected) {
				window.location.replace(corrected);
				return;
			}
		}

		// The route is the source of truth for which lobby is open, so a pasted link
		// connects rather than showing an empty frame.
		if (view.lobby && view.lobby !== store.getState().lobby) bridge.connectLobby(view.lobby);

		for (const cleanup of cleanups.splice(0)) cleanup();
		renderNav(view.section);

		if (!view.section) {
			fill(mainEl, h("div.panel", h("p.muted", "Waiting for a lobby…")));
			return;
		}

		fill(mainEl, renderSection({
			section: view.section,
			store,
			bridge,
			role,
			navigate,
			onCleanup: (fn) => cleanups.push(fn),
		}));
	}

	// ── wiring ────────────────────────────────────────────────────────────────

	/**
	 * @description Resolves the view for whatever the address bar currently says.
	 * @returns {{section: object|null, lobby: string|null, redirected: boolean}} The view.
	 */
	function currentView() {
		return resolveView({ route: parseRoute(window.location.hash), role });
	}

	window.addEventListener("hashchange", render);

	store.watch((s) => s.status, renderStatus);
	store.watch((s) => (s.lobbies ?? []).map((l) => l.code).join(","), renderSwitcher);
	store.watch(
		(s) => (s.incidents ?? []).filter((i) => !i.resolved).length,
		() => renderNav(currentView().section),
	);

	store.watch((s) => s.lobby, (lobby) => {
		renderStatus();
		renderSwitcher();

		// The route owns which lobby is displayed, so a lobby appearing *because*
		// the route asked for it needs no re-render — re-entering render() here
		// would remount the section and discard anything typed into it. A lobby
		// disappearing is different: the route now points at nothing, so correct it.
		if (lobby === null && parseRoute(window.location.hash).lobby) navigate({ section: GLOBAL_SECTION });
		else if (!rendering) renderNav(currentView().section);
	});

	renderStatus();
	renderSwitcher();
	render();

	if (can(role, CAP.LOBBY_BROWSE)) startLobbyPolling(store);
}

/**
 * @description Keeps the lobby list current for the switcher and the Lobbies section.
 *
 *   Polled rather than pushed: `lobbies:update` is broadcast to a room this socket
 *   does not join, and joining it would mean the panel receiving every lobby-list
 *   change for the whole server whether or not anyone is looking at one.
 * @param {object} store - The store to write into.
 * @returns {void}
 */
function startLobbyPolling(store) {
	const load = async () => {
		try {
			const res = await fetch("/api/lobbies");
			const { lobbies = [] } = await res.json();
			store.patch({ lobbies });
		} catch {
			// A failed poll is not worth reporting; the next one is 15 seconds away
			// and the connection pill already shows whether the server is reachable.
		}
	};
	load();
	window.setInterval(load, LOBBY_POLL_MS);
}

/**
 * @description Ends the admin session and returns to the login page.
 * @returns {Promise<void>} Resolves once the redirect is issued.
 */
async function logout() {
	try {
		await fetch("/api/admin/logout", { method: "POST" });
	} finally {
		window.location.href = "/admin/login.html";
	}
}

boot();
