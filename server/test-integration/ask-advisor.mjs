import { io } from "socket.io-client";

/**
 * Joins a running lobby as an existing character and asks the advisor for help.
 *
 * @description Exercises the real socket path rather than calling suggestActions
 *   directly, so the membership check and the reply shape are covered too.
 */
const URL = process.argv[2] || "http://localhost:3077";
const CODE = process.argv[3];
const CHAR = process.argv[4];

const socket = io(URL, { transports: ["websocket"] });

socket.on("connect", () => {
	socket.emit("join:rejoin", { lobbyCode: CODE, charName: CHAR, clientId: "advisor-probe", characterId: undefined });
});

socket.on("join:confirmed", ({ lobbyId }) => {
	console.log(`joined ${lobbyId} as ${CHAR}; asking the advisor…\n`);
	socket.emit("advisor:ask", { lobbyId, playerName: CHAR, question: "I have no idea what to do. What are my options?" });
});

socket.on("advisor:reply", ({ options, note, capability }) => {
	console.log("CHARACTER:", JSON.stringify(capability));
	console.log(`\n${options.length} option(s)${note ? ` — ${note}` : ""}\n`);
	options.forEach((o, i) => {
		console.log(`${i + 1}. ${o.title}   [${o.risk} risk]`);
		console.log(`   type: "${o.action}"`);
		console.log(`   uses: ${o.uses.kind}${o.uses.name ? ` (${o.uses.name})` : ""} | costs: ${o.cost}`);
		if (o.check) console.log(`   check: ${o.check.plain}`);
		console.log(`   why: ${o.why}\n`);
	});
	socket.disconnect();
	process.exit(0);
});

socket.on("toast", (t) => { if (t?.type === "error") console.log("toast:", t.message || t.text); });

setTimeout(() => { console.log("timed out"); process.exit(1); }, 30000);
