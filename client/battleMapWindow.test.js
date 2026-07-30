import { test } from "node:test";
import assert from "node:assert/strict";

import { mapWindowIntent, arenaSignature } from "./battleMapWindow.js";

/** An arena as the server sends it. Only the identifying fields matter here. */
const arena = (overrides = {}) => ({ seed: 1234, width: 12, height: 10, archetype: "crypt", tokens: {}, ...overrides });

// ── Identifying an arena ─────────────────────────────────────────────────────

test("the same arena has the same signature, a different one does not", () => {
	assert.equal(arenaSignature(arena()), arenaSignature(arena()));
	assert.notEqual(arenaSignature(arena()), arenaSignature(arena({ seed: 9999 })));
});

test("no arena has a signature too, so it can be compared without a null check", () => {
	assert.equal(arenaSignature(null), "none");
	assert.equal(arenaSignature(undefined), "none");
});

test("a redrawn arena is not mistaken for a new one just because a token moved", () => {
	// `state:update` carries the map several times a turn. If a moved token changed the signature the
	// window would be treated as showing the wrong fight on every single push.
	const before = arena({ tokens: { Kael: { at: [1, 1] } } });
	const after = arena({ tokens: { Kael: { at: [4, 7] } } });
	assert.equal(arenaSignature(before), arenaSignature(after));
});

// ── Opening and closing ──────────────────────────────────────────────────────

test("a fight starting opens the window", () => {
	const intent = mapWindowIntent({ map: arena(), isOpen: false, dismissedFor: null });
	assert.equal(intent.action, "open");
});

test("a fight already on screen is redrawn, not reopened", () => {
	// Reopening would steal focus from whatever the player is doing, several times a turn.
	const intent = mapWindowIntent({ map: arena(), isOpen: true, dismissedFor: null });
	assert.equal(intent.action, "redraw");
});

test("the fight ending closes the window", () => {
	const intent = mapWindowIntent({ map: null, isOpen: true, dismissedFor: null });
	assert.equal(intent.action, "close");
});

test("the fight ending with no window open does nothing", () => {
	assert.equal(mapWindowIntent({ map: null, isOpen: false }).action, "none");
});

test("a player who closes the window is left alone for the rest of that fight", () => {
	// The whole point. A map push arrives several times a turn, and reopening on each one would fight
	// the player for control of their own screen — which is how a feature gets switched off for good.
	const map = arena();
	const intent = mapWindowIntent({ map, isOpen: false, dismissedFor: arenaSignature(map) });

	assert.equal(intent.action, "none");
	assert.equal(intent.dismissedFor, arenaSignature(map), "and the dismissal is still remembered");
});

test("the next fight opens the window again", () => {
	// A choice about one encounter is not a standing preference — the options window is for that.
	const closed = arena({ seed: 1 });
	const next = arena({ seed: 2 });
	const intent = mapWindowIntent({ map: next, isOpen: false, dismissedFor: arenaSignature(closed) });

	assert.equal(intent.action, "open");
	assert.equal(intent.dismissedFor, null, "the old fight's dismissal is forgotten");
});

test("the end of a fight forgets the dismissal, so the next one is not suppressed", () => {
	// Held across the gap between fights, a dismissal would silently disable the window for a fight
	// the player never made a choice about.
	const map = arena();
	const intent = mapWindowIntent({ map: null, isOpen: false, dismissedFor: arenaSignature(map) });

	assert.equal(intent.dismissedFor, null);
});

test("an arena that is open and was dismissed keeps the dismissal, in case it is closed again", () => {
	// Reopened by hand after being dismissed: the record has to survive so closing it a second time
	// does not read as a fresh dismissal of a different fight.
	const map = arena();
	const intent = mapWindowIntent({ map, isOpen: true, dismissedFor: arenaSignature(map) });

	assert.equal(intent.action, "redraw");
	assert.equal(intent.dismissedFor, arenaSignature(map));
});

test("a call with nothing at all does not throw and asks for nothing", () => {
	for (const value of [undefined, {}, null]) {
		const intent = mapWindowIntent(value ?? undefined);
		assert.equal(intent.action, "none");
	}
});
