/**
 * oocQuestion — tells a question about the rules from an action in the story.
 *
 * @description The server had no concept of one. "ooc how do spell slots work in
 *   this game?" was handed to the narrator as a game action, and answered with a
 *   generic 5e lecture — slots by level, recovered on a long rest — describing a
 *   system this game does not use. It has a single shared pool covering every
 *   ability, martial and magical alike, sized by a host setting.
 *
 *   The lecture was then broadcast to every player as DM narration and appended to
 *   the story history the DM is re-prompted with, so rules that contradict this
 *   lobby became part of its own context for every later turn. It also consumed the
 *   asker's turn.
 *
 *   Detection is deliberately anchored to the start of the message. A player writing
 *   "I occupy the doorway" is acting, not asking, and diverting that would be worse
 *   than missing the occasional question.
 */

/** Longest question passed on. Beyond this it is a paste, not a question. */
const MAX_QUESTION = 500;

/** The forms a table actually uses to step outside the fiction. */
const PREFIXES = [
	// `ooc`, optionally parenthesised, optionally followed by punctuation.
	/^\(?\s*ooc\s*\)?\s*[:,\-–—]?\s*/i,
	// `// question`
	/^\/\/\s*/,
	// `((question))` — trailing parens are stripped separately.
	/^\(\(\s*/,
];

/**
 * Classifies a submitted message as a rules question or an in-character action.
 *
 * @param {*} text - The raw submitted text.
 * @returns {{isOoc: boolean, question: string}} `isOoc` is true only when a prefix
 *   was found *and* something was asked after it; `question` is the stripped and
 *   length-capped remainder, or `""`.
 */
export function isOutOfCharacter(text) {
	if (typeof text !== "string") return { isOoc: false, question: "" };

	const trimmed = text.trim();
	if (!trimmed) return { isOoc: false, question: "" };

	for (const prefix of PREFIXES) {
		if (!prefix.test(trimmed)) continue;

		const question = trimmed
			.replace(prefix, "")
			.replace(/\)\)\s*$/, "")   // closing half of `((…))`
			.trim()
			.slice(0, MAX_QUESTION);

		// A bare prefix asks nothing. Letting it through would have the model answer
		// an empty string, which is worse than treating it as a fumbled action.
		return question ? { isOoc: true, question } : { isOoc: false, question: "" };
	}

	return { isOoc: false, question: "" };
}

/**
 * Builds the instruction for answering a rules question about *this* game.
 *
 * @description The model's memory of D&D is not the authority here — it answered
 *   "how do spell slots work" with the 5e per-level table recovered on a long rest,
 *   which is not this system. So the prompt states the real rule, supplies the
 *   asker's own sheet so the answer can be specific rather than general, and says
 *   plainly that this is not narration. The last part matters: the previous answer
 *   was published to the whole table as story.
 * @param {string} question - The question, already stripped of its prefix.
 * @param {object} capability - The asker's capability from `buildCapability`.
 * @returns {string} The system prompt.
 */
export function buildRulesPrompt(question, capability) {
	const id = capability?.identity ?? {};
	const health = capability?.health ?? {};
	const slots = capability?.resources?.slots ?? {};

	const uses = slots.unlimited
		? "unlimited — this lobby was configured with no cap"
		: `${slots.remaining ?? "?"} of ${slots.max ?? "?"}`;

	const abilities = (capability?.abilities ?? []).map((a) => a.name).filter(Boolean).join(", ") || "none";
	const items = (capability?.inventory ?? [])
		.map((i) => (i?.name ? `${i.name}${i.count > 1 ? ` x${i.count}` : ""}` : null))
		.filter(Boolean).join(", ") || "nothing";

	return [
		"You are answering a rules question for a player, out of character.",
		"You are NOT the Dungeon Master and this is NOT narration. Do not describe a scene,",
		"do not advance the story, and do not address anyone but the person asking.",
		"",
		"HOW THIS GAME WORKS — this overrides anything you remember about D&D 5e:",
		"- There is ONE shared pool of ability uses per character. It covers every ability,",
		"  martial and magical alike — a Fighter's Second Wind draws on the same pool as a",
		"  Wizard's Magic Missile.",
		"- Do NOT describe per-level spell slot tables, slot levels, or preparing spells.",
		"  This game has none of that. Never explain 5e spell slots.",
		"- The pool size is set by the host, plus one per level above 1. It refills on a long rest.",
		"",
		"THE PLAYER ASKING:",
		id.name ? `- ${id.name}, a level ${id.level ?? 1} ${id.race ?? ""} ${id.className ?? "adventurer"}`.replace(/\s+/g, " ") : "- (sheet unavailable)",
		health.hp !== undefined && health.hp !== null ? `- Hit points: ${health.hp}/${health.maxHp ?? "?"}` : "",
		`- Ability uses left: ${uses}`,
		`- Abilities: ${abilities}`,
		`- Carrying: ${items}`,
		capability?.conditions?.length ? `- Currently: ${capability.conditions.join(", ")}` : "",
		capability?.equipped?.armorClass ? `- Armour class: ${capability.equipped.armorClass}` : "",
		"",
		`THE QUESTION: ${question}`,
		"",
		"Answer in two or three sentences, plainly, using this character's actual numbers.",
		"If the question is about something this game does not have, say so briefly.",
	].filter(Boolean).join("\n");
}
