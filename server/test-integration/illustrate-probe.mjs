/**
 * Functional probe: does an illustration actually reach a player?
 *
 * Drives the real pieces — a real DM call producing a real `illustrate`
 * directive, the real gate, the real image server, the real socket events — and
 * reports what a browser would have received, in order.
 */

import dotenv from "dotenv";
import fetchImpl from "node-fetch";

dotenv.config({ path: new URL("../.env", import.meta.url) });

const { createCredentialSystem } = await import("../services/credentials/index.js");
const { createLLMGateway } = await import("../services/llmGateway.js");
const { createIllustrationRunner } = await import("../services/images/illustrationRunner.js");
const { buildAppearance } = await import("../../client/portraitPrompt.js");
const { localImageProvider } = await import("../services/images/providers/localImageServer.js");

const credentials = createCredentialSystem({
	dataDir: new URL("../data/credentials", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
	secret: process.env.STORYTELLER_SECRET || null,
	log: () => {},
});
const gateway = createLLMGateway({ credentials, logDir: new URL("../logs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), fetchImpl, log: () => {} });

const LOBBY = "probe-illustrate";
const SHEET = {
	name: "Brannor Ironfoot",
	race: "Dwarf",
	class: "Paladin",
	gender: "man",
	description: "a braided copper beard, a scar across the left brow, dented steel plate",
};

// ── 1. The character gets a likeness, as a portrait would give them ──────────
const appearance = buildAppearance(SHEET);
const portrait = await gateway.ensureCharacterImage({ lobbyId: LOBBY, record: {}, name: SHEET.name, appearance });
console.log(`1. likeness stored     ${portrait.characterId} (${Math.round(portrait.b64.length * 0.75 / 1024)} KB portrait)`);

const party = [{ name: SHEET.name, imageCharacterId: portrait.characterId }];

// ── 2. A real DM call, told illustrations are on, at a climactic beat ────────
const lobby = { illustrationMode: "key-moments", lastIllustrationAt: null };

const dmMessages = [
	{
		role: "system",
		content:
			'You are a Dungeon Master. Reply with minified JSON only, schema: '
			+ '{ "text": string, "illustrate": { "moment": string, "characters": string[], "subject": string, "mood": string } | null }. '
			+ 'Use "illustrate" ONLY at a genuinely memorable beat. Put what is HAPPENING in "moment" (never what anyone looks like), '
			+ 'list exact party member names in "characters", and give a one-word "mood". '
			+ `The party is: ${party.map((p) => p.name).join(", ")}.`,
	},
	{
		role: "user",
		content:
			"Brannor Ironfoot lands the killing blow on the cave troll that has hunted the party for three days. "
			+ "It collapses at his feet. Narrate this in two sentences.",
	},
];

const raw = await gateway.getLLMResponse(dmMessages, {
	provider: "anthropic",
	model: "claude-sonnet-4-6",
	lobbyId: LOBBY,
});

let dmObj;
try {
	dmObj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "").trim());
} catch {
	console.log("   DM did not return JSON:", raw.slice(0, 160));
	process.exit(1);
}

console.log(`2. DM narration        "${(dmObj.text || "").slice(0, 72)}..."`);
console.log(`   DM illustrate       ${JSON.stringify(dmObj.illustrate)}`);

if (!dmObj.illustrate) {
	console.log("   -> the DM declined to illustrate this beat; nothing further to test");
	process.exit(0);
}

// ── 3. The runner, with the real image server behind it ─────────────────────
const events = [];
const runner = createIllustrationRunner({
	gateway,
	partyOf: () => party,
	settingsOf: () => lobby,
	markIllustrated: (id, at) => { lobby.lastIllustrationAt = at; },
	saveImage: async (name, b64) => {
		const fs = await import("node:fs");
		fs.writeFileSync(new URL(`../data/images/${name}.png`, import.meta.url), Buffer.from(b64, "base64"));
		return `/character-images/${name}.png`;
	},
	emit: (lobbyId, event, payload) => {
		events.push({ event, at: Date.now() });
		console.log(`   [${new Date().toISOString().slice(11, 19)}] -> ${event}${payload.caption ? ` "${String(payload.caption).slice(0, 50)}"` : ""}${payload.images ? ` (${payload.images.length} image(s))` : ""}${payload.error ? ` (${payload.error})` : ""}`);
	},
	log: () => {},
});

console.log("3. socket events a browser would receive, in order:");
const started = Date.now();
await runner.consider(LOBBY, dmObj);

const pending = events.find((e) => e.event === "illustration:pending");
const ready = events.find((e) => e.event === "illustration:ready");
console.log(`4. placeholder shown after ${pending ? pending.at - started : "n/a"} ms; image ready after ${ready ? ready.at - started : "n/a"} ms`);

// ── 4. The cooldown holds ───────────────────────────────────────────────────
const before = events.length;
await runner.consider(LOBBY, dmObj);
console.log(`5. immediate second beat -> ${events.length === before ? "correctly skipped (cooldown)" : "DREW AGAIN, cooldown failed"}`);

await localImageProvider.deleteCharacter({
	characterId: portrait.characterId,
	config: { providerId: "local-image", apiKey: credentials.vault.read("local-image"), baseUrl: credentials.getPolicy().image["local-image"].baseUrl },
	fetchImpl,
});
console.log("6. probe likeness cleaned up");
