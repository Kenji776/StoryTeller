import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DURABLE,
	EPHEMERAL,
	SNAPSHOT,
	classifyEvent,
	isSequenced,
	isReplayable,
	EVENT_CLASSES,
} from "./eventTaxonomy.js";

// ── Snapshot ─────────────────────────────────────────────────────────────────

test("state:update is classified as a snapshot", () => {
	assert.equal(classifyEvent("state:update"), SNAPSHOT);
});

// ── Durable: events carrying game state a player cannot afford to miss ───────

test("narration is durable because it is the story itself", () => {
	assert.equal(classifyEvent("narration"), DURABLE);
});

test("music:change is ephemeral because currentMusic is recoverable from a snapshot", () => {
	assert.equal(classifyEvent("music:change"), EPHEMERAL);
});

test("dice:result is ephemeral because its only effect is a transient roll feed entry", () => {
	assert.equal(classifyEvent("dice:result"), EPHEMERAL);
});

test("stat deltas are durable", () => {
	for (const e of ["hp:update", "xp:update", "gold:update", "conditions:update", "spellslots:update", "inventory:update"]) {
		assert.equal(classifyEvent(e), DURABLE, `${e} should be durable`);
	}
});

test("turn and party updates are durable", () => {
	assert.equal(classifyEvent("turn:update"), DURABLE);
	assert.equal(classifyEvent("party:update"), DURABLE);
});

test("map:update is durable because publicState does not carry the map", () => {
	assert.equal(classifyEvent("map:update"), DURABLE);
});

test("suggestions:update is durable because publicState does not carry suggestions", () => {
	assert.equal(classifyEvent("suggestions:update"), DURABLE);
});

test("roll:required is durable because missing it strands the player", () => {
	assert.equal(classifyEvent("roll:required"), DURABLE);
});

test("terminal game events are durable", () => {
	assert.equal(classifyEvent("player:death"), DURABLE);
	assert.equal(classifyEvent("game:over"), DURABLE);
});

// ── Ephemeral: replaying these would be wrong, not merely redundant ──────────

test("streamed narration audio is ephemeral", () => {
	for (const e of ["narration:start", "narration:audio", "narration:audio:end", "narration:alignment"]) {
		assert.equal(classifyEvent(e), EPHEMERAL, `${e} should be ephemeral`);
	}
});

test("timer events are ephemeral because a replayed countdown would be wrong", () => {
	for (const e of ["timer:start", "timer:pending", "timer:cancel"]) {
		assert.equal(classifyEvent(e), EPHEMERAL, `${e} should be ephemeral`);
	}
});

test("ui lock and unlock are ephemeral because a stale lock would freeze the client", () => {
	assert.equal(classifyEvent("ui:lock"), EPHEMERAL);
	assert.equal(classifyEvent("ui:unlock"), EPHEMERAL);
});

test("sound effects are ephemeral", () => {
	assert.equal(classifyEvent("sfx:play"), EPHEMERAL);
});

test("toasts are ephemeral", () => {
	assert.equal(classifyEvent("toast"), EPHEMERAL);
});

test("debug channels are ephemeral", () => {
	assert.equal(classifyEvent("debug:llm"), EPHEMERAL);
	assert.equal(classifyEvent("debug:setup"), EPHEMERAL);
});

test("the cross-lobby lobby list is ephemeral", () => {
	assert.equal(classifyEvent("lobbies:update"), EPHEMERAL);
});

// ── Default for unrecognised events ─────────────────────────────────────────

test("an unrecognised event defaults to durable so new state events are not silently dropped", () => {
	assert.equal(classifyEvent("something:invented:later"), DURABLE);
});

// ── Sequencing and replay predicates ────────────────────────────────────────

test("durable events are sequenced", () => {
	assert.equal(isSequenced("hp:update"), true);
});

test("snapshots are sequenced so a client learns where to resume", () => {
	assert.equal(isSequenced("state:update"), true);
});

test("ephemeral events are not sequenced, so missing one never looks like a gap", () => {
	assert.equal(isSequenced("sfx:play"), false);
});

test("durable events are replayable", () => {
	assert.equal(isReplayable("hp:update"), true);
});

test("snapshots are not replayed, because only the newest state is meaningful", () => {
	assert.equal(isReplayable("state:update"), false);
});

test("ephemeral events are not replayable", () => {
	assert.equal(isReplayable("timer:start"), false);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("classifyEvent rejects a non-string event name", () => {
	assert.throws(() => classifyEvent(42), /event/);
});

test("classifyEvent rejects an empty event name", () => {
	assert.throws(() => classifyEvent(""), /event/);
});

test("classifyEvent rejects null", () => {
	assert.throws(() => classifyEvent(null), /event/);
});

test("isSequenced rejects a non-string event name", () => {
	assert.throws(() => isSequenced(undefined), /event/);
});

test("isReplayable rejects a non-string event name", () => {
	assert.throws(() => isReplayable({}), /event/);
});

// ── The table itself ─────────────────────────────────────────────────────────

test("every entry in the class table maps to a known class", () => {
	const known = new Set([DURABLE, EPHEMERAL, SNAPSHOT]);
	for (const [event, cls] of Object.entries(EVENT_CLASSES)) {
		assert.ok(known.has(cls), `${event} has unknown class ${cls}`);
	}
});

test("the three classes are distinct values", () => {
	assert.equal(new Set([DURABLE, EPHEMERAL, SNAPSHOT]).size, 3);
});

test("classification is a pure function of the name", () => {
	assert.equal(classifyEvent("hp:update"), classifyEvent("hp:update"));
});
