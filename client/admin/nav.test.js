import test from "node:test";
import assert from "node:assert/strict";

import { SECTIONS, sectionById, groupSections, resolveView } from "./nav.js";
import { ROLES, CAP, filterSections } from "./core/capabilities.js";
import { GLOBAL_SECTION, DEFAULT_SECTION } from "./core/router.js";

test("every section declares the fields the shell needs to render it", () => {
	for (const section of SECTIONS) {
		assert.equal(typeof section.id, "string", `${section.id}: id`);
		assert.equal(typeof section.label, "string", `${section.id}: label`);
		assert.equal(typeof section.group, "string", `${section.id}: group`);
		assert.ok(["global", "lobby"].includes(section.scope), `${section.id}: scope`);
		assert.ok(Object.values(CAP).includes(section.requires), `${section.id}: requires a real capability`);
	}
});

test("section ids are unique, so a route can never be ambiguous", () => {
	const ids = SECTIONS.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length);
});

test("the router's default sections exist in the registry", () => {
	// Otherwise a fallback route resolves to nothing and the panel renders blank.
	assert.ok(sectionById(GLOBAL_SECTION), `${GLOBAL_SECTION} must be a real section`);
	assert.ok(sectionById(DEFAULT_SECTION), `${DEFAULT_SECTION} must be a real section`);
});

test("the router's global fallback is a global-scope section", () => {
	assert.equal(sectionById(GLOBAL_SECTION).scope, "global");
});

test("the router's lobby default is a lobby-scope section", () => {
	assert.equal(sectionById(DEFAULT_SECTION).scope, "lobby");
});

test("sectionById returns nothing for an id that does not exist", () => {
	assert.equal(sectionById("nope"), undefined);
	assert.equal(sectionById(""), undefined);
	assert.equal(sectionById(null), undefined);
	assert.equal(sectionById(undefined), undefined);
});

test("groupSections collects sections under their group heading", () => {
	const groups = groupSections([
		{ id: "a", group: "Play" },
		{ id: "b", group: "Play" },
		{ id: "c", group: "Operate" },
	]);
	assert.deepEqual(groups.map((g) => g.group), ["Play", "Operate"]);
	assert.deepEqual(groups[0].sections.map((s) => s.id), ["a", "b"]);
	assert.deepEqual(groups[1].sections.map((s) => s.id), ["c"]);
});

test("groupSections keeps groups in the order they first appear", () => {
	const groups = groupSections([
		{ id: "a", group: "Operate" },
		{ id: "b", group: "Play" },
		{ id: "c", group: "Operate" },
	]);
	assert.deepEqual(groups.map((g) => g.group), ["Operate", "Play"]);
	assert.deepEqual(groups[0].sections.map((s) => s.id), ["a", "c"]);
});

test("groupSections handles an empty or absent list", () => {
	assert.deepEqual(groupSections([]), []);
	assert.deepEqual(groupSections(null), []);
	assert.deepEqual(groupSections(undefined), []);
});

test("an admin sees every group", () => {
	const groups = groupSections(filterSections(ROLES.ADMIN, SECTIONS));
	assert.deepEqual(groups.map((g) => g.group), ["All lobbies", "Play", "Operate", "Inspect", "Server", "Tools"]);
});

test("a host sees the game groups but not the ones that reach past their lobby", () => {
	const groups = groupSections(filterSections(ROLES.HOST, SECTIONS));
	assert.deepEqual(groups.map((g) => g.group), ["Play", "Operate", "Inspect"]);
});

test("a host is never offered the provider configuration", () => {
	// The API keys under Server pay for every game on the instance, not just this
	// host's. `routes/providerAdmin.js` refuses a host token independently, so this
	// is the second of two locks rather than the only one.
	const sections = filterSections(ROLES.HOST, SECTIONS);
	assert.equal(sections.some((s) => s.id === "providers"), false);
});

test("resolveView honours a route that is allowed and has what it needs", () => {
	const view = resolveView({ route: { lobby: "X4K2", section: "party" }, role: ROLES.ADMIN });
	assert.equal(view.section.id, "party");
	assert.equal(view.lobby, "X4K2");
	assert.equal(view.redirected, false);
});

test("resolveView allows a global section with no lobby connected", () => {
	const view = resolveView({ route: { lobby: null, section: "lobbies" }, role: ROLES.ADMIN });
	assert.equal(view.section.id, "lobbies");
	assert.equal(view.redirected, false);
});

test("a lobby section with no lobby connected falls back rather than rendering empty", () => {
	const view = resolveView({ route: { lobby: null, section: "party" }, role: ROLES.ADMIN });
	assert.equal(view.section.id, "lobbies");
	assert.equal(view.redirected, true);
});

test("a section the role may not see falls back instead of being rendered", () => {
	const view = resolveView({ route: { lobby: "X4K2", section: "toolbox" }, role: ROLES.HOST });
	assert.equal(view.redirected, true);
	assert.notEqual(view.section?.id, "toolbox");
});

test("a section that does not exist falls back", () => {
	const view = resolveView({ route: { lobby: "X4K2", section: "wharrgarbl" }, role: ROLES.ADMIN });
	assert.equal(view.section.id, "lobbies");
	assert.equal(view.redirected, true);
});

test("a host keeps their lobby when falling back, since they cannot browse to another", () => {
	const view = resolveView({ route: { lobby: "X4K2", section: "toolbox" }, role: ROLES.HOST });
	assert.equal(view.lobby, "X4K2");
	assert.equal(view.section.id, "dashboard", "falls back to the first section a host can actually use");
});

test("a host with no lobby yet has nothing to render", () => {
	// The host view authenticates and connects on load; until that lands there is
	// no lobby, and a host has no global section to fall back to.
	const view = resolveView({ route: { lobby: null, section: "party" }, role: ROLES.HOST });
	assert.equal(view.section, null);
	assert.equal(view.redirected, true);
});

test("an unrecognised role is shown nothing at all", () => {
	const view = resolveView({ route: { lobby: "X4K2", section: "party" }, role: "wizard" });
	assert.equal(view.section, null);
	assert.equal(view.redirected, true);
});

test("resolveView tolerates being called with nothing", () => {
	assert.doesNotThrow(() => resolveView());
	assert.doesNotThrow(() => resolveView({}));
	assert.equal(resolveView({}).section, null);
});

test("every section a role can reach resolves to itself", () => {
	// A section in the registry that no route can land on is dead weight.
	for (const role of [ROLES.ADMIN, ROLES.HOST]) {
		for (const section of filterSections(role, SECTIONS)) {
			const view = resolveView({ route: { lobby: "X4K2", section: section.id }, role });
			assert.equal(view.section.id, section.id, `${role} should reach ${section.id}`);
			assert.equal(view.redirected, false, `${role} reaching ${section.id} should not redirect`);
		}
	}
});
