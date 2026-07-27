import { test } from "node:test";
import assert from "node:assert/strict";

import { PlayerSessions } from "./playerSessions.js";

/**
 * Builds a session registry with a fake clock and predictable tokens.
 *
 * @description Both the clock and the token generator are injected so the suite is
 *   deterministic (`TDD-8`): grace-period expiry is driven by advancing the fake
 *   clock rather than by sleeping, and tokens are sequential so assertions can name
 *   them directly instead of capturing random values.
 * @param {object} [opts] - Overrides forwarded to the `PlayerSessions` constructor.
 * @param {number} [opts.graceMs] - Disconnect grace window in milliseconds.
 * @returns {{sessions: PlayerSessions, advance: function(number): void, at: function(): number}}
 *   The registry plus controls for its fake clock.
 */
function makeSessions(opts = {}) {
	let clock = 10_000;
	let counter = 0;
	const sessions = new PlayerSessions({
		now: () => clock,
		newToken: () => `tok-${++counter}`,
		...opts,
	});
	return {
		sessions,
		advance: (ms) => { clock += ms; },
		at: () => clock,
	};
}

// ── Opening a session ────────────────────────────────────────────────────────

test("open issues a token for a newly identified player", () => {
	const { sessions } = makeSessions();
	const result = sessions.open("lob1", "Ayla", "sock-a");
	assert.equal(result.ok, true);
	assert.equal(result.token, "tok-1");
});

test("open records the lobby, player and socket on the session", () => {
	const { sessions, at } = makeSessions();
	const { session } = sessions.open("lob1", "Ayla", "sock-a");
	assert.equal(session.lobbyId, "lob1");
	assert.equal(session.playerName, "Ayla");
	assert.equal(session.socketId, "sock-a");
	assert.equal(session.state, "active");
	assert.equal(session.connectedAt, at());
});

test("open issues a distinct token per player", () => {
	const { sessions } = makeSessions();
	const a = sessions.open("lob1", "Ayla", "sock-a");
	const b = sessions.open("lob1", "Brom", "sock-b");
	assert.notEqual(a.token, b.token);
});

// ── Lookups ──────────────────────────────────────────────────────────────────

test("bySocket finds the session currently bound to a socket", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	assert.equal(sessions.bySocket("sock-a").playerName, "Ayla");
});

test("byToken finds the session regardless of which socket holds it", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	assert.equal(sessions.byToken(token).playerName, "Ayla");
});

test("byPlayer finds the session for a named character in a lobby", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	assert.equal(sessions.byPlayer("lob1", "Ayla").socketId, "sock-a");
});

test("byPlayer does not confuse identically named players in different lobbies", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.open("lob2", "Ayla", "sock-b");
	assert.equal(sessions.byPlayer("lob2", "Ayla").socketId, "sock-b");
});

test("byPlayer does not confuse a lobby+player pair with a differently split one_regression", () => {
	const { sessions } = makeSessions();
	// A space is legal in a character name, so a space-joined index key would make
	// these two distinct claims collide.
	sessions.open("lob1 X", "Ayla", "sock-a");
	const result = sessions.open("lob1", "X Ayla", "sock-b");
	assert.equal(result.ok, true, "the second claim is a different lobby and character");
	assert.equal(sessions.byPlayer("lob1 X", "Ayla").socketId, "sock-a");
	assert.equal(sessions.byPlayer("lob1", "X Ayla").socketId, "sock-b");
});

test("lookups return null rather than throwing when nothing matches", () => {
	const { sessions } = makeSessions();
	assert.equal(sessions.bySocket("nope"), null);
	assert.equal(sessions.byToken("nope"), null);
	assert.equal(sessions.byPlayer("nope", "Nobody"), null);
});

// ── Rebinding across a new socket id — the reconnect path ────────────────────

test("rebind moves an existing session onto the new socket", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	const result = sessions.rebind(token, "sock-b");
	assert.equal(result.ok, true);
	assert.equal(result.session.socketId, "sock-b");
});

test("rebind makes the session reachable by its new socket", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.rebind(token, "sock-b");
	assert.equal(sessions.bySocket("sock-b").playerName, "Ayla");
});

test("rebind releases the old socket id so it resolves to nothing", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.rebind(token, "sock-b");
	assert.equal(sessions.bySocket("sock-a"), null);
});

test("rebind restores an active state after a disconnect", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	const { session } = sessions.rebind(token, "sock-b");
	assert.equal(session.state, "active");
	assert.equal(session.disconnectedAt, null);
});

test("rebind preserves the player identity rather than creating a new one", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.rebind(token, "sock-b");
	assert.equal(sessions.byPlayer("lob1", "Ayla").token, token);
});

test("rebind reports an unknown token instead of silently creating a session", () => {
	const { sessions } = makeSessions();
	const result = sessions.rebind("tok-never-issued", "sock-b");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "unknown_session");
});

test("rebind onto the same socket is a harmless no-op", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	const result = sessions.rebind(token, "sock-a");
	assert.equal(result.ok, true);
	assert.equal(sessions.bySocket("sock-a").token, token);
});

// ── Disconnect grace ─────────────────────────────────────────────────────────

test("markDisconnected puts the session into grace and stamps the time", () => {
	const { sessions, at } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	const session = sessions.markDisconnected("sock-a");
	assert.equal(session.state, "grace");
	assert.equal(session.disconnectedAt, at());
});

test("a session in grace is still reachable by token so the player can return", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	assert.equal(sessions.byToken(token).state, "grace");
});

test("a session in grace still claims its character, so the seat is held", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	assert.equal(sessions.byPlayer("lob1", "Ayla").state, "grace");
});

test("markDisconnected returns null for a socket that owns no session", () => {
	const { sessions } = makeSessions();
	assert.equal(sessions.markDisconnected("ghost"), null);
});

test("markDisconnected is idempotent and does not restart the grace clock", () => {
	const { sessions, advance } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	const first = sessions.markDisconnected("sock-a");
	const stampedAt = first.disconnectedAt;
	advance(5_000);
	sessions.markDisconnected("sock-a");
	assert.equal(sessions.byPlayer("lob1", "Ayla").disconnectedAt, stampedAt);
});

// ── The reconnect/disconnect race ────────────────────────────────────────────

test("a late disconnect for a replaced socket does not disturb the reconnected session", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	// The client reconnects on sock-b before the server processes sock-a's teardown.
	sessions.rebind(token, "sock-b");
	const result = sessions.markDisconnected("sock-a");
	assert.equal(result, null);
	assert.equal(sessions.byToken(token).state, "active");
});

test("a late disconnect for a replaced socket leaves the new socket bound", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.rebind(token, "sock-b");
	sessions.markDisconnected("sock-a");
	assert.equal(sessions.bySocket("sock-b").token, token);
});

// ── Grace expiry ─────────────────────────────────────────────────────────────

test("sweepExpired returns nothing while a session is still inside its grace window", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	advance(999);
	assert.deepEqual(sessions.sweepExpired(), []);
});

test("sweepExpired reclaims a session once the grace window has fully elapsed", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	advance(1_000);
	const expired = sessions.sweepExpired();
	assert.equal(expired.length, 1);
	assert.equal(expired[0].playerName, "Ayla");
});

test("an expired session is removed from every index", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	advance(1_000);
	sessions.sweepExpired();
	assert.equal(sessions.byToken(token), null);
	assert.equal(sessions.byPlayer("lob1", "Ayla"), null);
	assert.equal(sessions.bySocket("sock-a"), null);
});

test("sweepExpired never reclaims an active session however long it has been connected", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	sessions.open("lob1", "Ayla", "sock-a");
	advance(60_000);
	assert.deepEqual(sessions.sweepExpired(), []);
});

test("a player who returns before expiry keeps their original session", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	advance(999);
	sessions.rebind(token, "sock-b");
	advance(10_000);
	assert.deepEqual(sessions.sweepExpired(), []);
	assert.equal(sessions.byToken(token).state, "active");
});

test("rebind after expiry is refused so the caller falls back to a verified rejoin", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	advance(1_000);
	sessions.sweepExpired();
	assert.equal(sessions.rebind(token, "sock-b").reason, "unknown_session");
});

test("sweepExpired reclaims several lapsed sessions in one pass", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.open("lob1", "Brom", "sock-b");
	sessions.markDisconnected("sock-a");
	sessions.markDisconnected("sock-b");
	advance(1_000);
	assert.equal(sessions.sweepExpired().length, 2);
});

// ── Seat conflicts: the two-tab and name-collision cases ─────────────────────

test("open refuses a character that another live socket already holds", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	const result = sessions.open("lob1", "Ayla", "sock-b");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "name_active");
});

test("a refused open reports the holding session so the caller can explain the clash", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	const result = sessions.open("lob1", "Ayla", "sock-b");
	assert.equal(result.session.socketId, "sock-a");
});

test("a refused open leaves the original session untouched", () => {
	const { sessions } = makeSessions();
	const first = sessions.open("lob1", "Ayla", "sock-a");
	sessions.open("lob1", "Ayla", "sock-b");
	assert.equal(sessions.byPlayer("lob1", "Ayla").token, first.token);
	assert.equal(sessions.bySocket("sock-b"), null);
});

test("open distinguishes a character being held in grace from one actively in use", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	const result = sessions.open("lob1", "Ayla", "sock-b");
	assert.equal(result.ok, false);
	assert.equal(result.reason, "name_in_grace");
});

test("a character is claimable again once its grace has lapsed", () => {
	const { sessions, advance } = makeSessions({ graceMs: 1_000 });
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.markDisconnected("sock-a");
	advance(1_000);
	sessions.sweepExpired();
	assert.equal(sessions.open("lob1", "Ayla", "sock-b").ok, true);
});

// ── Explicit close and lobby teardown ────────────────────────────────────────

test("close removes a session immediately without waiting for grace", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-a");
	assert.equal(sessions.close(token), true);
	assert.equal(sessions.byToken(token), null);
	assert.equal(sessions.bySocket("sock-a"), null);
});

test("close reports false for a token it does not know", () => {
	const { sessions } = makeSessions();
	assert.equal(sessions.close("tok-never-issued"), false);
});

test("dropLobby removes every session for that lobby and reports the count", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.open("lob1", "Brom", "sock-b");
	assert.equal(sessions.dropLobby("lob1"), 2);
	assert.equal(sessions.byPlayer("lob1", "Ayla"), null);
});

test("dropLobby leaves other lobbies intact", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.open("lob2", "Brom", "sock-b");
	sessions.dropLobby("lob1");
	assert.equal(sessions.byPlayer("lob2", "Brom").socketId, "sock-b");
});

test("dropLobby releases the socket index too", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.dropLobby("lob1");
	assert.equal(sessions.bySocket("sock-a"), null);
});

// ── Reporting, for the admin surface ─────────────────────────────────────────

test("listLobby reports every session in a lobby with its state", () => {
	const { sessions } = makeSessions();
	sessions.open("lob1", "Ayla", "sock-a");
	sessions.open("lob1", "Brom", "sock-b");
	sessions.markDisconnected("sock-b");
	const listed = sessions.listLobby("lob1");
	assert.deepEqual(
		listed.map((s) => [s.playerName, s.state]).sort(),
		[["Ayla", "active"], ["Brom", "grace"]],
	);
});

test("listLobby returns an empty array for an unknown lobby", () => {
	const { sessions } = makeSessions();
	assert.deepEqual(sessions.listLobby("nope"), []);
});

// ── Invalid input ────────────────────────────────────────────────────────────

test("open rejects a missing lobby id", () => {
	const { sessions } = makeSessions();
	assert.throws(() => sessions.open("", "Ayla", "sock-a"), /lobbyId/);
});

test("open rejects a missing player name", () => {
	const { sessions } = makeSessions();
	assert.throws(() => sessions.open("lob1", "", "sock-a"), /playerName/);
});

test("open rejects a missing socket id", () => {
	const { sessions } = makeSessions();
	assert.throws(() => sessions.open("lob1", "Ayla", ""), /socketId/);
});

test("rebind rejects a non-string token", () => {
	const { sessions } = makeSessions();
	assert.throws(() => sessions.rebind(42, "sock-b"), /token/);
});

test("rebind rejects a missing socket id", () => {
	const { sessions } = makeSessions();
	assert.throws(() => sessions.rebind("tok-1", ""), /socketId/);
});

test("the constructor rejects a non-positive grace window", () => {
	assert.throws(() => new PlayerSessions({ graceMs: 0 }), /graceMs/);
});

test("the constructor rejects a non-integer grace window", () => {
	assert.throws(() => new PlayerSessions({ graceMs: 1.5 }), /graceMs/);
});

// ── Properties ───────────────────────────────────────────────────────────────

test("issued tokens are unique across many sessions", () => {
	const sessions = new PlayerSessions();
	const tokens = new Set();
	for (let i = 0; i < 200; i++) {
		tokens.add(sessions.open("lob1", `Player${i}`, `sock-${i}`).token);
	}
	assert.equal(tokens.size, 200);
});

test("a session survives an arbitrary number of reconnects", () => {
	const { sessions } = makeSessions();
	const { token } = sessions.open("lob1", "Ayla", "sock-0");
	for (let i = 1; i <= 25; i++) {
		sessions.markDisconnected(`sock-${i - 1}`);
		assert.equal(sessions.rebind(token, `sock-${i}`).ok, true);
	}
	assert.equal(sessions.byPlayer("lob1", "Ayla").token, token);
	assert.equal(sessions.bySocket("sock-25").playerName, "Ayla");
});
