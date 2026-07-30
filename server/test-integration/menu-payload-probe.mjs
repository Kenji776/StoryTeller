/**
 * Functional probe: does a browser receive what it needs to draw the battle map?
 *
 * @description The client tints reachable squares green and hit-tests clicks against them, and it
 *   computes none of that itself — the squares arrive on `tactical:menu`. That makes the payload a
 *   contract, and one a unit test cannot check, because it only exists once a real lobby has a real
 *   fight in it.
 *
 *   Written after a whole phase shipped in which `moveMenu` was built, tested, and reached nobody.
 *
 *     npm run dev
 *     node server/test-integration/menu-payload-probe.mjs
 */
import { io } from "socket.io-client";
const URL = "http://localhost:3013";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (s, e, ms = 60000) => new Promise((res, rej) => {
	const t = setTimeout(() => rej(new Error("timeout " + e)), ms);
	s.once(e, (p) => { clearTimeout(t); res(p); });
});

const s = io(URL, { transports: ["websocket"] });
const menus = [];
s.on("tactical:menu", (p) => menus.push(p));
await wait(s, "connect", 15000);
s.emit("lobby:create", {});
const { lobbyId, code } = await wait(s, "lobby:created");
s.emit("player:sheet", { lobbyId, name: "Ayla", sheet: {
	name: "Ayla", class: "Fighter", race: "Human", level: 3,
	stats: { hp: 28, max_hp: 28, str: 18, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
	abilities: [], inventory: [], spells: [],
	weapon: { name: "Greatsword", damage: "2d6", damageType: "slashing", range: "melee" },
	armor: { name: "Chain Mail", ac: 16, type: "heavy", note: "" },
} });
await sleep(400);
s.emit("lobby:settings", { lobbyId, timerEnabled: false, difficulty: "standard", tacticalCombat: true,
	llmProvider: "anthropic", llmModel: "claude-sonnet-5", illustrationMode: "off" });
await sleep(400);
s.emit("player:ready", { lobbyId, ready: true });
await sleep(300);
s.emit("game:start", { lobbyId });
await wait(s, "narration");
await sleep(1500);
s.emit("action:submit", { lobbyId, text: "[admin_command] Two skeletons attack now. Put them in the enemies array, AC 13, 13 hp, CR 1/2." });
await sleep(30000);

const last = menus.at(-1);
console.log("menus received:", menus.length);
if (!last) { console.log("NO tactical:menu — the browser would have nothing to tint"); process.exit(1); }
console.log("player  :", last.player);
console.log("standing:", last.standing);
console.log("reachable:", Array.isArray(last.reachable) ? `${last.reachable.length} squares — ${last.reachable.slice(0, 8).join(", ")}…` : "MISSING");
console.log("menu text present:", !!last.menu);
const ok = Array.isArray(last.reachable) && last.reachable.length > 0 && typeof last.standing === "string";
console.log(ok ? "\nOK — a browser has everything it needs" : "\nFAIL");
s.close();
process.exit(ok ? 0 : 1);
