import { test } from "node:test";
import assert from "node:assert/strict";

import { createIllustrationRunner } from "./illustrationRunner.js";

const LOBBY = "lobby-1";
const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);
const MINUTE = 60_000;
const PNG = "iVBORw0KGgo=";

const PARTY = [
	{ name: "Brannor Ironfoot", imageCharacterId: "chr_1" },
	{ name: "Kaeda Ashfall", imageCharacterId: "chr_2" },
];

/**
 * Assembles a runner over fakes.
 *
 * @param {object} [options] - Overrides.
 * @returns {object} The runner and everything it touched.
 */
function makeRunner({ mode = "key-moments", lastAt = null, scene, image, ensure, party = PARTY, now = () => T0 } = {}) {
	const emitted = [];
	const saved = [];
	const lobby = { illustrationMode: mode, lastIllustrationAt: lastAt };

	const runner = createIllustrationRunner({
		gateway: {
			generateCharacterScene: scene ?? (async () => ({ b64: PNG, model: "krea2" })),
			generateImage: image ?? (async () => ({ b64: PNG, model: "krea2" })),
			ensureCharacterImage: ensure ?? (async () => ({ characterId: "chr_new", b64: PNG })),
		},
		partyOf: () => party,
		settingsOf: () => lobby,
		markIllustrated: (id, at) => { lobby.lastIllustrationAt = at; },
		saveImage: async (name, b64) => { saved.push({ name, b64 }); return `/character-images/${name}.png`; },
		emit: (lobbyId, event, payload) => emitted.push({ lobbyId, event, payload }),
		now,
		log: () => {},
	});

	return { runner, emitted, saved, lobby };
}

/** A DM reply asking for the party to be drawn. */
const REPLY = { illustrate: { moment: "raising the warhammer over the slain troll", characters: ["Brannor Ironfoot"], mood: "triumphant" } };

// ── Deciding not to draw ─────────────────────────────────────────────────────

test("a reply with no directive draws nothing and emits nothing", async () => {
	const { runner, emitted } = makeRunner();
	assert.equal(await runner.consider(LOBBY, { text: "You open the door." }), null);
	assert.deepEqual(emitted, []);
});

test("illustrations switched off draw nothing", async () => {
	const { runner, emitted } = makeRunner({ mode: "off" });
	assert.equal(await runner.consider(LOBBY, REPLY), null);
	assert.deepEqual(emitted, []);
});

test("a directive too soon after the last one draws nothing", async () => {
	const { runner, emitted } = makeRunner({ lastAt: T0 - MINUTE });
	assert.equal(await runner.consider(LOBBY, REPLY), null);
	assert.deepEqual(emitted, [], "a refused illustration should be silent, not a visible failure");
});

// ── The placeholder comes first ──────────────────────────────────────────────

test("a placeholder is announced before anything is generated", async () => {
	let generatedAt = -1;
	let order = 0;
	const { runner, emitted } = makeRunner({
		scene: async () => { generatedAt = order++; return { b64: PNG }; },
	});

	await runner.consider(LOBBY, REPLY);

	const pendingAt = emitted.findIndex((e) => e.event === "illustration:pending");
	assert.notEqual(pendingAt, -1, "no placeholder was announced");
	assert.equal(pendingAt, 0, "the placeholder must arrive before the wait, not after it");
	assert.ok(generatedAt >= 0);
});

test("the placeholder carries an id the finished image is matched on", async () => {
	const { runner, emitted } = makeRunner();
	await runner.consider(LOBBY, REPLY);

	const pending = emitted.find((e) => e.event === "illustration:pending");
	const ready = emitted.find((e) => e.event === "illustration:ready");

	assert.ok(pending.payload.id);
	assert.equal(ready.payload.id, pending.payload.id);
});

test("the placeholder says how many images are coming, so the space can be reserved", async () => {
	const { runner, emitted } = makeRunner();
	await runner.consider(LOBBY, { illustrate: { moment: "back to back", characters: ["Brannor Ironfoot", "Kaeda Ashfall"] } });

	assert.equal(emitted.find((e) => e.event === "illustration:pending").payload.expected, 2);
});

test("the placeholder carries a caption, so it is not a blank grey box", async () => {
	const { runner, emitted } = makeRunner();
	await runner.consider(LOBBY, REPLY);

	assert.match(emitted.find((e) => e.event === "illustration:pending").payload.caption, /warhammer|troll/i);
});

// ── Drawing ──────────────────────────────────────────────────────────────────

test("a character directive poses each named character from their likeness", async () => {
	const posed = [];
	const { runner } = makeRunner({
		scene: async ({ characterId }) => { posed.push(characterId); return { b64: PNG }; },
	});

	await runner.consider(LOBBY, { illustrate: { moment: "back to back", characters: ["Brannor Ironfoot", "Kaeda Ashfall"] } });
	assert.deepEqual(posed, ["chr_1", "chr_2"]);
});

test("a scene directive uses plain generation", async () => {
	let prompt = null;
	const { runner } = makeRunner({ image: async (req) => { prompt = req.prompt; return { b64: PNG }; } });

	await runner.consider(LOBBY, { illustrate: { subject: "a ruined watchtower at dusk" } });
	assert.match(prompt, /ruined watchtower/);
});

test("finished images are saved and announced with their urls", async () => {
	const { runner, emitted, saved } = makeRunner();
	await runner.consider(LOBBY, REPLY);

	assert.equal(saved.length, 1);
	const ready = emitted.find((e) => e.event === "illustration:ready");
	assert.equal(ready.payload.images.length, 1);
	assert.match(ready.payload.images[0].url, /^\/character-images\//);
});

test("drawing marks the lobby, so the cooldown starts from now", async () => {
	const { runner, lobby } = makeRunner();
	await runner.consider(LOBBY, REPLY);
	assert.equal(lobby.lastIllustrationAt, T0);
});

test("the cooldown is marked before the wait, so two turns cannot both slip through", async () => {
	// The generation takes seconds. If the mark happened afterwards, a second turn
	// arriving in the meantime would pass the gate and draw again.
	let markedDuringGeneration = null;
	const { runner, lobby } = makeRunner({
		scene: async () => { markedDuringGeneration = lobby.lastIllustrationAt; return { b64: PNG }; },
	});

	await runner.consider(LOBBY, REPLY);
	assert.equal(markedDuringGeneration, T0);
});

// ── When it goes wrong ───────────────────────────────────────────────────────

test("a failure is announced, so the placeholder never spins forever", async () => {
	const { runner, emitted } = makeRunner({ scene: async () => { throw new Error("backend down"); } });

	await runner.consider(LOBBY, REPLY);

	const failed = emitted.find((e) => e.event === "illustration:failed");
	assert.ok(failed, "a failed illustration left its placeholder with nothing to resolve it");
	assert.equal(failed.payload.id, emitted[0].payload.id);
});

test("one character failing still delivers the others", async () => {
	const { runner, emitted } = makeRunner({
		scene: async ({ characterId }) => {
			if (characterId === "chr_1") throw new Error("nope");
			return { b64: PNG };
		},
	});

	await runner.consider(LOBBY, { illustrate: { moment: "back to back", characters: ["Brannor Ironfoot", "Kaeda Ashfall"] } });

	const ready = emitted.find((e) => e.event === "illustration:ready");
	assert.equal(ready.payload.images.length, 1);
	assert.equal(ready.payload.images[0].name, "Kaeda Ashfall");
});

test("a failure message never carries key material", async () => {
	const { runner, emitted } = makeRunner({
		scene: async () => { throw new Error("bad key sk-abc123def456ghi"); },
	});

	await runner.consider(LOBBY, REPLY);
	assert.ok(!JSON.stringify(emitted).includes("sk-abc123def456ghi"));
});

test("a failure does not block the next illustration once the cooldown passes", async () => {
	let clock = T0;
	const { runner, emitted } = makeRunner({
		scene: async () => { throw new Error("down"); },
		now: () => clock,
	});

	await runner.consider(LOBBY, REPLY);
	clock = T0 + 30 * MINUTE;
	await runner.consider(LOBBY, REPLY);

	assert.equal(emitted.filter((e) => e.event === "illustration:pending").length, 2);
});

// ── It must never break the turn ─────────────────────────────────────────────

test("a runner whose gateway is missing entirely does not throw", async () => {
	const runner = createIllustrationRunner({
		gateway: {},
		partyOf: () => PARTY,
		settingsOf: () => ({ illustrationMode: "key-moments" }),
		markIllustrated: () => {},
		saveImage: async () => "/x.png",
		emit: () => {},
		now: () => T0,
		log: () => {},
	});

	await assert.doesNotReject(() => runner.consider(LOBBY, REPLY));
});

test("a save that fails does not throw into the turn", async () => {
	const runner = createIllustrationRunner({
		gateway: { generateCharacterScene: async () => ({ b64: PNG }) },
		partyOf: () => PARTY,
		settingsOf: () => ({ illustrationMode: "key-moments" }),
		markIllustrated: () => {},
		saveImage: async () => { throw new Error("EACCES"); },
		emit: () => {},
		now: () => T0,
		log: () => {},
	});

	await assert.doesNotReject(() => runner.consider(LOBBY, REPLY));
});

// ── Not queueing up a backlog ────────────────────────────────────────────────

test("a lobby already drawing does not start a second illustration", async () => {
	// The image server works on one at a time. With no time cooldown, a fast
	// sequence of turns would otherwise queue images faster than they can be
	// drawn, and the last would arrive minutes after the moment it illustrates.
	let release;
	const held = new Promise((r) => { release = r; });
	const { runner, emitted } = makeRunner({
		mode: "every-scene",
		scene: async () => { await held; return { b64: PNG }; },
	});

	const first = runner.consider(LOBBY, REPLY);
	await runner.consider(LOBBY, REPLY);

	assert.equal(emitted.filter((e) => e.event === "illustration:pending").length, 1,
		"a second illustration started while the first was still drawing");

	release();
	await first;
});

test("a lobby is free to draw again once the previous one finishes", async () => {
	const { runner, emitted } = makeRunner({ mode: "every-scene" });

	await runner.consider(LOBBY, REPLY);
	await runner.consider(LOBBY, REPLY);

	assert.equal(emitted.filter((e) => e.event === "illustration:pending").length, 2);
});

test("a lobby is freed even when its illustration failed", async () => {
	const { runner, emitted } = makeRunner({
		mode: "every-scene",
		scene: async () => { throw new Error("down"); },
	});

	await runner.consider(LOBBY, REPLY);
	await runner.consider(LOBBY, REPLY);

	assert.equal(emitted.filter((e) => e.event === "illustration:pending").length, 2,
		"a failure left the lobby permanently blocked from illustrating");
});

test("one lobby drawing does not block another", async () => {
	let release;
	const held = new Promise((r) => { release = r; });
	let call = 0;
	const { runner, emitted } = makeRunner({
		mode: "every-scene",
		// Only the first lobby's draw is held open. Blocking both would deadlock the
		// test itself rather than testing anything about the lobbies.
		scene: async () => { if (call++ === 0) await held; return { b64: PNG }; },
	});

	const first = runner.consider(LOBBY, REPLY);
	await runner.consider("lobby-2", REPLY);

	assert.equal(emitted.filter((e) => e.event === "illustration:pending").length, 2,
		"a second lobby was blocked by the first lobby's illustration");
	release();
	await first;
});

// ── The opening scene, which is not the DM's to decline ──────────────────────

test("the adventure opens with every party member drawn", async () => {
	const { runner, emitted } = makeRunner();

	await runner.openingScene(LOBBY);

	const ready = emitted.find((e) => e.event === "illustration:ready");
	assert.deepEqual(ready.payload.images.map((i) => i.name), ["Brannor Ironfoot", "Kaeda Ashfall"]);
});

test("the opening ignores the cooldown, because it is not the DM asking", async () => {
	const { runner, emitted } = makeRunner({ lastAt: T0 });

	await runner.openingScene(LOBBY);
	assert.ok(emitted.some((e) => e.event === "illustration:pending"));
});

test("the opening still respects illustrations being switched off", async () => {
	// Off is the host's explicit choice, and overriding it would be the one
	// setting in the game that does not mean what it says.
	const { runner, emitted } = makeRunner({ mode: "off" });

	assert.equal(await runner.openingScene(LOBBY), null);
	assert.deepEqual(emitted, []);
});

test("a character with no likeness yet has one made for the opening", async () => {
	const created = [];
	const { runner, emitted } = makeRunner({
		party: [{ name: "Brannor Ironfoot", imageCharacterId: "chr_1" }, { name: "Nim", imageCharacterId: null, sheet: { race: "Halfling" } }],
		ensure: async ({ name }) => { created.push(name); return { characterId: "chr_new", b64: PNG }; },
	});

	await runner.openingScene(LOBBY);

	assert.deepEqual(created, ["Nim"], "a party member without a likeness was left out of the opening");
	assert.equal(emitted.find((e) => e.event === "illustration:ready").payload.images.length, 2);
});

test("the opening caption says what it is", async () => {
	const { runner, emitted } = makeRunner();
	await runner.openingScene(LOBBY);

	assert.match(emitted.find((e) => e.event === "illustration:pending").payload.caption, /adventure begins|the party/i);
});

test("an opening for a lobby with nobody in it draws nothing", async () => {
	const { runner, emitted } = makeRunner({ party: [] });

	assert.equal(await runner.openingScene(LOBBY), null);
	assert.deepEqual(emitted, []);
});

test("the opening marks the cooldown, so the first turn does not immediately draw again", async () => {
	const { runner, lobby } = makeRunner();
	await runner.openingScene(LOBBY);
	assert.equal(lobby.lastIllustrationAt, T0);
});

test("a failure to make one likeness does not lose the rest of the party", async () => {
	const { runner, emitted } = makeRunner({
		party: [{ name: "Brannor Ironfoot", imageCharacterId: "chr_1" }, { name: "Nim", imageCharacterId: null }],
		ensure: async () => { throw new Error("image server busy"); },
	});

	await runner.openingScene(LOBBY);
	assert.equal(emitted.find((e) => e.event === "illustration:ready").payload.images.length, 1);
});
