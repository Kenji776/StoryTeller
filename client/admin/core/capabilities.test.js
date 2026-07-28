import test from "node:test";
import assert from "node:assert/strict";
import { ROLES, CAP, capabilitiesFor, can, filterSections } from "./capabilities.js";

/** A section list shaped the way `nav.js` declares them. */
const SECTIONS = [
	{ id: "lobbies", requires: CAP.LOBBY_BROWSE },
	{ id: "party", requires: CAP.PLAY },
	{ id: "health", requires: CAP.OPERATE },
	{ id: "raw", requires: CAP.INSPECT },
	{ id: "toolbox", requires: CAP.CHAR_FILES },
];

test("an admin holds every declared capability", () => {
	const held = capabilitiesFor(ROLES.ADMIN);
	for (const capability of Object.values(CAP)) {
		assert.equal(held.has(capability), true, `admin should hold ${capability}`);
	}
});

test("a host may play, operate and inspect their own lobby", () => {
	const held = capabilitiesFor(ROLES.HOST);
	assert.equal(held.has(CAP.PLAY), true);
	assert.equal(held.has(CAP.OPERATE), true);
	assert.equal(held.has(CAP.INSPECT), true);
});

test("a host may not browse lobbies, delete them, open character files, or log out", () => {
	const held = capabilitiesFor(ROLES.HOST);
	assert.equal(held.has(CAP.LOBBY_BROWSE), false);
	assert.equal(held.has(CAP.LOBBY_DELETE), false);
	assert.equal(held.has(CAP.CHAR_FILES), false);
	assert.equal(held.has(CAP.SESSION_END), false);
});

test("an unrecognised role fails closed rather than open", () => {
	// The role arrives from a fetch response that may have failed. Granting nothing
	// is recoverable; granting everything is not.
	for (const role of ["dungeonmaster", "", null, undefined, 0, {}, []]) {
		assert.deepEqual([...capabilitiesFor(role)], [], `role ${JSON.stringify(role)} should hold nothing`);
	}
});

test("role matching tolerates the casing and padding a JSON field may arrive with", () => {
	assert.equal(can("  ADMIN  ", CAP.CHAR_FILES), true);
	assert.equal(can("Host", CAP.PLAY), true);
});

test("can() rejects a capability the role does not hold", () => {
	assert.equal(can(ROLES.HOST, CAP.LOBBY_DELETE), false);
	assert.equal(can(ROLES.ADMIN, CAP.LOBBY_DELETE), true);
});

test("can() rejects a capability that does not exist", () => {
	assert.equal(can(ROLES.ADMIN, "lobby:nuke"), false);
	assert.equal(can(ROLES.ADMIN, undefined), false);
});

test("the returned set is a copy, so a caller cannot widen its own permissions", () => {
	const held = capabilitiesFor(ROLES.HOST);
	held.add(CAP.LOBBY_DELETE);
	assert.equal(capabilitiesFor(ROLES.HOST).has(CAP.LOBBY_DELETE), false);
});

test("filterSections keeps an admin's sections in the order declared", () => {
	const kept = filterSections(ROLES.ADMIN, SECTIONS);
	assert.deepEqual(kept.map((s) => s.id), ["lobbies", "party", "health", "raw", "toolbox"]);
});

test("filterSections drops the sections a host may not see", () => {
	const kept = filterSections(ROLES.HOST, SECTIONS);
	assert.deepEqual(kept.map((s) => s.id), ["party", "health", "raw"]);
});

test("a section requiring nothing is shown to any authenticated role", () => {
	const kept = filterSections(ROLES.HOST, [{ id: "about" }]);
	assert.deepEqual(kept.map((s) => s.id), ["about"]);
});

test("filterSections returns empty rather than throwing on absent input", () => {
	assert.deepEqual(filterSections(ROLES.ADMIN, []), []);
	assert.deepEqual(filterSections(ROLES.ADMIN, null), []);
	assert.deepEqual(filterSections(ROLES.ADMIN, undefined), []);
});

test("filterSections does not mutate the list it was given", () => {
	const sections = [...SECTIONS];
	filterSections(ROLES.HOST, sections);
	assert.equal(sections.length, SECTIONS.length);
});
