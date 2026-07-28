/**
 * nav — the section registry, and the rule for which section a route resolves to.
 *
 * Every capability the panel offers is declared here exactly once: its label, the
 * group it sits under, whether it needs a connected lobby, and the capability a
 * role must hold to see it. The sidebar, the router and the role filter all read
 * from this list, so adding a section is one entry rather than four edits.
 */

import { CAP, filterSections } from "./core/capabilities.js";

/**
 * Every section, in the order the sidebar shows them.
 *
 * Grouping is by workflow rather than by the shape of the underlying data: an
 * admin arrives either to run a game, to fix one, or to look at how one is
 * configured, and the groups are named for those three intents.
 *
 * Health carries a badge because the whole point of promoting it out of the old
 * event-feed tab is that a broken game should be visible from wherever you are.
 */
export const SECTIONS = Object.freeze([
	{ id: "lobbies", label: "Lobbies", group: "All lobbies", scope: "global", requires: CAP.LOBBY_BROWSE },

	{ id: "dashboard", label: "Dashboard", group: "Play", scope: "lobby", requires: CAP.PLAY },
	{ id: "party", label: "Party", group: "Play", scope: "lobby", requires: CAP.PLAY },
	{ id: "turn", label: "Turn & Phase", group: "Play", scope: "lobby", requires: CAP.PLAY },
	{ id: "narrate", label: "Narration", group: "Play", scope: "lobby", requires: CAP.PLAY },
	{ id: "audio", label: "Audio", group: "Play", scope: "lobby", requires: CAP.PLAY },

	{ id: "health", label: "Health", group: "Operate", scope: "lobby", requires: CAP.OPERATE, badge: "incidents" },
	{ id: "activity", label: "Activity", group: "Operate", scope: "lobby", requires: CAP.OPERATE },

	{ id: "campaign", label: "Campaign", group: "Inspect", scope: "lobby", requires: CAP.INSPECT },
	{ id: "model", label: "AI Model", group: "Inspect", scope: "lobby", requires: CAP.INSPECT },
	{ id: "raw", label: "Raw State", group: "Inspect", scope: "lobby", requires: CAP.INSPECT },

	{ id: "toolbox", label: "Character Files", group: "Tools", scope: "global", requires: CAP.CHAR_FILES },
]);

/** Sections by id, built once. */
const BY_ID = new Map(SECTIONS.map((section) => [section.id, section]));

/**
 * @description Finds a section by id.
 * @param {string} id - The section id.
 * @returns {object|undefined} The section, or undefined.
 */
export function sectionById(id) {
	return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/**
 * @description Arranges sections into the groups the sidebar renders as headings.
 * @param {Array<object>} sections - Sections, already filtered by role.
 * @returns {Array<{group: string, sections: Array<object>}>} Groups in first-seen order.
 */
export function groupSections(sections) {
	if (!Array.isArray(sections)) return [];

	const groups = new Map();
	for (const section of sections) {
		const name = section?.group ?? "";
		if (!groups.has(name)) groups.set(name, []);
		groups.get(name).push(section);
	}
	return [...groups].map(([group, members]) => ({ group, sections: members }));
}

/**
 * @description Decides which section a route actually resolves to.
 *
 *   A route can ask for something unreachable in three ways: the section may not
 *   exist, the role may not hold its capability, or it may need a lobby when none
 *   is connected. All three fall back rather than rendering an empty frame, and
 *   report that they did so, so the shell can correct the address bar.
 *
 *   A host has no global section to fall back to — they reached this panel with a
 *   character file for one lobby — so they fall back to the first lobby section
 *   they can use, keeping the lobby they already have. Before that lobby arrives
 *   there is genuinely nothing to show, and the shell renders a waiting state.
 * @param {object} [options] - The request.
 * @param {{lobby: string|null, section: string}} [options.route] - The parsed route.
 * @param {string} [options.role] - The viewer's role.
 * @returns {{section: object|null, lobby: string|null, redirected: boolean}} What to
 *   render, and whether that differs from what was asked for.
 */
export function resolveView({ route, role } = {}) {
	const lobby = route?.lobby ?? null;
	const allowed = filterSections(role, SECTIONS);

	/**
	 * @description Reports whether a section can be rendered right now.
	 * @param {object} section - The candidate.
	 * @returns {boolean} Whether it is reachable.
	 */
	const reachable = (section) => section.scope === "global" || lobby !== null;

	const asked = sectionById(route?.section);
	if (asked && allowed.includes(asked) && reachable(asked)) {
		return { section: asked, lobby, redirected: false };
	}

	const fallback = allowed.find(reachable) ?? null;
	return { section: fallback, lobby, redirected: true };
}
