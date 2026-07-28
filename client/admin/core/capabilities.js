/**
 * capabilities — what each kind of admin is allowed to see and do.
 *
 * The old panel decided this by deleting DOM nodes after render, which meant the
 * answer to "what may a host do?" existed only as a sequence of removals scattered
 * through the bootstrap. Here it is a declaration, so the shell can render the
 * right thing the first time and a reader can check the rule without tracing code.
 *
 * This is presentation only. The authorisation boundary is `isSocketAdmin()` in
 * `server/routes/adminEvents.js`, which is unchanged and remains the only thing
 * standing between a request and the lobby.
 */

/** The two kinds of authenticated admin, matching `/api/admin/session`'s `authType`. */
export const ROLES = Object.freeze({ ADMIN: "admin", HOST: "host" });

/** Every capability a section or action can require. */
export const CAP = Object.freeze({
	LOBBY_BROWSE: "lobby:browse",
	LOBBY_DELETE: "lobby:delete",
	CHAR_FILES: "char:files",
	SESSION_END: "session:end",
	PLAY: "play",
	OPERATE: "operate",
	INSPECT: "inspect",
});

/**
 * What each role holds.
 *
 * A host reached this panel by presenting a signed character file for one lobby, so
 * they get the tools for running that game and none of the tools for reaching past
 * it. They have no password session to end, either — logging out would clear a
 * cookie they did not obtain here.
 */
const BY_ROLE = Object.freeze({
	[ROLES.ADMIN]: Object.freeze([
		CAP.LOBBY_BROWSE,
		CAP.LOBBY_DELETE,
		CAP.CHAR_FILES,
		CAP.SESSION_END,
		CAP.PLAY,
		CAP.OPERATE,
		CAP.INSPECT,
	]),
	[ROLES.HOST]: Object.freeze([CAP.PLAY, CAP.OPERATE, CAP.INSPECT]),
});

/**
 * @description Normalises a role as it arrives from `/api/admin/session`.
 * @param {*} role - The raw `authType` value.
 * @returns {string} A lower-cased, trimmed role, or the empty string.
 */
function normalise(role) {
	return typeof role === "string" ? role.trim().toLowerCase() : "";
}

/**
 * @description Lists the capabilities held by a role.
 *
 *   An unrecognised role holds nothing. The role comes from a fetch that may have
 *   failed or returned something unexpected, and rendering an empty shell is
 *   recoverable in a way that rendering the delete button is not.
 * @param {string} role - An entry of {@link ROLES}.
 * @returns {Set<string>} The held capabilities; a fresh set, safe for the caller to
 *   mutate without widening anyone's permissions.
 */
export function capabilitiesFor(role) {
	return new Set(BY_ROLE[normalise(role)] ?? []);
}

/**
 * @description Reports whether a role holds a capability.
 * @param {string} role - An entry of {@link ROLES}.
 * @param {string} capability - An entry of {@link CAP}.
 * @returns {boolean} Whether the role holds it.
 */
export function can(role, capability) {
	if (typeof capability !== "string") return false;
	return (BY_ROLE[normalise(role)] ?? []).includes(capability);
}

/**
 * @description Keeps only the sections a role may see.
 *
 *   A section that declares no `requires` is shown to anyone who got past the login
 *   page; gating is opt-in per section rather than something each one must remember
 *   to ask for.
 * @param {string} role - An entry of {@link ROLES}.
 * @param {Array<object>} sections - Section descriptors, each optionally carrying a
 *   `requires` capability.
 * @returns {Array<object>} A new array holding the permitted subset, in the order given.
 */
export function filterSections(role, sections) {
	if (!Array.isArray(sections)) return [];
	const held = BY_ROLE[normalise(role)] ?? [];
	return sections.filter((section) => !section?.requires || held.includes(section.requires));
}
