import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";

import { createGallery } from "./gallery.js";

const DIR = "/galleries";
const LOBBY = "lobby-1";
const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);

/**
 * @description Builds an in-memory filesystem double.
 * @param {object} [seed] - Initial path→contents map.
 * @returns {object} An fs-shaped double.
 */
function makeFs(seed = {}) {
	const files = { ...seed };
	const dirs = new Set([DIR]);
	return {
		files,
		// Directories exist separately from files: the store checks for its own
		// directory before listing, which a file-only double answers wrongly.
		existsSync: (p) => Object.hasOwn(files, p) || dirs.has(p),
		mkdirSync: (p) => dirs.add(p),
		readFileSync: (p) => {
			if (!Object.hasOwn(files, p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[p];
		},
		writeFileSync: (p, data) => { files[p] = data; },
		readdirSync: () => Object.keys(files).map((f) => path.basename(f)),
		unlinkSync: (p) => { delete files[p]; },
	};
}

/**
 * @description Builds a gallery over a fake filesystem and a frozen clock.
 * @param {object} [options] - Overrides.
 * @returns {object} The gallery and its filesystem.
 */
function makeGallery({ fsImpl = makeFs(), now = () => T0 } = {}) {
	return { gallery: createGallery({ fsImpl, dir: DIR, now, log: () => {} }), fsImpl };
}

/** One illustration, as the runner reports it. */
const ENTRY = {
	caption: "standing over the slain troll",
	narration: "Brannor's axe comes down and the troll folds like a dropped coat.",
	characters: ["Brannor Ironfoot"],
	images: [{ name: "Brannor Ironfoot", url: "/character-images/a.png" }],
};

// ── Recording ────────────────────────────────────────────────────────────────

test("an illustration is recorded with its caption and the moment it belongs to", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, ENTRY);

	const [entry] = gallery.read(LOBBY).entries;
	assert.equal(entry.caption, "standing over the slain troll");
	assert.match(entry.narration, /folds like a dropped coat/);
	assert.deepEqual(entry.images.map((i) => i.url), ["/character-images/a.png"]);
	assert.equal(entry.at, T0);
});

test("entries accumulate in the order they happened", () => {
	let clock = T0;
	const { gallery } = makeGallery({ now: () => clock });

	gallery.record(LOBBY, { ...ENTRY, caption: "first" });
	clock = T0 + 60_000;
	gallery.record(LOBBY, { ...ENTRY, caption: "second" });

	assert.deepEqual(gallery.read(LOBBY).entries.map((e) => e.caption), ["first", "second"]);
});

test("each entry gets an id, so a slideshow can address one", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, ENTRY);
	gallery.record(LOBBY, { ...ENTRY, caption: "another" });

	const ids = gallery.read(LOBBY).entries.map((e) => e.id);
	assert.equal(new Set(ids).size, 2);
	assert.ok(ids.every(Boolean));
});

test("the adventure's name is kept alongside, so a gallery has a title", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, { ...ENTRY, adventureName: "Shadows of the Commonborn", code: "9BSM7T" });

	const read = gallery.read(LOBBY);
	assert.equal(read.adventureName, "Shadows of the Commonborn");
	assert.equal(read.code, "9BSM7T");
});

test("a later entry does not lose an adventure name recorded earlier", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, { ...ENTRY, adventureName: "Named Once" });
	gallery.record(LOBBY, ENTRY);

	assert.equal(gallery.read(LOBBY).adventureName, "Named Once");
});

test("an entry with no images is not recorded, because a gallery of nothing is noise", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, { ...ENTRY, images: [] });
	assert.equal(gallery.read(LOBBY), null);
});

test("recording survives a reopened gallery, which is the whole point", () => {
	const fsImpl = makeFs();
	makeGallery({ fsImpl }).gallery.record(LOBBY, ENTRY);

	const { gallery } = makeGallery({ fsImpl });
	assert.equal(gallery.read(LOBBY).entries.length, 1);
});

// ── Reading ──────────────────────────────────────────────────────────────────

test("a lobby that never drew anything has no gallery", () => {
	assert.equal(makeGallery().gallery.read(LOBBY), null);
});

test("a corrupt gallery file reads as absent rather than throwing", () => {
	// A gallery is a keepsake. Losing one must never take down the page that lists
	// the others, let alone the server.
	const { gallery } = makeGallery({ fsImpl: makeFs({ [path.join(DIR, `${LOBBY}.json`)]: "{ not json" }) });
	assert.equal(gallery.read(LOBBY), null);
});

test("galleries can be listed newest first, for an index page", () => {
	let clock = T0;
	const fsImpl = makeFs();
	const { gallery } = makeGallery({ fsImpl, now: () => clock });

	gallery.record("older", { ...ENTRY, adventureName: "Older" });
	clock = T0 + 3600_000;
	gallery.record("newer", { ...ENTRY, adventureName: "Newer" });

	assert.deepEqual(gallery.list().map((g) => g.adventureName), ["Newer", "Older"]);
});

test("a listing carries enough to render a card without opening the gallery", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, { ...ENTRY, adventureName: "A Tale", code: "ABC123" });

	const [card] = gallery.list();
	assert.equal(card.lobbyId, LOBBY);
	assert.equal(card.adventureName, "A Tale");
	assert.equal(card.count, 1);
	assert.ok(card.cover, "a card with no cover image cannot be rendered");
});

test("listing with no galleries at all is empty rather than an error", () => {
	assert.deepEqual(makeGallery().gallery.list(), []);
});

// ── Boundaries ───────────────────────────────────────────────────────────────

test("a lobby id that would escape the directory is refused", () => {
	const { gallery, fsImpl } = makeGallery();
	// The id reaches this from a URL. A traversal would let a request read or
	// write anywhere the process can.
	assert.throws(() => gallery.record("../../etc/passwd", ENTRY), /lobby/i);
	assert.equal(gallery.read("../../etc/passwd"), null);
	assert.deepEqual(Object.keys(fsImpl.files), []);
});

test("a blank lobby id is refused", () => {
	const { gallery } = makeGallery();
	assert.throws(() => gallery.record("", ENTRY), /lobby/i);
	assert.equal(gallery.read(""), null);
});

test("a caption is clamped rather than stored whole", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, { ...ENTRY, caption: "x".repeat(2000) });

	assert.ok(gallery.read(LOBBY).entries[0].caption.length <= 400);
});

test("a gallery can be forgotten", () => {
	const { gallery } = makeGallery();
	gallery.record(LOBBY, ENTRY);

	assert.equal(gallery.forget(LOBBY), true);
	assert.equal(gallery.read(LOBBY), null);
});

test("forgetting a gallery that never existed reports so", () => {
	assert.equal(makeGallery().gallery.forget(LOBBY), false);
});

test("a gallery never carries anything credential-shaped", () => {
	const { gallery, fsImpl } = makeGallery();
	gallery.record(LOBBY, { ...ENTRY, narration: "the DM said sk-ant-api03-SHOULDNOTBEHERE" });

	// Narration is model output and could echo anything back; the gallery is a file
	// an operator may share.
	assert.ok(!JSON.stringify(fsImpl.files).includes("sk-ant-api03-SHOULDNOTBEHERE"));
});
