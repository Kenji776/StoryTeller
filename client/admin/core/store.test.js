import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.js";

test("a new store holds the state it was created with", () => {
	const store = createStore({ lobby: "X4K2", incidents: [] });
	assert.deepEqual(store.getState(), { lobby: "X4K2", incidents: [] });
});

test("a store created with no state starts empty", () => {
	assert.deepEqual(createStore().getState(), {});
});

test("patch merges rather than replaces", () => {
	const store = createStore({ lobby: "X4K2", role: "admin" });
	store.patch({ lobby: "Q7M1" });
	assert.deepEqual(store.getState(), { lobby: "Q7M1", role: "admin" });
});

test("patch reports whether it changed anything", () => {
	const store = createStore({ lobby: "X4K2" });
	assert.equal(store.patch({ lobby: "Q7M1" }), true);
	assert.equal(store.patch({ lobby: "Q7M1" }), false);
});

test("patch adds keys the store did not have", () => {
	const store = createStore({});
	assert.equal(store.patch({ role: "host" }), true);
	assert.deepEqual(store.getState(), { role: "host" });
});

test("an empty patch changes nothing", () => {
	const store = createStore({ lobby: "X4K2" });
	assert.equal(store.patch({}), false);
	assert.deepEqual(store.getState(), { lobby: "X4K2" });
});

test("patch treats undefined as a real value so a key can be cleared", () => {
	const store = createStore({ lobby: "X4K2" });
	assert.equal(store.patch({ lobby: undefined }), true);
	assert.equal(store.getState().lobby, undefined);
});

test("patch rejects input it cannot merge", () => {
	const store = createStore({});
	for (const bad of [null, undefined, "lobby", 7, []]) {
		assert.throws(() => store.patch(bad), { name: "TypeError", message: /object/ },
			`patch(${JSON.stringify(bad)}) should be refused`);
	}
});

test("getState hands back a copy, so a section cannot mutate shared state", () => {
	const store = createStore({ lobby: "X4K2" });
	store.getState().lobby = "TAMPERED";
	assert.equal(store.getState().lobby, "X4K2");
});

test("subscribers are called with the new state when it changes", () => {
	const store = createStore({ lobby: null });
	const seen = [];
	store.subscribe((state) => seen.push(state.lobby));
	store.patch({ lobby: "X4K2" });
	store.patch({ lobby: "Q7M1" });
	assert.deepEqual(seen, ["X4K2", "Q7M1"]);
});

test("subscribers are not called when a patch changes nothing", () => {
	// A socket re-emitting identical state must not re-render the interface
	// underneath someone's cursor.
	const store = createStore({ lobby: "X4K2" });
	let calls = 0;
	store.subscribe(() => { calls += 1; });
	store.patch({ lobby: "X4K2" });
	assert.equal(calls, 0);
});

test("unsubscribing stops delivery", () => {
	const store = createStore({ n: 0 });
	let calls = 0;
	const off = store.subscribe(() => { calls += 1; });
	store.patch({ n: 1 });
	off();
	store.patch({ n: 2 });
	assert.equal(calls, 1);
});

test("unsubscribing twice is harmless", () => {
	const store = createStore({ n: 0 });
	const off = store.subscribe(() => {});
	off();
	assert.doesNotThrow(() => off());
});

test("every subscriber hears about a change", () => {
	const store = createStore({ n: 0 });
	const seen = [];
	store.subscribe(() => seen.push("a"));
	store.subscribe(() => seen.push("b"));
	store.patch({ n: 1 });
	assert.deepEqual(seen, ["a", "b"]);
});

test("one subscriber throwing does not rob the others of the update", () => {
	const store = createStore({ n: 0 });
	const seen = [];
	store.subscribe(() => { throw new Error("section render failed"); });
	store.subscribe(() => seen.push("b"));
	assert.doesNotThrow(() => store.patch({ n: 1 }));
	assert.deepEqual(seen, ["b"]);
});

test("a subscriber that unsubscribes during delivery does not disturb the round", () => {
	const store = createStore({ n: 0 });
	const seen = [];
	const off = store.subscribe(() => { seen.push("a"); off(); });
	store.subscribe(() => seen.push("b"));
	store.patch({ n: 1 });
	assert.deepEqual(seen, ["a", "b"]);
});

test("subscribe rejects a listener it cannot call", () => {
	const store = createStore({});
	assert.throws(() => store.subscribe(null), { name: "TypeError", message: /listener/ });
	assert.throws(() => store.subscribe("go"), { name: "TypeError", message: /listener/ });
});

test("watch fires only when its own slice changes", () => {
	const store = createStore({ incidents: [], lobby: "X4K2" });
	const seen = [];
	store.watch((s) => s.incidents.length, (next) => seen.push(next));
	store.patch({ lobby: "Q7M1" });
	store.patch({ incidents: [{ id: "1" }] });
	store.patch({ lobby: "Z2P9" });
	assert.deepEqual(seen, [1]);
});

test("watch reports the previous value alongside the new one", () => {
	const store = createStore({ n: 1 });
	const seen = [];
	store.watch((s) => s.n, (next, prev) => seen.push([next, prev]));
	store.patch({ n: 2 });
	assert.deepEqual(seen, [[2, 1]]);
});

test("watch compares by value for the counts a badge renders", () => {
	const store = createStore({ incidents: [{ id: "a" }] });
	let calls = 0;
	store.watch((s) => s.incidents.length, () => { calls += 1; });
	store.patch({ incidents: [{ id: "b" }] });
	assert.equal(calls, 0, "a different array of the same length is not a change to the count");
});

test("unwatching stops delivery", () => {
	const store = createStore({ n: 0 });
	let calls = 0;
	const off = store.watch((s) => s.n, () => { calls += 1; });
	store.patch({ n: 1 });
	off();
	store.patch({ n: 2 });
	assert.equal(calls, 1);
});

test("watch rejects a selector or listener it cannot call", () => {
	const store = createStore({});
	assert.throws(() => store.watch(null, () => {}), { name: "TypeError", message: /selector/ });
	assert.throws(() => store.watch((s) => s, null), { name: "TypeError", message: /listener/ });
});

test("a selector that throws does not break the patch", () => {
	const store = createStore({ n: 0 });
	const seen = [];
	store.watch((s) => s.missing.deep, () => seen.push("bad"));
	store.watch((s) => s.n, (next) => seen.push(next));
	assert.doesNotThrow(() => store.patch({ n: 1 }));
	assert.deepEqual(seen, [1]);
});
