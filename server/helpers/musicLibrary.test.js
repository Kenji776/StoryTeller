import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { listMoodTracks } from "./musicLibrary.js";

/** The real mood keys, read from the file the client and the prompt both use. */
const MOODS = JSON.parse(
	fs.readFileSync(new URL("../../client/config/music_moods.json", import.meta.url), "utf8"),
).moods.map((mood) => mood.id);

const ROOT = "/app/client/music/game";

/**
 * @description Builds a filesystem double over a map of directory → file names, so these tests
 *   describe layouts rather than touching a disk (`TDD-8`).
 * @param {object} tree - Directory path (posix, under ROOT) mapped to an array of file names.
 * @returns {object} An fs-shaped double.
 */
function makeFs(tree) {
	const normalise = (p) => String(p).split("\\").join("/");
	return {
		existsSync: (p) => Object.hasOwn(tree, normalise(p)),
		readdirSync: (p) => {
			const key = normalise(p);
			if (!Object.hasOwn(tree, key)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return tree[key];
		},
	};
}

// ── The layout somebody organised by hand ────────────────────────────────────

test("tracks in a mood folder are listed", () => {
	const fsImpl = makeFs({ [`${ROOT}/default/tavern`]: ["one.mp3", "two.mp3"] });

	assert.deepEqual(
		listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "tavern" }),
		["one.mp3", "two.mp3"],
	);
});

test("anything that is not an mp3 is ignored", () => {
	const fsImpl = makeFs({ [`${ROOT}/default/tavern`]: ["a.mp3", "cover.jpg", "notes.txt", ".DS_Store"] });

	assert.deepEqual(listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "tavern" }), ["a.mp3"]);
});

// ── The layout the downloaded pack actually produces ─────────────────────────

test("a flat pack is read by the mood prefix in each filename", () => {
	// The bug this exists for. The release pack extracts every track flat into `game/default/` with
	// the mood as a filename prefix, while the route only looked for a `game/default/tavern/` folder.
	// Result: music downloaded successfully on every fresh install and then never played.
	const fsImpl = makeFs({
		[`${ROOT}/default`]: [
			"tavern_the_gilded_flagon_mn9abc123456.mp3",
			"tavern_hammerfist_hall_mn9def789012.mp3",
			"boss_fight_the_wyrm_mn9ghi345678.mp3",
			"lively_town_cobblestone_mn9jkl901234.mp3",
		],
	});

	assert.deepEqual(
		listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "tavern" }),
		["tavern_the_gilded_flagon_mn9abc123456.mp3", "tavern_hammerfist_hall_mn9def789012.mp3"],
	);
});

test("a mood takes only tracks whose name begins with it and an underscore", () => {
	const fsImpl = makeFs({
		[`${ROOT}/default`]: ["sad_moment_lament_mn9aaa111111.mp3", "victory_dawn_mn9bbb222222.mp3"],
	});

	assert.deepEqual(
		listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "sad_moment" }),
		["sad_moment_lament_mn9aaa111111.mp3"],
	);
});

test("no mood key is a prefix of another, which is what makes prefix matching unambiguous", () => {
	// The assumption prefix matching rests on, asserted against the real list rather than an invented
	// one. `sad_` *would* claim `sad_moment`'s tracks — the reason that is not a bug is that `sad` is
	// not a mood. If a future mood breaks this, the failure lands here rather than as music quietly
	// playing under the wrong scene.
	const moods = MOODS;
	assert.ok(moods.length > 5, `only found ${moods.length} moods — the fixture has drifted`);

	const overlapping = moods.filter((a) => moods.some((b) => b !== a && b.startsWith(`${a}_`)));
	assert.deepEqual(overlapping, [], `these moods prefix another: ${overlapping.join(", ")}`);
});

test("a mood folder wins over prefixed files in the world folder", () => {
	// Somebody who organised their library deliberately should not have loose files mixed in.
	const fsImpl = makeFs({
		[`${ROOT}/default`]: ["tavern_loose_mn9ccc333333.mp3"],
		[`${ROOT}/default/tavern`]: ["organised.mp3"],
	});

	assert.deepEqual(listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "tavern" }), ["organised.mp3"]);
});

// ── Nothing there, and nothing clever ────────────────────────────────────────

test("a world with nothing for that mood returns nothing", () => {
	const fsImpl = makeFs({ [`${ROOT}/default`]: ["horror_dread_mn9ddd444444.mp3"] });
	assert.deepEqual(listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "tavern" }), []);
});

test("an unknown world returns nothing rather than throwing", () => {
	const fsImpl = makeFs({ [`${ROOT}/default`]: ["tavern_a_mn9eee555555.mp3"] });
	assert.deepEqual(listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "atlantis", mood: "tavern" }), []);
});

test("a path segment trying to escape the music directory is refused", () => {
	// The route sanitised this before; the check moves here with the logic so it cannot be left behind.
	const fsImpl = makeFs({ [`${ROOT}/default`]: ["tavern_a_mn9fff666666.mp3"] });

	for (const [world, mood] of [["..", "tavern"], ["default", ".."], ["default", "../../etc"], ["./x", "tavern"]]) {
		assert.deepEqual(listMoodTracks({ fsImpl, gameMusicDir: ROOT, world, mood }), [],
			`"${world}/${mood}" must not resolve to anything`);
	}
});

test("a filesystem error is an empty list, not a broken page", () => {
	// Music failing is a missing soundtrack; it must never take a turn down with it.
	const fsImpl = {
		existsSync: () => true,
		readdirSync: () => { throw new Error("EIO"); },
	};

	assert.deepEqual(listMoodTracks({ fsImpl, gameMusicDir: ROOT, world: "default", mood: "tavern" }), []);
});

test("missing arguments produce an empty list rather than an exception", () => {
	for (const args of [{}, { fsImpl: makeFs({}) }, { world: "default", mood: "tavern" }]) {
		assert.deepEqual(listMoodTracks(args), []);
	}
});
