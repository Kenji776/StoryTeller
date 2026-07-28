import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute, buildRoute, DEFAULT_SECTION, GLOBAL_SECTION } from "./router.js";

test("parses a lobby route into its code and section", () => {
	assert.deepEqual(parseRoute("#/lobby/X4K2/party"), { lobby: "X4K2", section: "party" });
});

test("parses a global route", () => {
	assert.deepEqual(parseRoute("#/lobbies"), { lobby: null, section: "lobbies" });
	assert.deepEqual(parseRoute("#/toolbox"), { lobby: null, section: "toolbox" });
});

test("a lobby route with no section opens the default section", () => {
	assert.deepEqual(parseRoute("#/lobby/X4K2"), { lobby: "X4K2", section: DEFAULT_SECTION });
	assert.deepEqual(parseRoute("#/lobby/X4K2/"), { lobby: "X4K2", section: DEFAULT_SECTION });
});

test("an empty or bare hash opens the global section", () => {
	for (const hash of ["", "#", "#/", "/", null, undefined]) {
		assert.deepEqual(parseRoute(hash), { lobby: null, section: GLOBAL_SECTION },
			`hash ${JSON.stringify(hash)} should fall back`);
	}
});

test("the leading hash is optional", () => {
	assert.deepEqual(parseRoute("/lobby/X4K2/party"), { lobby: "X4K2", section: "party" });
});

test("lobby codes are upper-cased, matching how the server issues them", () => {
	assert.deepEqual(parseRoute("#/lobby/x4k2/party"), { lobby: "X4K2", section: "party" });
});

test("a malformed lobby code is discarded rather than sent to the server", () => {
	// A hand-edited URL should land somewhere useful, not emit a junk lobby code.
	assert.deepEqual(parseRoute("#/lobby/../party"), { lobby: null, section: GLOBAL_SECTION });
	assert.deepEqual(parseRoute("#/lobby/ab/party"), { lobby: null, section: GLOBAL_SECTION });
	assert.deepEqual(parseRoute("#/lobby//party"), { lobby: null, section: GLOBAL_SECTION });
});

test("an unrecognised route shape falls back instead of throwing", () => {
	assert.deepEqual(parseRoute("#/nonsense/deeply/nested/path"), { lobby: null, section: GLOBAL_SECTION });
	assert.deepEqual(parseRoute("#!/legacy"), { lobby: null, section: GLOBAL_SECTION });
});

test("trailing and repeated slashes are tolerated", () => {
	assert.deepEqual(parseRoute("#//lobbies//"), { lobby: null, section: "lobbies" });
});

test("percent-encoding in the hash is decoded", () => {
	assert.deepEqual(parseRoute("#/lobby/X4K2/turn%20order"), { lobby: "X4K2", section: "turn order" });
});

test("builds a lobby route", () => {
	assert.equal(buildRoute({ lobby: "X4K2", section: "party" }), "#/lobby/X4K2/party");
});

test("builds a global route", () => {
	assert.equal(buildRoute({ section: "lobbies" }), "#/lobbies");
	assert.equal(buildRoute({ lobby: null, section: "toolbox" }), "#/toolbox");
});

test("building with no section falls back to the right default for the scope", () => {
	assert.equal(buildRoute({ lobby: "X4K2" }), `#/lobby/X4K2/${DEFAULT_SECTION}`);
	assert.equal(buildRoute({}), `#/${GLOBAL_SECTION}`);
	assert.equal(buildRoute(), `#/${GLOBAL_SECTION}`);
});

test("building upper-cases a lobby code", () => {
	assert.equal(buildRoute({ lobby: "x4k2", section: "party" }), "#/lobby/X4K2/party");
});

test("building refuses a lobby code the server could never have issued", () => {
	assert.throws(() => buildRoute({ lobby: "../etc", section: "party" }), { name: "TypeError", message: /lobby code/i });
	assert.throws(() => buildRoute({ lobby: "ab", section: "party" }), { name: "TypeError", message: /lobby code/i });
});

test("a built route parses back to what it was built from", () => {
	for (const route of [
		{ lobby: "X4K2", section: "party" },
		{ lobby: "ABCD1234", section: "health" },
		{ lobby: null, section: "lobbies" },
	]) {
		assert.deepEqual(parseRoute(buildRoute(route)), route, `round trip failed for ${JSON.stringify(route)}`);
	}
});
