import test from "node:test";
import assert from "node:assert/strict";

import { hasRenderer, renderableIds } from "./index.js";
import { SECTIONS } from "../nav.js";

test("every section in the registry has something to render it", () => {
	// A nav entry with no renderer produces a blank frame and no error, which is the
	// hardest kind of gap to notice.
	for (const section of SECTIONS) {
		assert.equal(hasRenderer(section.id), true, `no renderer for "${section.id}"`);
	}
});

test("no renderer exists for a section the nav does not offer", () => {
	const known = new Set(SECTIONS.map((s) => s.id));
	for (const id of renderableIds()) {
		assert.equal(known.has(id), true, `"${id}" has a renderer but no nav entry`);
	}
});

test("hasRenderer rejects ids that are not registered", () => {
	assert.equal(hasRenderer("nope"), false);
	assert.equal(hasRenderer(""), false);
});

test("hasRenderer does not mistake an inherited property for a renderer", () => {
	assert.equal(hasRenderer("toString"), false);
	assert.equal(hasRenderer("constructor"), false);
});
