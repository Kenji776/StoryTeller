import { test } from "node:test";
import assert from "node:assert/strict";

import { createIncidentLog, SEVERITY } from "./incidents.js";

/**
 * Builds an incident log with a fake clock and a recorded notifier.
 *
 * @description The clock is injected so timestamps are assertable, and the notifier
 *   is recorded rather than performed so tests can prove an admin would have been
 *   told without needing a socket (`TDD-8`).
 * @param {object} [opts] - Overrides.
 * @returns {{log: object, notified: Array, advance: Function}}
 */
function makeLog(opts = {}) {
	let clock = 1_000;
	const notified = [];
	const log = createIncidentLog({
		now: () => clock,
		capacity: opts.capacity ?? 50,
		notify: (lobbyId, incident) => notified.push({ lobbyId, incident }),
	});
	return { log, notified, advance: (ms) => { clock += ms; } };
}

// ── Raising ──────────────────────────────────────────────────────────────────

test("raising an incident returns it with an id and a timestamp", () => {
	const { log } = makeLog();
	const inc = log.raise("lob1", { kind: "update_dropped", message: "Player not found" });
	assert.ok(inc.id);
	assert.equal(inc.at, 1_000);
});

test("a raised incident appears in the lobby's list", () => {
	const { log } = makeLog();
	log.raise("lob1", { kind: "update_dropped", message: "Player not found" });
	assert.equal(log.list("lob1").length, 1);
});

test("an incident defaults to warning severity when none is given", () => {
	const { log } = makeLog();
	assert.equal(log.raise("lob1", { kind: "x", message: "y" }).severity, SEVERITY.WARNING);
});

test("a stated severity is preserved", () => {
	const { log } = makeLog();
	assert.equal(log.raise("lob1", { kind: "x", message: "y", severity: SEVERITY.ERROR }).severity, SEVERITY.ERROR);
});

test("an incident carries structured detail for an admin to act on", () => {
	const { log } = makeLog();
	const inc = log.raise("lob1", { kind: "update_dropped", message: "dropped", detail: { player: "Ayla", field: "hp" } });
	assert.deepEqual(inc.detail, { player: "Ayla", field: "hp" });
});

test("raising notifies watching admins immediately", () => {
	const { log, notified } = makeLog();
	log.raise("lob1", { kind: "x", message: "y" });
	assert.equal(notified.length, 1);
	assert.equal(notified[0].lobbyId, "lob1");
});

test("incidents from different lobbies do not mix", () => {
	const { log } = makeLog();
	log.raise("lob1", { kind: "x", message: "y" });
	log.raise("lob2", { kind: "x", message: "y" });
	assert.equal(log.list("lob1").length, 1);
	assert.equal(log.list("lob2").length, 1);
});

test("an unknown lobby has no incidents rather than throwing", () => {
	const { log } = makeLog();
	assert.deepEqual(log.list("never-existed"), []);
});

// ── Repetition ───────────────────────────────────────────────────────────────

test("an identical incident raised again increments a count instead of flooding", () => {
	// A parse failure that repeats every turn should read as one recurring problem,
	// not fifty separate ones an admin has to scroll past.
	const { log } = makeLog();
	log.raise("lob1", { kind: "llm_parse", message: "DM reply was not JSON" });
	log.raise("lob1", { kind: "llm_parse", message: "DM reply was not JSON" });
	const list = log.list("lob1");
	assert.equal(list.length, 1);
	assert.equal(list[0].count, 2);
});

test("a repeated incident records when it last happened", () => {
	const { log, advance } = makeLog();
	log.raise("lob1", { kind: "llm_parse", message: "same" });
	advance(5_000);
	log.raise("lob1", { kind: "llm_parse", message: "same" });
	assert.equal(log.list("lob1")[0].lastAt, 6_000);
});

test("incidents differing in detail are kept apart", () => {
	const { log } = makeLog();
	log.raise("lob1", { kind: "update_dropped", message: "m", detail: { player: "Ayla" } });
	log.raise("lob1", { kind: "update_dropped", message: "m", detail: { player: "Brom" } });
	assert.equal(log.list("lob1").length, 2);
});

test("a repeat still notifies, so an admin sees it is ongoing", () => {
	const { log, notified } = makeLog();
	log.raise("lob1", { kind: "x", message: "y" });
	log.raise("lob1", { kind: "x", message: "y" });
	assert.equal(notified.length, 2);
});

// ── Retention ────────────────────────────────────────────────────────────────

test("the log keeps only its most recent incidents", () => {
	const { log } = makeLog({ capacity: 3 });
	for (let i = 0; i < 6; i++) log.raise("lob1", { kind: "k", message: `m${i}` });
	assert.equal(log.list("lob1").length, 3);
});

test("eviction drops the oldest first", () => {
	const { log } = makeLog({ capacity: 2 });
	for (let i = 0; i < 4; i++) log.raise("lob1", { kind: "k", message: `m${i}` });
	assert.deepEqual(log.list("lob1").map((i) => i.message), ["m2", "m3"]);
});

test("the newest incident is listed last", () => {
	const { log } = makeLog();
	log.raise("lob1", { kind: "k", message: "first" });
	log.raise("lob1", { kind: "k", message: "second" });
	assert.equal(log.list("lob1").at(-1).message, "second");
});

// ── Resolving ────────────────────────────────────────────────────────────────

test("resolving marks an incident handled without deleting the record", () => {
	const { log } = makeLog();
	const inc = log.raise("lob1", { kind: "k", message: "m" });
	assert.equal(log.resolve("lob1", inc.id, "admin healed the player"), true);
	const stored = log.list("lob1")[0];
	assert.equal(stored.resolved, true);
	assert.equal(stored.resolution, "admin healed the player");
});

test("resolving an unknown incident reports false", () => {
	const { log } = makeLog();
	assert.equal(log.resolve("lob1", "no-such-id", "x"), false);
});

test("unresolved lists only what still needs attention", () => {
	const { log } = makeLog();
	const a = log.raise("lob1", { kind: "k", message: "a" });
	log.raise("lob1", { kind: "k", message: "b" });
	log.resolve("lob1", a.id, "done");
	assert.deepEqual(log.unresolved("lob1").map((i) => i.message), ["b"]);
});

test("clearing removes a lobby's incidents entirely", () => {
	const { log } = makeLog();
	log.raise("lob1", { kind: "k", message: "m" });
	log.clear("lob1");
	assert.deepEqual(log.list("lob1"), []);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("raising without a lobby id is refused", () => {
	const { log } = makeLog();
	assert.throws(() => log.raise("", { kind: "k", message: "m" }), /lobbyId/);
});

test("raising without a kind is refused", () => {
	const { log } = makeLog();
	assert.throws(() => log.raise("lob1", { message: "m" }), /kind/);
});

test("a notifier that throws does not break the caller that raised", () => {
	// An incident is raised from inside failure handling; if telling an admin can
	// throw, one broken admin socket takes down the game loop that reported it.
	const log = createIncidentLog({ notify: () => { throw new Error("socket gone"); } });
	assert.doesNotThrow(() => log.raise("lob1", { kind: "k", message: "m" }));
	assert.equal(log.list("lob1").length, 1);
});

test("a message longer than the cap is truncated before it is stored", () => {
	const { log } = makeLog();
	const inc = log.raise("lob1", { kind: "k", message: "x".repeat(5000) });
	assert.ok(inc.message.length <= 500);
});
