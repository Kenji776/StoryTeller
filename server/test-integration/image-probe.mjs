/**
 * Which image model does this key actually get, and does it obey "no text"?
 *
 * @description The models endpoint lists what exists, not what an org is allowed to
 *   call, and the gpt-image family rejects `response_format` — a parameter dall-e-3
 *   requires. Both differences only show up on a real call, so this makes one per
 *   candidate and reports what came back.
 *
 *   node server/test-integration/image-probe.mjs [model...]
 */

import "dotenv/config";
import OpenAI from "openai";

const CANDIDATES = process.argv.slice(2).length
	? process.argv.slice(2)
	: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "dall-e-3"];

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PROMPT = "A dwarf fighter with a braided red beard, chain mail, holding a shortsword. "
	+ "Painterly fantasy portrait, dramatic lighting.";

for (const model of CANDIDATES) {
	const started = Date.now();
	try {
		// dall-e-3 requires response_format; the gpt-image family rejects it outright.
		const params = { model, prompt: PROMPT, n: 1, size: "1024x1024" };
		if (model.startsWith("dall-e")) params.response_format = "b64_json";

		const res = await client.images.generate(params);
		const b64 = res?.data?.[0]?.b64_json;
		const url = res?.data?.[0]?.url;
		const ms = Date.now() - started;

		console.log(`${model.padEnd(16)} OK   ${ms}ms  ${b64 ? `${Math.round(b64.length / 1024)}KB base64` : url ? "url returned" : "NO IMAGE DATA"}`);
	} catch (err) {
		console.log(`${model.padEnd(16)} FAIL ${err?.status ?? ""} ${String(err?.message ?? err).slice(0, 150)}`);
	}
}
