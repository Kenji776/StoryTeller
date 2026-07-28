/**
 * llmFailure — tells a failed model call apart from a real one.
 *
 * @description The provider adapters in `llmService` catch their own exceptions and
 *   return an error *string* rather than throwing. That string travels the same
 *   channel as narration, so nothing downstream can tell a dead provider from a
 *   quiet scene. A lobby that opened against an invalid key published
 *   "[Error: LLM unavailable or failed to respond]" to every player as its opening
 *   narration, stored it as the adventure's name, wrote it into the durable story
 *   log, and started the turn clock on top of it — with no incident raised and
 *   nothing retried.
 *
 *   Matching the sentinels is deliberately exact. A loose check on "error" or
 *   "unavailable" would swallow real narration: characters make errors and bridges
 *   are unavailable. Recognising these strings is a guard, not a repair — the
 *   design fault is returning them at all, and that is recorded in ADR 0009.
 */

import { AI_UNAVAILABLE_PREFIX } from "./llmGateway.js";

/**
 * The exact strings a model call returns in place of a reply.
 *
 * The first four came from the retired `llmService`. They are kept because a
 * lobby's persisted history can still contain them, and a repair pass reading
 * that history must not mistake one for narration.
 *
 * `AI_UNAVAILABLE_PREFIX` is the live one: `llmGateway` returns it for every
 * failure, followed by a message written for the person who can fix it. The two
 * modules must stay in step — a sentinel this guard does not recognise would be
 * published to players as story, which is exactly the defect ADR 0009 records.
 */
const FAILURE_SENTINELS = [
	AI_UNAVAILABLE_PREFIX,
	"[Error: LLM unavailable or failed to respond]",
	"[Error: no content returned]",
	"[Stubbed LLM] No OpenAI key configured.",
	"[Stubbed LLM] No Claude API key configured.",
];

/**
 * Reports whether a model reply is a failure rather than usable content.
 *
 * @description Treats a blank or non-string reply as a failure too, so a caller can
 *   ask one question instead of three before deciding whether it has something worth
 *   publishing.
 * @param {*} reply - The raw reply from `getLLMResponse`.
 * @returns {boolean} True when the reply must not be shown to players.
 */
export function isLLMFailure(reply) {
	if (typeof reply !== "string") return true;

	const text = reply.trim();
	if (!text) return true;

	// `includes` rather than equality: a repair pass can hand back a sentinel already
	// wrapped in JSON. The sentinels are distinctive enough that a substring match
	// cannot collide with prose.
	return FAILURE_SENTINELS.some((sentinel) => text.includes(sentinel));
}
