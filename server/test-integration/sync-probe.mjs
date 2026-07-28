/**
 * Asks a live server to replay a specific range, proving gap recovery end to end.
 *
 * @description The playtest harness records frames but does not run the browser's
 *   gap detector, so a gap it observes is real but unrecovered. This joins the lobby
 *   room and issues the same `sync:request` the browser would, showing whether the
 *   journal can still serve the events that were missed.
 *
 *   node server/test-integration/sync-probe.mjs <url> <lobbyId> <haveSeq>
 */

import { io } from "socket.io-client";

const URL = process.argv[2] || "http://localhost:3077";
const LOBBY_ID = process.argv[3];
const HAVE_SEQ = Number(process.argv[4] ?? 0);

const socket = io(URL, { transports: ["websocket"] });
let epoch = null;

// state:request joins the lobby room, which is what makes sequenced frames arrive.
socket.on("connect", () => socket.emit("state:request", { lobbyId: LOBBY_ID }));
socket.onAny((event, payload, meta) => { if (meta?.epoch && !epoch) epoch = meta.epoch; });

setTimeout(() => {
	console.log(`asking ${LOBBY_ID} to replay everything after seq ${HAVE_SEQ} (epoch ${epoch})\n`);
	socket.emit("sync:request", { lobbyId: LOBBY_ID, haveSeq: HAVE_SEQ, haveEpoch: epoch }, (r) => {
		if (!r) { console.error("no acknowledgement"); process.exit(1); }
		console.log(`mode: ${r.mode}`);
		if (r.mode === "replay") {
			console.log(`range: ${r.fromSeq}..${r.toSeq}  (${r.events.length} replayable events)\n`);
			for (const e of r.events.slice(0, 14)) console.log(`  seq ${String(e.meta.seq).padStart(3)}  ${e.name}`);
			if (r.events.length > 14) console.log(`  … and ${r.events.length - 14} more`);
		} else if (r.mode === "snapshot") {
			console.log(`snapshot at seq ${r.seq} — the gap was older than the journal, or spanned a snapshot`);
		} else {
			console.log(`denied: ${r.reason}`);
		}
		socket.disconnect();
		process.exit(0);
	});
}, 3000);

setTimeout(() => { console.error("timed out"); process.exit(1); }, 20000);
