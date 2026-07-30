/**
 * When the battle map's own window should open, and when it should close.
 *
 * Kept apart from the DOM for the usual reason: `window.open` cannot be unit tested, but deciding
 * *whether* to call it is all rules, and the rules are where this gets subtly wrong. Popping a window
 * open on a player who closed it thirty seconds ago is the kind of behaviour that makes a feature
 * something people switch off.
 */

/**
 * @description Identifies an arena, so a new encounter can be told from a redraw of the current one.
 *   Mirrors the private `signatureOf` in `tacticalMap.js`; both answer the same question about the
 *   same payload, and neither is the other's caller.
 * @param {object|null} map - An arena, or null.
 * @returns {string} A stable identity for that arena.
 */
export function arenaSignature(map) {
	if (!map) return "none";
	return [map.seed, map.width, map.height, map.archetype].join("|");
}

/**
 * Decides what to do with the map window given what just arrived.
 *
 * @description Four rules, and the third is the one that matters for whether people keep the feature
 *   on:
 *
 *   - The fight ends and the window closes itself. Leaving a dead arena floating over someone's
 *     screen makes them close it by hand every time.
 *   - A fight starts and the window opens, once.
 *   - Somebody who closes the window is left alone **for that fight**. Reopening it on the next map
 *     push would fight the player for control of their own screen.
 *   - The next fight is a fresh start, so the window returns. A choice made about one encounter is
 *     not a standing preference — that is what the setting in the options window is for.
 * @param {object} now - The situation.
 * @param {object|null} now.map - The arena that just arrived, or null when combat is over.
 * @param {boolean} now.isOpen - Whether the window is currently open.
 * @param {string|null} now.dismissedFor - The signature of the arena the player closed the window on.
 * @returns {{action: "open"|"close"|"redraw"|"none", dismissedFor: string|null}} What to do, and the
 *   dismissal to remember. `redraw` means the window is already showing the right fight.
 */
export function mapWindowIntent({ map = null, isOpen = false, dismissedFor = null } = {}) {
	const signature = arenaSignature(map);

	if (!map) {
		// Combat over. The dismissal goes with it: it belonged to that fight, and keeping it would
		// silently suppress the window for the next one.
		return { action: isOpen ? "close" : "none", dismissedFor: null };
	}

	// A different fight clears a dismissal made about the previous one.
	const dismissed = dismissedFor === signature ? signature : null;

	if (isOpen) return { action: "redraw", dismissedFor: dismissed };
	if (dismissed) return { action: "none", dismissedFor: dismissed };
	return { action: "open", dismissedFor: null };
}
