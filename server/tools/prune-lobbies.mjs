/**
 * Reports, and optionally removes, disposable lobby files.
 *
 * @description The landing page lists nearly every stored lobby, and 66 had accumulated.
 *   Profiling showed the median age was one day and twelve had never been played: this is
 *   integration-probe litter, not stale player data — every probe creates a lobby through
 *   the real socket path and none of them clean up.
 *
 *   Dry by default. It prints what it would remove and why, and only deletes when told
 *   to, because the directory also holds real games.
 *
 *     node server/tools/prune-lobbies.mjs            # report only
 *     node server/tools/prune-lobbies.mjs --delete   # actually remove
 *
 *   The decision itself lives in `services/lobbyMaintenance.js` so it can be unit tested;
 *   this file is the shell that touches the disk.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { planPrune, STALE_DAYS } from "../services/lobbyMaintenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOBBY_DIR = path.join(__dirname, "..", "data", "lobbies");

const DELETE = process.argv.includes("--delete");

if (!fs.existsSync(LOBBY_DIR)) {
	console.error(`No lobby directory at ${LOBBY_DIR}`);
	process.exit(1);
}

const entries = [];
const unreadable = [];
for (const file of fs.readdirSync(LOBBY_DIR)) {
	if (!file.endsWith(".json")) continue;
	const full = path.join(LOBBY_DIR, file);
	try {
		entries.push({ id: file, lobby: JSON.parse(fs.readFileSync(full, "utf8")) });
	} catch (err) {
		// Never swept: a file that will not parse is the one most worth a human looking at.
		unreadable.push(`${file} — ${err.message}`);
	}
}

const { prune, keep } = planPrune(entries, Date.now());

console.log(`${entries.length} lobbies read from ${LOBBY_DIR}`);
console.log(`  keeping ${keep.length}, ${prune.length} disposable (stale threshold ${STALE_DAYS} days)\n`);

for (const entry of prune) console.log(`  ${DELETE ? "removed" : "would remove"}  ${entry.id.padEnd(14)} ${entry.reason}`);
if (unreadable.length) {
	console.log(`\n  ${unreadable.length} file(s) could not be parsed and were left alone:`);
	for (const line of unreadable) console.log(`    ${line}`);
}

if (!DELETE) {
	console.log(`\nDry run. Re-run with --delete to remove the ${prune.length} listed above.`);
	process.exit(0);
}

let removed = 0;
for (const entry of prune) {
	try {
		fs.unlinkSync(path.join(LOBBY_DIR, entry.id));
		removed++;
	} catch (err) {
		console.error(`  failed to remove ${entry.id}: ${err.message}`);
	}
}
console.log(`\nRemoved ${removed} of ${prune.length}.`);
