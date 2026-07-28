import test from "node:test";
import assert from "node:assert/strict";

import { sortIncidents, unresolvedCount, severityTone } from "./incidents.js";

/** An incident shaped as `server/services/incidents.js` records it. */
const at = (over = {}) => ({
	id: "i1", kind: "update_dropped", message: "No character named 'Mirra'",
	severity: "warning", count: 1, firstAt: 1000, lastAt: 1000, resolved: false, ...over,
});

test("unresolved incidents come before resolved ones", () => {
	const sorted = sortIncidents([
		at({ id: "done", resolved: true, severity: "error" }),
		at({ id: "open", resolved: false, severity: "info" }),
	]);
	assert.deepEqual(sorted.map((i) => i.id), ["open", "done"]);
});

test("within unresolved, the worst comes first", () => {
	const sorted = sortIncidents([
		at({ id: "info", severity: "info" }),
		at({ id: "error", severity: "error" }),
		at({ id: "warning", severity: "warning" }),
	]);
	assert.deepEqual(sorted.map((i) => i.id), ["error", "warning", "info"]);
});

test("at equal severity, the most recently seen comes first", () => {
	const sorted = sortIncidents([
		at({ id: "old", lastAt: 1000 }),
		at({ id: "new", lastAt: 9000 }),
	]);
	assert.deepEqual(sorted.map((i) => i.id), ["new", "old"]);
});

test("resolved incidents are ordered among themselves too", () => {
	const sorted = sortIncidents([
		at({ id: "r-info", resolved: true, severity: "info" }),
		at({ id: "r-error", resolved: true, severity: "error" }),
	]);
	assert.deepEqual(sorted.map((i) => i.id), ["r-error", "r-info"]);
});

test("a severity this build does not know sorts between error and info", () => {
	// The server can add one without the console being redeployed; burying it under
	// everything, or floating it above a genuine error, are both wrong.
	const sorted = sortIncidents([
		at({ id: "info", severity: "info" }),
		at({ id: "novel", severity: "catastrophe" }),
		at({ id: "error", severity: "error" }),
	]);
	assert.deepEqual(sorted.map((i) => i.id), ["error", "novel", "info"]);
});

test("an incident with no severity is still ordered rather than dropped", () => {
	const sorted = sortIncidents([at({ id: "a", severity: undefined }), at({ id: "b", severity: "error" })]);
	assert.deepEqual(sorted.map((i) => i.id), ["b", "a"]);
	assert.equal(sorted.length, 2);
});

test("sorting does not disturb the array it was given", () => {
	const input = [at({ id: "info", severity: "info" }), at({ id: "error", severity: "error" })];
	sortIncidents(input);
	assert.deepEqual(input.map((i) => i.id), ["info", "error"]);
});

test("sorting handles an empty or absent list", () => {
	assert.deepEqual(sortIncidents([]), []);
	assert.deepEqual(sortIncidents(null), []);
	assert.deepEqual(sortIncidents(undefined), []);
});

test("the count is of what still needs doing", () => {
	assert.equal(unresolvedCount([at({ resolved: false }), at({ resolved: true }), at({ resolved: false })]), 2);
});

test("the count is zero when everything is handled, or there is nothing", () => {
	assert.equal(unresolvedCount([at({ resolved: true })]), 0);
	assert.equal(unresolvedCount([]), 0);
	assert.equal(unresolvedCount(null), 0);
	assert.equal(unresolvedCount(undefined), 0);
});

test("an incident with no resolved flag counts as needing attention", () => {
	// Absent is not the same as handled; assuming otherwise hides a problem.
	assert.equal(unresolvedCount([{ id: "x" }]), 1);
});

test("severities map onto the console's tones", () => {
	assert.equal(severityTone("error"), "danger");
	assert.equal(severityTone("warning"), "warn");
	assert.equal(severityTone("info"), "info");
});

test("an unknown severity gets a tone rather than an empty class", () => {
	for (const severity of ["catastrophe", "", null, undefined, 7]) {
		assert.equal(severityTone(severity), "warn", `${JSON.stringify(severity)} should still have a tone`);
	}
});
