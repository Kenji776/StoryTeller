import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that every lobby setting the server accepts has something in the UI that sends it.
 *
 * `lobby:settings` is one handler destructuring a long list of names. Adding a setting to it is a
 * one-line change on the server and a separate change in a browser file nobody is looking at, and
 * when the second one is skipped there is no error anywhere: the key arrives as `undefined`, every
 * branch is written to tolerate that, and the feature is simply unreachable.
 *
 * That is how `tacticalCombat` sat unusable from the moment it was built. The whole tactical combat
 * feature — eight server modules, a renderer, a hundred tests — could only be switched on by editing
 * a lobby's JSON by hand, because no page ever sent the flag. It was the fifth capability in this
 * project found built, tested, and wired to nothing, which is why this test exists rather than a
 * one-line fix.
 *
 * Reads the source as text. The defect lives between two files, so no test that imports either one
 * can see it.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The settings deliberately not offered in the game options window, and why.
 *
 * Anything listed here is a claim that a human decided it, not an excuse for having forgotten. Adding
 * a name should feel like a decision.
 */
const NOT_IN_OPTIONS = Object.freeze({
	lobbyId: "the address, not a setting",
	narratorVoiceName: "sent alongside narratorVoiceId as a label, never chosen on its own",
});

/**
 * @description Reads a repository file.
 * @param {string} relative - Path from the repository root.
 * @returns {string} Its text.
 * @throws {Error} When the file is missing, which is itself the failure this test looks for.
 */
function source(relative) {
	return readFileSync(join(ROOT, "..", relative), "utf8");
}

/**
 * @description Reads the names the server destructures out of a socket handler's payload.
 * @param {string} text - `server.js`'s text.
 * @param {string} event - The socket event.
 * @returns {Array<string>} The parameter names, in source order.
 * @throws {Error} When the handler cannot be found, so a rename fails loudly here.
 */
function acceptedBy(text, event) {
	const match = new RegExp(`socket\\.on\\(\\s*"${event}"\\s*,\\s*(?:async\\s*)?\\(\\s*\\{([^}]*)\\}`).exec(text);
	if (!match) throw new Error(`could not find the ${event} handler in server.js`);
	return match[1].split(",").map((part) => part.trim().split(/[:=]/)[0].trim()).filter(Boolean);
}

/**
 * Reads the keys a file sends in a given event's payload.
 *
 * @description Brace-counted rather than regexed to the closing paren, because the payload contains
 *   nested objects and ternaries; a lazy match stops at the first `}` and silently reports half the
 *   keys, which for this test would mean inventing failures.
 * @param {string} text - The file's text.
 * @param {string} event - The socket event.
 * @returns {Set<string>} Top-level keys of every payload sent for that event.
 */
function sentBy(text, event) {
	const keys = new Set();
	const marker = new RegExp(`emit\\(\\s*"${event}"\\s*,\\s*\\{`, "g");

	for (let found = marker.exec(text); found; found = marker.exec(text)) {
		let depth = 1;
		const start = found.index + found[0].length;
		let i = start;
		for (; i < text.length && depth > 0; i++) {
			if (text[i] === "{") depth++;
			else if (text[i] === "}") depth--;
		}
		// Only depth-1 keys count. A nested `{id, label}` is part of a value, not a setting.
		const body = text.slice(start, i - 1);
		let nested = 0;
		for (const line of body.split("\n")) {
			if (nested === 0) {
				const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
				if (key) keys.add(key[1]);
				// A shorthand key on its own line, as `lobbyId,` is written.
				const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*,\s*$/.exec(line);
				if (shorthand) keys.add(shorthand[1]);
			}
			nested += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
		}
	}
	return keys;
}

/**
 * @description Every browser file that could send lobby settings, so a setting moved from one screen
 *   to another does not read as missing.
 * @returns {Array<[string, string]>} Pairs of label and text.
 */
function clientSenders() {
	const found = [];
	for (const dir of ["client", join("client", "components")]) {
		for (const entry of readdirSync(join(ROOT, "..", dir), { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(js|html)$/.test(entry.name) || entry.name.includes(".test.")) continue;
			const relative = join(dir, entry.name).replace(/\\/g, "/");
			const text = source(relative);
			if (text.includes(`"lobby:settings"`)) found.push([relative, text]);
		}
	}
	return found;
}

const server = source("server/server.js");
const accepted = acceptedBy(server, "lobby:settings");
const senders = clientSenders();

test("the settings handler and at least one sender were both found", () => {
	// Guards against this whole file passing because a regex stopped matching after a refactor.
	assert.ok(accepted.length > 5, `only found ${accepted.length} accepted settings — the regex has drifted`);
	assert.ok(senders.length > 0, "no client file sends lobby:settings — the extractor has drifted");
});

test("every setting the server accepts is sent by some part of the UI", () => {
	const sent = new Set(senders.flatMap(([, text]) => [...sentBy(text, "lobby:settings")]));
	const missing = accepted.filter((name) => !sent.has(name) && !Object.hasOwn(NOT_IN_OPTIONS, name));

	assert.deepEqual(missing, [], missing.length
		? `the server accepts ${missing.join(", ")} but nothing sends it.\n`
			+ `  Senders checked: ${senders.map(([name]) => name).join(", ")}\n`
			+ "  A setting nothing sends is a feature that cannot be switched on, and it fails silently:\n"
			+ "  the key arrives undefined and every branch tolerates that. Add it to the options UI, or\n"
			+ "  to NOT_IN_OPTIONS with the reason it is deliberately absent."
		: "");
});

test("nothing sits in the exemption list that the server no longer accepts", () => {
	// A stale exemption is a hole in the check above: it silences a name that may since have become a
	// real setting sent from nowhere.
	const stale = Object.keys(NOT_IN_OPTIONS).filter((name) => !accepted.includes(name));
	assert.deepEqual(stale, [], `NOT_IN_OPTIONS names ${stale.join(", ")}, which lobby:settings no longer accepts`);
});
