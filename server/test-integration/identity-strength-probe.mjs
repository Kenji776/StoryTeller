/**
 * Quality probe: how hard should the stored likeness pull when drawing a scene?
 *
 * At 1.0 — the API default, and what the first live run used — every scene came
 * back as a studio portrait against grey: the reference image overwhelmed the
 * scene entirely. This draws the same moment at several strengths so the right
 * one can be chosen by looking rather than guessing.
 *
 * Writes into the scratchpad, not the repo. Run by hand; it costs GPU time.
 */

import dotenv from "dotenv";
import fetchImpl from "node-fetch";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: new URL("../.env", import.meta.url) });

const { createCredentialSystem } = await import("../services/credentials/index.js");
const { localImageProvider } = await import("../services/images/providers/localImageServer.js");
const { buildAppearance } = await import("../../client/portraitPrompt.js");

const OUT = process.argv[2] ?? ".";
const STRENGTHS = [1.0, 0.85, 0.8];
const SCENE = "setting out on the road at first light, pack shouldered, open country ahead, full body, wide shot";

const credentials = createCredentialSystem({
	dataDir: new URL("../data/credentials", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
	secret: process.env.STORYTELLER_SECRET || null,
	log: () => {},
});

const config = {
	providerId: "local-image",
	apiKey: credentials.vault.read("local-image"),
	model: null,
	baseUrl: credentials.getPolicy().image["local-image"].baseUrl,
};

const sheet = {
	name: "Sylvie Ashwren",
	race: "Human",
	class: "Rogue",
	gender: "woman",
	description: "close-cropped auburn hair, a leather jerkin over green wool, twin daggers at her belt",
};

const appearance = buildAppearance(sheet);
console.log("appearance:", appearance);

const character = await localImageProvider.createCharacter({
	name: `${sheet.name} probe`,
	appearance,
	config,
	fetchImpl,
});
console.log("likeness:", character.id);

fs.writeFileSync(path.join(OUT, "strength-reference.png"), Buffer.from(character.b64, "base64"));

for (const identityStrength of STRENGTHS) {
	const started = Date.now();
	const image = await localImageProvider.generateForCharacter({
		characterId: character.id,
		scene: SCENE,
		identityStrength,
		size: { width: 896, height: 1152 },
		config,
		fetchImpl,
	});
	const file = path.join(OUT, `strength-${String(identityStrength).replace(".", "_")}.png`);
	fs.writeFileSync(file, Buffer.from(image.b64, "base64"));
	console.log(`  ${identityStrength} -> ${file} (${Math.round((Date.now() - started) / 1000)}s)`);
}

await localImageProvider.deleteCharacter({ characterId: character.id, config, fetchImpl });
console.log("probe likeness cleaned up");
