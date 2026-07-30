/**
 * journal — reads the gateway's call journal into gradeable evidence.
 *
 * `services/llmGateway.js` appends one line per model call to
 * `server/logs/llm-<lobbyId>.jsonl`, carrying the messages sent, the raw text
 * returned, and how long it took. That file is the only complete record of what a
 * model actually said, which makes it the right ground truth for an evaluation:
 * the socket transcript shows what survived parsing, and a model's failures are
 * mostly things that did not survive parsing.
 *
 * Only some of those calls are the Dungeon Master answering a turn. A lobby also
 * names the adventure, judges submitted actions, compresses history, and — when a
 * reply will not parse — asks the model to repair its own JSON. Those must be
 * counted but never graded: a repair reply is *supposed* to be bare JSON with no
 * narration, so scoring it as a turn would reward the models that fail most often.
 *
 * Pure and synchronous. Reading the file is the caller's job, so this is testable
 * without a filesystem (`CQ-5`).
 */

import { inspectDMReply } from "./dmReply.js";

/** The kinds of model call a lobby makes. */
export const CALL_KINDS = {
	DM_TURN: "dm-turn",
	EPILOGUE: "dm-epilogue",
	REPAIR: "repair",
	JUDGE: "judge",
	TITLE: "title",
	CHRONICLER: "chronicler",
	OTHER: "other",
};

/**
 * Signatures matched against a call's system prompt, in priority order.
 *
 * Order is load-bearing. The repair prompt quotes the DM schema verbatim, and the
 * epilogue prompt opens with the same "You are the Dungeon Master" as an ordinary
 * turn, so the specific cases must be tested before the general one or every
 * repair would inflate the turn count and flatter the model that needed it.
 */
const SIGNATURES = [
	[CALL_KINDS.REPAIR, /JSON repair assistant/i],
	[CALL_KINDS.TITLE, /naming a Dungeons & Dragons adventure/i],
	[CALL_KINDS.JUDGE, /judge whether a player's proposed action is possible/i],
	[CALL_KINDS.CHRONICLER, /campaign chronicler/i],
	[CALL_KINDS.EPILOGUE, /Total Party Kill|narrate the EPILOGUE/i],
	[CALL_KINDS.DM_TURN, /Reply ONLY with a SINGLE JSON object|"combat_over"/],
];

/**
 * @description Concatenates every system message in a call, because the DM prompt
 *   is assembled from several and the marker may sit in any of them.
 * @param {*} entry - A journal entry, or anything.
 * @returns {string} The system text, empty when there is none.
 */
function systemTextOf(entry) {
	if (!entry || typeof entry !== "object" || !Array.isArray(entry.messages)) return "";
	return entry.messages
		.filter((m) => m && typeof m === "object" && m.role === "system" && typeof m.content === "string")
		.map((m) => m.content)
		.join("\n");
}

/**
 * Identifies what a journalled model call was for.
 *
 * @description Matches the system prompt against known signatures rather than
 *   guessing from the reply, because a reply tells you what the model did and the
 *   prompt tells you what was asked — and only the latter is stable when the model
 *   misbehaves.
 * @param {object} entry - A journal entry from `llmGateway`.
 * @returns {string} One of {@link CALL_KINDS}. Unrecognised calls are `other`
 *   rather than assumed to be turns. Never throws.
 */
export function classifyCall(entry) {
	const system = systemTextOf(entry);
	if (!system) return CALL_KINDS.OTHER;
	for (const [kind, pattern] of SIGNATURES) {
		if (pattern.test(system)) return kind;
	}
	return CALL_KINDS.OTHER;
}

/**
 * Turns a lobby's call journal into the evidence bundle `scoreRun` grades.
 *
 * @description Inspects only the Dungeon Master's turns, in play order, so the
 *   combat trace reads a real sequence. Everything else is tallied, because the
 *   auxiliary call count is how the true cost of a model shows up — a model that
 *   needs two repairs a turn is three times the price of its headline rate.
 * @param {object[]} entries - Journal lines, oldest first.
 * @returns {{provider: string|null, model: string|null, inspections: object[],
 *   latencies: number[], calls: object, ops: {providerErrors: number}}} The
 *   evidence. Never throws: a journal can contain a partially-written line.
 */
export function collectEvidence(entries) {
	const calls = Object.fromEntries(Object.values(CALL_KINDS).map((k) => [k, 0]));
	const evidence = {
		provider: null,
		model: null,
		inspections: [],
		latencies: [],
		calls,
		ops: { providerErrors: 0 },
	};
	if (!Array.isArray(entries)) return evidence;

	for (const entry of entries) {
		const kind = classifyCall(entry);
		calls[kind]++;
		if (kind !== CALL_KINDS.DM_TURN) continue;

		if (!evidence.provider && typeof entry.provider === "string") evidence.provider = entry.provider;
		if (!evidence.model && typeof entry.model === "string") evidence.model = entry.model;

		// A call that failed has no reply to inspect. Charging it to json discipline
		// would blame the model for its provider's outage, so it is counted as an
		// operational fault instead and scored under reliability.
		if (entry.error || typeof entry.response !== "string") {
			evidence.ops.providerErrors++;
			continue;
		}

		evidence.inspections.push(inspectDMReply(entry.response));
		if (Number.isFinite(entry.durationMs)) evidence.latencies.push(entry.durationMs);
	}

	return evidence;
}
