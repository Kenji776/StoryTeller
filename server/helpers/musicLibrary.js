/**
 * Finding the tracks for one world and mood, across both layouts that exist in the wild.
 *
 * There are two, and only one of them used to work:
 *
 * - **Mood folders** — `game/<world>/<mood>/*.mp3`. What somebody gets if they organise a library by
 *   hand, and what the route was written for.
 * - **A flat world folder** — `game/<world>/<mood>_<title>_<id>.mp3`. What the downloaded asset pack
 *   actually produces, and therefore what every fresh install has.
 *
 * Only the first was read, so music downloaded successfully on first run — the log even said how many
 * tracks — and then never played, for anyone who had not organised their own library. The failure was
 * silent on both sides: the pack extracted fine, and the route answered an empty list rather than an
 * error.
 *
 * Extracted from an inline route handler in `server.js` so the rule can be tested, which is also why
 * the traversal check moved here: it belongs with the path building rather than being a thing the
 * caller must remember.
 */

/** A path segment may not contain a separator or a dot, so nothing can climb out of the music dir. */
const UNSAFE_SEGMENT = /[./\\]/;

/**
 * Lists the mp3s for one world and mood.
 *
 * @description Prefers an explicit mood folder: someone who has arranged their library that way meant
 *   it, and loose files in the world folder should not be mixed into a curated set.
 * @param {object} options - The query.
 * @param {object} options.fsImpl - Node's `fs`, or a double. Needs `existsSync` and `readdirSync`.
 * @param {string} options.gameMusicDir - Absolute path to `client/music/game`.
 * @param {string} options.world - World type, e.g. `default` or `ancient_egypt`.
 * @param {string} options.mood - Mood key, e.g. `tavern` or `boss_fight`.
 * @returns {Array<string>} File names, relative to the world folder or the mood folder. Empty for
 *   anything missing, unsafe, or unreadable — a missing soundtrack must never fail a turn.
 */
export function listMoodTracks({ fsImpl, gameMusicDir, world, mood } = {}) {
	if (![fsImpl, gameMusicDir, world, mood].every(Boolean)) return [];
	if ([world, mood].some((segment) => UNSAFE_SEGMENT.test(segment))) return [];

	const isTrack = (name) => String(name).toLowerCase().endsWith(".mp3");

	try {
		const moodFolder = `${gameMusicDir}/${world}/${mood}`;
		if (fsImpl.existsSync(moodFolder)) {
			return fsImpl.readdirSync(moodFolder).filter(isTrack);
		}

		const worldFolder = `${gameMusicDir}/${world}`;
		if (!fsImpl.existsSync(worldFolder)) return [];

		// The underscore is what makes the boundary: `sad` must not claim `sad_moment`'s tracks, and
		// `victory` must not claim something merely starting with those letters.
		const prefix = `${mood}_`;
		return fsImpl.readdirSync(worldFolder)
			.filter(isTrack)
			.filter((name) => name.toLowerCase().startsWith(prefix));
	} catch {
		return [];
	}
}
