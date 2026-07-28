import test from "node:test";
import assert from "node:assert/strict";
import { esc, collapseWhitespace, truncate } from "./text.js";

test("esc neutralises every character that could open a tag or attribute", () => {
	assert.equal(esc(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	assert.equal(esc("it's"), "it&#39;s");
	assert.equal(esc("a & b"), "a &amp; b");
});

test("esc leaves text with nothing to escape untouched", () => {
	assert.equal(esc("Ravenholm Keep"), "Ravenholm Keep");
});

test("esc escapes an ampersand it has already produced", () => {
	// Deliberate: this is called on model output and player input, where guessing
	// whether a string has already been through here is how double-decoding starts.
	assert.equal(esc(esc("<")), "&amp;lt;");
});

test("esc renders non-string input rather than throwing", () => {
	assert.equal(esc(42), "42");
	assert.equal(esc(0), "0");
	assert.equal(esc(null), "");
	assert.equal(esc(undefined), "");
	assert.equal(esc(false), "false");
});

test("esc handles the empty string", () => {
	assert.equal(esc(""), "");
});

test("collapseWhitespace flattens newlines, tabs and runs of spaces", () => {
	assert.equal(collapseWhitespace("  The   door\n\tcreaks  open. "), "The door creaks open.");
});

test("collapseWhitespace returns empty for input that is only whitespace", () => {
	assert.equal(collapseWhitespace("   \n\t  "), "");
	assert.equal(collapseWhitespace(""), "");
	assert.equal(collapseWhitespace(null), "");
});

test("collapseWhitespace is idempotent", () => {
	const once = collapseWhitespace("a  b\n c");
	assert.equal(collapseWhitespace(once), once);
});

test("truncate leaves text that already fits", () => {
	assert.equal(truncate("short", 10), "short");
});

test("truncate returns exactly max characters when it cuts", () => {
	const result = truncate("abcdefghij", 5);
	assert.equal(result.length, 5);
	assert.equal(result, "abcd…");
});

test("truncate does not cut text of exactly the maximum length", () => {
	assert.equal(truncate("abcde", 5), "abcde");
});

test("truncate handles a maximum of one", () => {
	assert.equal(truncate("abcde", 1), "…");
});

test("truncate rejects a maximum that cannot produce a result", () => {
	assert.throws(() => truncate("abc", 0), { name: "RangeError", message: /positive integer/ });
	assert.throws(() => truncate("abc", -1), { name: "RangeError", message: /positive integer/ });
	assert.throws(() => truncate("abc", 1.5), { name: "RangeError", message: /positive integer/ });
	assert.throws(() => truncate("abc", "5"), { name: "RangeError", message: /positive integer/ });
});

test("truncate renders non-string input rather than throwing", () => {
	assert.equal(truncate(1234567, 4), "123…");
	assert.equal(truncate(null, 4), "");
});
