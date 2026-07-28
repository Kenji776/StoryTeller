/**
 * personas — turns a scripted playtest client into something that plays.
 *
 * A fixed rotation of canned actions cannot produce a story. It never reacts to
 * what the Dungeon Master said, never presses an advantage, never panics, and so
 * never drives the game into the states worth testing: a fight that goes badly, a
 * character dropping, a party calling for a rest. Those paths — `player:death`,
 * `xp:update`, rest voting, the summariser — only fire when someone actually plays.
 *
 * So each simulated player is given a character, a temperament, and the story so
 * far, and decides its own turn. A small model is enough: the job is one sentence
 * of intent, not prose, and the Dungeon Master supplies the narrative.
 *
 * The character's view of itself is built from the `state:update` snapshot rather
 * than from the advisor's flat summary, because the snapshot carries the whole
 * sheet — abilities, inventory, conditions — and the summary does not. Slot maths
 * is imported from the server's own module so a persona's belief about its
 * remaining uses matches exactly what the feasibility gate will enforce; deriving
 * it separately would let the two drift and produce rejections that look like
 * engine bugs.
 */

import { slotCapacity, remainingSlots, DEFAULT_SLOT_BASE } from "../services/characterCapability.js";

/** Model for player decisions. Deliberately small — 120 turns of it adds up. */
const PLAYER_MODEL = process.env.PERSONA_MODEL || "gpt-4o-mini";

/** How much recent story a player is reminded of before deciding. */
const MEMORY_BEATS = 6;

/**
 * Temperaments, chosen so the party pulls in different directions.
 *
 * @description A table of identical players produces a monotonous game and exercises
 *   one path. The reckless one starts fights, the careful one calls for rests and
 *   healing, the curious one investigates — between them they reach combat, injury,
 *   recovery and discovery without any of it being scripted.
 */
export const PERSONAS = {
	"Brannor Ironfoot": {
		temperament: "Blunt and brave to the point of recklessness. You charge into danger, "
			+ "put yourself between the enemy and your friends, and would rather fight than talk. "
			+ "You take risks other people would not.",
		priorities: "Attack threats directly. Protect Sylvie and Orrin. Never be the first to retreat.",
	},
	"Sylvie Ashwren": {
		temperament: "Sharp, cautious and practical. You scout ahead, look for traps and "
			+ "advantages, and you are the one who notices when the party is hurt. You say so when "
			+ "people need to rest, and you use your items rather than hoarding them.",
		priorities: "Scout and check for danger. Heal or call for a rest when the party is injured. Strike from surprise.",
	},
	"Orrin Vale": {
		temperament: "Curious to a fault. You want to know what things are, where they lead, and "
			+ "what happens if you touch them. You reach for your abilities readily and you press on "
			+ "when others would stop.",
		priorities: "Investigate everything. Spend Magic Missile on real threats. Follow the mystery.",
	},
};

/** What a persona is told when the sheet has not arrived yet. */
const UNKNOWN = { abilities: [], inventory: [], hp: null, maxHp: null, conditions: [], uses: "unknown", allies: [], enemies: [] };

/**
 * @description Builds a persona's live view of itself from a `state:update` snapshot.
 *   Reads the sheet the server actually publishes (`publicState().players[name]`)
 *   rather than a shape invented here — a renderer that guessed its payload is
 *   precisely how the admin feed came to show "dundefined" to real operators.
 * @param {object|null} state - The most recent `state:update` payload.
 * @param {string} name - The character whose view to build.
 * @returns {object} `{abilities, inventory, hp, maxHp, conditions, uses, allies, enemies}`.
 */
export function viewFromState(state, name) {
	const sheet = state?.players?.[name];
	if (!sheet) return { ...UNKNOWN };

	const base = state.abilitySlotsBase ?? DEFAULT_SLOT_BASE;
	const capacity = slotCapacity(sheet, base);
	const uses = capacity === Infinity
		? "unlimited"
		: `${remainingSlots(sheet, base)} of ${capacity}`;

	return {
		// Abilities are objects on new sheets and bare strings on legacy ones.
		abilities: (Array.isArray(sheet.abilities) ? sheet.abilities : [])
			.map((a) => (typeof a === "string" ? a : a?.name))
			.filter(Boolean),
		inventory: (Array.isArray(sheet.inventory) ? sheet.inventory : [])
			.map((i) => (typeof i === "string" ? i : (i?.name && `${i.name}${i.count > 1 ? ` x${i.count}` : ""}`)))
			.filter(Boolean),
		hp: sheet.stats?.hp ?? null,
		maxHp: sheet.stats?.max_hp ?? null,
		conditions: Array.isArray(sheet.conditions) ? sheet.conditions.filter(Boolean) : [],
		uses,
		// Knowing who else is hurt is what makes a party member behave like one.
		allies: (state.party ?? [])
			.filter((m) => m.name !== name)
			.map((m) => `${m.name} (${m.hp}/${m.max_hp} hp${m.conditions && m.conditions !== "None" ? `, ${m.conditions}` : ""})`),
		enemies: (state.enemies ?? [])
			.filter((e) => e.condition !== "Dead" && e.condition !== "Fled")
			.map((e) => `${e.name} (${e.condition})`),
	};
}

/**
 * @description Builds the instruction a persona plays under.
 * @param {object} player - The harness player handle (`{name, spec}`).
 * @param {object} view - The result of `viewFromState`.
 * @returns {string} The system prompt.
 */
export function systemPrompt(player, view) {
	const persona = PERSONAS[player.name] ?? { temperament: "Practical and brave.", priorities: "Act sensibly." };

	return [
		`You are ${player.name}, a ${player.spec?.race ?? ""} ${player.spec?.cls ?? "adventurer"} in a Dungeons & Dragons game.`.replace(/\s+/g, " "),
		`Temperament: ${persona.temperament}`,
		`What you care about: ${persona.priorities}`,
		"",
		`Your abilities: ${view.abilities.join(", ") || "none"}`,
		`You are carrying: ${view.inventory.join(", ") || "nothing"}`,
		`Ability uses left: ${view.uses}`,
		view.hp !== null ? `Your hit points: ${view.hp} of ${view.maxHp}` : "",
		view.conditions.length ? `Affecting you: ${view.conditions.join(", ")}` : "",
		view.allies.length ? `Your companions: ${view.allies.join("; ")}` : "",
		view.enemies.length ? `Enemies present: ${view.enemies.join("; ")}` : "",
		"",
		"It is your turn. Say what you do, in ONE first-person sentence starting with \"I\".",
		"React to what just happened — do not repeat what you did last turn.",
		"Only use abilities and items listed above. With no ability uses left, do something else.",
		"Be specific and physical: name what you touch, who you attack, where you go.",
		"Do not narrate the outcome — the Dungeon Master decides what happens. State only your attempt.",
		"Reply with the sentence and nothing else. No quotation marks, no explanation.",
	].filter(Boolean).join("\n");
}

/**
 * @description Reduces a model reply to the single sentence the game expects.
 * @param {string} text - The raw reply.
 * @returns {string} One line, unquoted, length-capped.
 */
export function sentenceOnly(text) {
	return String(text).trim().split("\n")[0].replace(/^["']|["']$/g, "").slice(0, 220);
}

/**
 * @description Asks a persona what it does next.
 * @param {object} params - Call parameters.
 * @param {object} params.player - The harness player handle.
 * @param {string[]} params.story - Recent narration, oldest first.
 * @param {object|null} params.state - The latest `state:update` snapshot.
 * @param {string} params.apiKey - OpenAI key.
 * @param {function(...*): void} [params.log] - Logger.
 * @param {function} [params.fetchImpl] - Injected for testing.
 * @returns {Promise<string>} A single first-person sentence. Never rejects: a
 *   persona failure must not end the run, so it degrades to a neutral action.
 */
export async function decideAction({ player, story, state, apiKey, log, fetchImpl = fetch }) {
	const view = viewFromState(state, player.name);
	const recent = (story ?? []).slice(-MEMORY_BEATS).join("\n\n") || "The adventure is just beginning.";

	try {
		const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: PLAYER_MODEL,
				max_tokens: 80,
				temperature: 0.9,   // personas should not converge on identical phrasing
				messages: [
					{ role: "system", content: systemPrompt(player, view) },
					{ role: "user", content: `What has happened recently:\n\n${recent}\n\nWhat do you do?` },
				],
			}),
		});

		if (!res.ok) throw new Error(`persona call failed: ${res.status}`);
		const body = await res.json();
		const text = body?.choices?.[0]?.message?.content;
		if (!text || !String(text).trim()) throw new Error("empty persona reply");
		return sentenceOnly(text);
	} catch (err) {
		log?.(player.short ?? player.name, `!! persona failed (${err.message}) — falling back`);
		return "I stay alert and ready myself for whatever comes next.";
	}
}
