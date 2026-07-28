/**
 * Turning a game's record into something to look at.
 *
 * `gallery.html` has no test harness, so everything that could be got wrong lives
 * here: what a card says, what a slide shows, and what to do about the entries
 * that are missing a piece. The page does nothing but arrange elements.
 *
 * Nothing here decides *what* was drawn — that is the server's record. This only
 * decides how it reads.
 */

/**
 * @description Renders a count with the right plural, because "1 moments" in a
 *   keepsake is the kind of small wrongness that spoils it.
 * @param {number} count - How many.
 * @param {string} noun - The singular noun.
 * @returns {string} The phrase.
 */
function plural(count, noun) {
	const n = Number(count) || 0;
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * @description Formats an instant as something a person reads. Falls back to an
 *   empty string rather than "Invalid Date".
 * @param {*} at - Epoch milliseconds.
 * @returns {string} The formatted time.
 */
function readable(at) {
	const date = new Date(Number(at));
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Builds the index of every game that produced pictures.
 *
 * @description A game with no cover is left out rather than rendered as a broken
 *   card: a gallery index is entirely pictures, and one that cannot show a
 *   picture has nothing to offer.
 * @param {Array<object>} galleries - Listings from `GET /api/galleries`.
 * @returns {Array<{lobbyId: string, title: string, subtitle: string, cover: string}>} The cards.
 */
export function galleryIndexView(galleries) {
	if (!Array.isArray(galleries)) return [];

	return galleries
		.filter((gallery) => gallery?.cover)
		.map((gallery) => ({
			lobbyId: gallery.lobbyId,
			// A game that ended before the DM named it still deserves a title; the
			// code is what its players would recognise it by.
			title: gallery.adventureName || (gallery.code ? `Game ${gallery.code}` : "An untitled adventure"),
			subtitle: [plural(gallery.count, "moment"), readable(gallery.updatedAt)].filter(Boolean).join(" · "),
			cover: gallery.cover,
		}));
}

/**
 * Builds the slideshow for one game.
 *
 * @description Order is the order the game produced them, which is the only order
 *   a story reads in. An entry whose pictures have all gone missing is skipped:
 *   the caption alone is not a slide.
 * @param {object|null} gallery - A gallery from `GET /api/gallery/:lobbyId`.
 * @returns {Array<object>} The slides, oldest first.
 */
export function slideView(gallery) {
	const entries = Array.isArray(gallery?.entries) ? gallery.entries : [];

	return entries
		.map((entry) => {
			const images = (Array.isArray(entry?.images) ? entry.images : []).filter((image) => image?.url);
			if (!images.length) return null;

			const caption = entry.caption || "A moment from the game";
			const characters = (Array.isArray(entry.characters) ? entry.characters : []).filter(Boolean);

			return {
				id: entry.id,
				isOpening: entry.kind === "opening",
				caption,
				who: characters.length ? characters.join(", ") : "",
				narration: entry.narration || "",
				when: readable(entry.at),
				images: images.map((image) => ({
					url: image.url,
					// The name when there is one, the caption when there is not: alt text
					// saying "null" is worse than alt text saying what is happening.
					alt: image.name ? `${image.name} — ${caption}` : caption,
				})),
			};
		})
		.filter(Boolean);
}
