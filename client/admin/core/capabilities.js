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
 * @description Lists the capabilities held by a role.
 * @param {string} role - An entry of {@link ROLES}.
 * @returns {Set<string>} The held capabilities; empty for an unrecognised role.
 */
export function capabilitiesFor(role) {
	return new Set();
}

/**
 * @description Reports whether a role holds a capability.
 * @param {string} role - An entry of {@link ROLES}.
 * @param {string} capability - An entry of {@link CAP}.
 * @returns {boolean} Whether the role holds it.
 */
export function can(role, capability) {
	return false;
}

/**
 * @description Keeps only the sections a role may see.
 * @param {string} role - An entry of {@link ROLES}.
 * @param {Array<object>} sections - Section descriptors carrying a `requires`.
 * @returns {Array<object>} The permitted subset, in the order given.
 */
export function filterSections(role, sections) {
	return [];
}
