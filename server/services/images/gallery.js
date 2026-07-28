/**
 * The record of what a game looked like.
 *
 * Every illustration a game produces is written here with the moment it belongs
 * to and the narration around it, so that afterwards the pictures read as a story
 * rather than as a folder of PNGs nobody can place.
 *
 * **It deliberately outlives the lobby.** Lobby state is deleted when a game ends
 * or is cleaned up, and a keepsake that vanishes with the game is not a keepsake.
 * Galleries live in their own directory and are forgotten only when asked.
 *
 * Nothing here can throw into a game. A gallery is a garnish: losing one must
 * never cost a turn, so reads degrade to "no gallery" and a corrupt file is
 * treated as absent rather than as a fault.
 */

import path from "path";
import fsDefault from "fs";

/** Longest caption and narration excerpt kept. Enough to read, not to flood. */
const CAPTION_MAX = 400;
const NARRATION_MAX = 700;

/**
 * Credentials, scrubbed before anything is written.
 *
 * Narration is model output, and a gallery is a file an operator may well share.
 * The same two-rule shape as `illustrationRunner`: prefixes explicitly, plus a
 * length rule high enough to leave ordinary prose alone.
 */
const CREDENTIAL_PREFIXES = /(sk-[A-Za-z0-9-]+|ghp_\S+|github_pat_\S+|xoxb-\S+|AKIA\S+)/g;

/**
 * @description Trims, scrubs and clamps a piece of text bound for the record.
 * @param {*} value - The candidate.
 * @param {number} max - Longest kept.
 * @returns {string} The cleaned text.
 */
function clean(value, max) {
	if (typeof value !== "string") return "";
	return value
		.replace(CREDENTIAL_PREFIXES, "***")
		.replace(/\S{32,}/g, "***")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

/**
 * @description Validates a lobby id used as a filename. It arrives from a URL, so
 *   a traversal would let a request read or write anywhere the process can.
 * @param {*} lobbyId - The candidate.
 * @returns {string} The safe id.
 * @throws {TypeError} When the id is blank or is not a plain identifier.
 */
function safeId(lobbyId) {
	const id = typeof lobbyId === "string" ? lobbyId.trim() : "";
	if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new TypeError(`A gallery lobby id must be a plain identifier, received ${JSON.stringify(lobbyId)}.`);
	}
	return id;
}

/**
 * Creates the gallery store.
 *
 * @param {object} options - Injected dependencies.
 * @param {object} [options.fsImpl=fs] - Filesystem implementation.
 * @param {string} options.dir - Directory holding one file per gallery.
 * @param {Function} [options.now] - Clock returning epoch milliseconds.
 * @param {Function} [options.log] - Logger.
 * @returns {object} The gallery store.
 */
export function createGallery({ fsImpl = fsDefault, dir, now = () => Date.now(), log = () => {} }) {
	/**
	 * @description The file one gallery lives in.
	 * @param {string} id - A validated lobby id.
	 * @returns {string} The path.
	 */
	const fileFor = (id) => path.join(dir, `${id}.json`);

	/**
	 * @description Reads a gallery without throwing. A corrupt keepsake must not
	 *   take down the page listing the others.
	 * @param {string} id - A validated lobby id.
	 * @returns {object|null} The gallery, or null.
	 */
	function load(id) {
		try {
			if (!fsImpl.existsSync(fileFor(id))) return null;
			const parsed = JSON.parse(fsImpl.readFileSync(fileFor(id), "utf8"));
			return Array.isArray(parsed?.entries) ? parsed : null;
		} catch (err) {
			log(`⚠️ Gallery for ${id} could not be read: ${err.message}`);
			return null;
		}
	}

	return {
		/**
		 * Adds one illustration to a game's record.
		 *
		 * @description The adventure name and code are recorded on first sight and
		 *   never overwritten by a later entry that lacks them — a game is named
		 *   once, and a nameless later beat should not erase it.
		 * @param {string} lobbyId - The game.
		 * @param {object} entry - What was drawn.
		 * @param {string} entry.caption - The moment illustrated.
		 * @param {string} [entry.narration] - The DM's words at that beat.
		 * @param {Array<string>} [entry.characters] - Who is in frame.
		 * @param {Array<object>} entry.images - `{name, url}` for each picture.
		 * @param {string} [entry.adventureName] - The game's title.
		 * @param {string} [entry.code] - The lobby code players joined with.
		 * @param {string} [entry.kind] - "opening" or "scene".
		 * @returns {object|null} The stored entry, or null when there was nothing to store.
		 * @throws {TypeError} When the lobby id is not a plain identifier.
		 */
		record(lobbyId, entry = {}) {
			const id = safeId(lobbyId);
			const images = (Array.isArray(entry.images) ? entry.images : []).filter((i) => i?.url);
			// A gallery entry with no picture is noise: there is nothing to show and
			// nothing a slideshow could do with it.
			if (!images.length) return null;

			const gallery = load(id) ?? { lobbyId: id, adventureName: null, code: null, entries: [] };

			gallery.adventureName = gallery.adventureName || clean(entry.adventureName, 120) || null;
			gallery.code = gallery.code || clean(entry.code, 16) || null;

			const stored = {
				id: `g${gallery.entries.length + 1}_${now()}`,
				at: now(),
				kind: entry.kind === "opening" ? "opening" : "scene",
				caption: clean(entry.caption, CAPTION_MAX),
				narration: clean(entry.narration, NARRATION_MAX),
				characters: (Array.isArray(entry.characters) ? entry.characters : []).map((n) => clean(n, 80)).filter(Boolean),
				images: images.map((i) => ({ name: clean(i.name, 80) || null, url: String(i.url) })),
			};
			gallery.entries.push(stored);
			gallery.updatedAt = now();

			try {
				if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
				fsImpl.writeFileSync(fileFor(id), `${JSON.stringify(gallery, null, "\t")}\n`, "utf8");
			} catch (err) {
				// Never into the game. The picture already exists on disk; only the
				// record of what it meant is lost.
				log(`⚠️ Could not write the gallery for ${id}: ${err.message}`);
				return null;
			}
			return stored;
		},

		/**
		 * @description Reads one game's gallery.
		 * @param {string} lobbyId - The game.
		 * @returns {object|null} The gallery, or null when there is none.
		 */
		read(lobbyId) {
			try {
				return load(safeId(lobbyId));
			} catch {
				// An unsafe id is not an error to a reader — it simply names no gallery.
				return null;
			}
		},

		/**
		 * @description Lists every gallery, newest first, with enough to render a
		 *   card without opening each one.
		 * @returns {Array<object>} The listings.
		 */
		list() {
			let names;
			try {
				names = fsImpl.existsSync(dir) ? fsImpl.readdirSync(dir) : [];
			} catch {
				return [];
			}

			return names
				.filter((name) => name.endsWith(".json"))
				.map((name) => load(name.replace(/\.json$/, "")))
				.filter(Boolean)
				.map((gallery) => ({
					lobbyId: gallery.lobbyId,
					code: gallery.code,
					adventureName: gallery.adventureName,
					count: gallery.entries.length,
					updatedAt: gallery.updatedAt ?? gallery.entries.at(-1)?.at ?? 0,
					cover: gallery.entries.find((e) => e.images?.[0]?.url)?.images[0].url ?? null,
				}))
				.filter((card) => card.count > 0)
				.sort((a, b) => b.updatedAt - a.updatedAt);
		},

		/**
		 * @description Forgets a game's gallery. Only ever on request — this is the
		 *   one thing that deliberately survives the lobby it belongs to.
		 * @param {string} lobbyId - The game.
		 * @returns {boolean} True when a gallery was removed.
		 */
		forget(lobbyId) {
			try {
				const id = safeId(lobbyId);
				if (!fsImpl.existsSync(fileFor(id))) return false;
				fsImpl.unlinkSync(fileFor(id));
				return true;
			} catch {
				return false;
			}
		},
	};
}
