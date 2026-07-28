import { test } from "node:test";
import assert from "node:assert/strict";

import { characterPlan, sceneFor } from "./characterRecords.js";

const APPEARANCE = "A Dwarf Paladin. Braided copper beard, a scarred cheek.";
const OTHER_APPEARANCE = "A Dwarf Paladin. Braided copper beard, a scarred cheek, and a missing eye.";

// ── Deciding what to do about a player's stored identity ─────────────────────

test("a player with no stored character gets one created", () => {
	assert.deepEqual(characterPlan({ record: {}, appearance: APPEARANCE }), { action: "create", retire: null });
});

test("a player whose appearance is unchanged reuses the character they have", () => {
	const record = { imageCharacterId: "chr_1", imageAppearance: APPEARANCE };
	assert.deepEqual(characterPlan({ record, appearance: APPEARANCE }), { action: "reuse", characterId: "chr_1", retire: null });
});

test("whitespace and case differences do not count as a changed appearance", () => {
	const record = { imageCharacterId: "chr_1", imageAppearance: APPEARANCE };
	const plan = characterPlan({ record, appearance: `  ${APPEARANCE.toUpperCase()}  ` });

	assert.equal(plan.action, "reuse", "a cosmetic difference should not throw away a working likeness");
});

test("a genuinely changed appearance creates a new character and retires the old", () => {
	const record = { imageCharacterId: "chr_1", imageAppearance: APPEARANCE };
	const plan = characterPlan({ record, appearance: OTHER_APPEARANCE });

	// The API cannot edit a stored likeness, so a permanent change means a new
	// identity. The old one is named for retirement rather than silently orphaned.
	assert.equal(plan.action, "create");
	assert.equal(plan.retire, "chr_1");
});

test("a stored id with no remembered appearance is rebuilt rather than trusted", () => {
	// A record from before appearances were stored cannot be compared against, and
	// reusing it blindly would pin the character to a likeness nobody can inspect.
	const plan = characterPlan({ record: { imageCharacterId: "chr_1" }, appearance: APPEARANCE });

	assert.equal(plan.action, "create");
	assert.equal(plan.retire, "chr_1");
});

test("a forced rebuild ignores a matching appearance", () => {
	const record = { imageCharacterId: "chr_1", imageAppearance: APPEARANCE };
	const plan = characterPlan({ record, appearance: APPEARANCE, force: true });

	assert.equal(plan.action, "create");
	assert.equal(plan.retire, "chr_1");
});

test("a blank appearance cannot produce a plan, because continuity rests on it", () => {
	for (const value of ["", "   ", null, undefined]) {
		assert.throws(() => characterPlan({ record: {}, appearance: value }), /appearance/i);
	}
});

test("an absent record is treated as a player who has no character yet", () => {
	assert.equal(characterPlan({ appearance: APPEARANCE }).action, "create");
	assert.equal(characterPlan({ record: null, appearance: APPEARANCE }).action, "create");
});

// ── Turning a moment into a scene ────────────────────────────────────────────

test("a scene describes what is happening, never what the character looks like", () => {
	const scene = sceneFor({ moment: "victorious after slaying a troll" });

	assert.match(scene, /troll/);
	// Restating appearance in a scene is the documented cause of faces drifting.
	assert.doesNotMatch(scene, /dwarf|beard|half-elf|hair|eyes/i);
});

test("a scene is trimmed and its trailing punctuation normalised", () => {
	assert.equal(sceneFor({ moment: "  raising a banner on the wall  " }), "raising a banner on the wall");
});

test("a blank moment is refused rather than sent as an empty scene", () => {
	for (const value of ["", "   ", null, undefined]) {
		assert.throws(() => sceneFor({ moment: value }), /moment|scene/i);
	}
});

test("a mood is folded in when one is given", () => {
	const scene = sceneFor({ moment: "standing over a fallen troll", mood: "triumphant" });
	assert.match(scene, /triumphant/i);
	assert.match(scene, /fallen troll/);
});

test("a scene mentioning the character by name has the name removed", () => {
	// The server prepends the stored appearance; a name in the scene adds nothing
	// and reads as a second subject in the frame.
	const scene = sceneFor({ moment: "Brannor kicks down the door", name: "Brannor" });

	assert.doesNotMatch(scene, /Brannor/);
	assert.match(scene, /kicks down the door/);
});

test("a name that is also an ordinary word is not scrubbed out of the middle of one", () => {
	const scene = sceneFor({ moment: "wading through the shallows", name: "Shallow" });
	assert.match(scene, /shallows/);
});
