import { test } from "node:test";
import assert from "node:assert/strict";

import { galleryIndexView, slideView } from "./galleryView.js";

const AT = Date.UTC(2026, 6, 28, 14, 30, 0);

/**
 * @description Builds a gallery entry as the store records it.
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} The entry.
 */
function entry(overrides = {}) {
	return {
		id: "g1_1",
		at: AT,
		kind: "scene",
		caption: "standing over the slain troll",
		narration: "Brannor's axe comes down and the troll folds.",
		characters: ["Brannor Ironfoot"],
		images: [{ name: "Brannor Ironfoot", url: "/character-images/a.png" }],
		...overrides,
	};
}

// ── The index ────────────────────────────────────────────────────────────────

test("each game becomes a card with a title, a count and a cover", () => {
	const [card] = galleryIndexView([
		{ lobbyId: "l1", code: "ABC123", adventureName: "Shadows of the Commonborn", count: 7, cover: "/a.png", updatedAt: AT },
	]);

	assert.equal(card.lobbyId, "l1");
	assert.equal(card.title, "Shadows of the Commonborn");
	assert.match(card.subtitle, /7 moments/);
	assert.equal(card.cover, "/a.png");
});

test("a game that was never named still gets a usable title", () => {
	const [card] = galleryIndexView([{ lobbyId: "l1", code: "ABC123", adventureName: null, count: 2, cover: "/a.png" }]);

	assert.ok(card.title.length > 0);
	assert.doesNotMatch(card.title, /null|undefined/);
	assert.match(card.title, /ABC123|untitled/i);
});

test("one moment reads as singular", () => {
	const [card] = galleryIndexView([{ lobbyId: "l1", count: 1, cover: "/a.png" }]);
	assert.match(card.subtitle, /1 moment\b/);
	assert.doesNotMatch(card.subtitle, /1 moments/);
});

test("a game with no cover image is left out rather than rendered as a broken card", () => {
	assert.deepEqual(galleryIndexView([{ lobbyId: "l1", count: 3, cover: null }]), []);
});

test("an absent or malformed list yields no cards", () => {
	for (const value of [null, undefined, {}, "nope"]) assert.deepEqual(galleryIndexView(value), []);
});

// ── The slideshow ────────────────────────────────────────────────────────────

test("each entry becomes a slide carrying its pictures and its caption", () => {
	const [slide] = slideView({ entries: [entry()] });

	assert.equal(slide.caption, "standing over the slain troll");
	assert.equal(slide.images.length, 1);
	assert.match(slide.images[0].alt, /Brannor/);
	assert.match(slide.narration, /axe comes down/);
});

test("the people in frame are named, so a viewer knows who they are looking at", () => {
	const [slide] = slideView({ entries: [entry({ characters: ["Brannor Ironfoot", "Kaeda Ashfall"] })] });
	assert.match(slide.who, /Brannor Ironfoot/);
	assert.match(slide.who, /Kaeda Ashfall/);
});

test("a scene with nobody in it says nothing about who is in it", () => {
	const [slide] = slideView({ entries: [entry({ characters: [], images: [{ name: null, url: "/a.png" }] })] });
	assert.equal(slide.who, "");
});

test("the opening is labelled as the beginning", () => {
	const [slide] = slideView({ entries: [entry({ kind: "opening", caption: "The adventure begins" })] });
	assert.match(slide.caption, /adventure begins/i);
	assert.equal(slide.isOpening, true);
});

test("slides carry a readable time rather than a raw number", () => {
	const [slide] = slideView({ entries: [entry()] });
	assert.doesNotMatch(slide.when, /^\d{10,}$/);
	assert.ok(slide.when.length > 0);
});

test("slides keep the order the game produced them", () => {
	const slides = slideView({
		entries: [entry({ caption: "first" }), entry({ caption: "second" }), entry({ caption: "third" })],
	});
	assert.deepEqual(slides.map((s) => s.caption), ["first", "second", "third"]);
});

test("an entry whose pictures are all missing is skipped", () => {
	const slides = slideView({ entries: [entry({ images: [] }), entry({ caption: "kept" })] });
	assert.deepEqual(slides.map((s) => s.caption), ["kept"]);
});

test("a gallery with no entries yields no slides", () => {
	for (const value of [{ entries: [] }, {}, null, undefined]) assert.deepEqual(slideView(value), []);
});

test("a slide's alt text falls back to the caption when nobody is named", () => {
	const [slide] = slideView({ entries: [entry({ characters: [], images: [{ name: null, url: "/a.png" }] })] });
	assert.match(slide.images[0].alt, /slain troll/);
});
