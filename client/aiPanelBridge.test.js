import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that the `window.__aiPanel` bridge exposes everything its callers use.
 *
 * `client/aiPanel.js` is an ES module and the page scripts are classic scripts, so the functions
 * cross that boundary through a hand-written `window.__aiPanel = { … }` object. Nothing checks that
 * the object lists what the callers actually call: a caller reaching for a name the bridge forgot
 * gets `undefined`, and every call site guards with `typeof … !== "function"` and returns quietly.
 *
 * That combination has now hidden a feature four times in this project — a capability built, unit
 * tested, and reachable by nothing. The most recent was the narrator model picker: `modelChoices`
 * had passing tests and a renderer, and `index.html` never exported it, so the panel silently did
 * not render. The unit tests could not see it because the defect lives in the seam between two files
 * that neither test imports.
 *
 * This reads the source as text rather than executing it, which is the only way to inspect a seam
 * built out of a dynamic global. It is deterministic — the repository is the input.
 */

const CLIENT = dirname(fileURLToPath(import.meta.url));
const BRIDGE = "__aiPanel";

/**
 * @description Finds every HTML file under `client/` that builds the bridge, at any depth.
 * @param {string} dir - Directory to walk.
 * @returns {Array<string>} Absolute paths of HTML files assigning the bridge.
 */
function pagesDefiningBridge(dir = CLIENT) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...pagesDefiningBridge(path));
		else if (entry.name.endsWith(".html") && readFileSync(path, "utf8").includes(`window.${BRIDGE} =`)) found.push(path);
	}
	return found;
}

/**
 * @description Reads the names an assignment puts on the bridge. Only the shorthand object form is
 *   recognised, which is the form every page uses; anything cleverer should fail this test loudly
 *   rather than be parsed by guesswork.
 * @param {string} source - The file's text.
 * @returns {Set<string>} The exposed names.
 */
function exposedNames(source) {
	const names = new Set();
	for (const [, body] of source.matchAll(new RegExp(`window\\.${BRIDGE}\\s*=\\s*\\{([^}]*)\\}`, "g"))) {
		for (const part of body.split(",")) {
			const name = part.split(":")[0].trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
		}
	}
	return names;
}

/**
 * @description Reads the names a file calls on the bridge, through either `.x` or `?.x`.
 * @param {string} source - The file's text.
 * @returns {Set<string>} The used names.
 */
function usedNames(source) {
	const used = new Set();
	for (const [, name] of source.matchAll(new RegExp(`${BRIDGE}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) used.add(name);
	return used;
}

/**
 * @description Lists the local classic scripts a page loads, which share the page's global scope and
 *   so may rely on its bridge. Absolute `/foo.js` resolves to `client/foo.js`; CDN URLs are skipped.
 * @param {string} source - The page's text.
 * @returns {Array<string>} Absolute paths that exist on disk.
 */
function localScripts(source) {
	const paths = [];
	for (const [, src] of source.matchAll(/<script[^>]+src="([^"]+)"/g)) {
		if (/^https?:/.test(src)) continue;
		paths.push(join(CLIENT, src.replace(/^\//, "")));
	}
	return paths;
}

const pages = pagesDefiningBridge();

test("some page builds the bridge, so this test cannot pass by finding nothing", () => {
	assert.ok(pages.length > 0, "no HTML file assigns window.__aiPanel — this test would be vacuous");
});

for (const page of pages) {
	const label = page.slice(CLIENT.length + 1).replace(/\\/g, "/");
	const source = readFileSync(page, "utf8");
	const exposed = exposedNames(source);

	test(`${label} exposes every bridge function its own scripts call`, () => {
		assert.ok(exposed.size > 0, `could not read any names out of ${label}'s bridge assignment`);

		// The page's inline scripts plus the classic scripts it loads all share one global scope, so
		// any of them may reach for the bridge this page built.
		const callers = [[label, source], ...localScripts(source).map((path) => {
			try {
				return [path.slice(CLIENT.length + 1).replace(/\\/g, "/"), readFileSync(path, "utf8")];
			} catch {
				return null; // A script that is not on disk is a separate problem from this one.
			}
		}).filter(Boolean)];

		const missing = [];
		for (const [name, text] of callers) {
			for (const used of usedNames(text)) {
				if (!exposed.has(used)) missing.push(`${name} calls ${BRIDGE}.${used}`);
			}
		}

		assert.deepEqual(missing, [], `${label} exposes {${[...exposed].sort().join(", ")}} but:\n  ${missing.join("\n  ")}\n`
			+ "Each of those calls is guarded and fails silently, so the feature simply will not appear.");
	});

	test(`${label} exposes only functions that ${BRIDGE}'s module actually exports`, () => {
		// The mirror of the check above: a name misspelled in the bridge is also `undefined` at the
		// call site, and equally silent.
		const module = readFileSync(join(CLIENT, "aiPanel.js"), "utf8");
		const unknown = [...exposed].filter((name) => !new RegExp(`export\\s+function\\s+${name}\\b`).test(module));
		assert.deepEqual(unknown, [], `${label} puts ${unknown.join(", ")} on the bridge, but aiPanel.js exports no such function`);
	});
}
