// Compact schema used when asking the LLM to repair malformed JSON
export const DM_JSON_SCHEMA = `{
	"text": string,
	"updates": {
		"xp": [{ "player": string, "amount": number, "reason": string }],
		"hp": [{ "player": string, "delta": number, "reason": string, "new_total": number }],
		"inventory": [{ "player": string, "item": string, "change": number, "description": string, "change_type": "add"|"remove", "attributes": object }],
		"gold": [{ "player": string, "delta": number }],
		"conditions": [{ "player": string, "add": string[], "remove": string[] }],
		"abilities": [{ "player": string, "change_type": "add"|"remove", "name": string, "description": string, "attributes": object }]
	},
	"prompt": string,
	"roll": { "sides": number, "stats": string[], "mods": number, "dc": number } | null,
	"suggestions": string[],
	"spellUsed": boolean,
	"music": string | null,
	"sfx": string[]
}`;

/**
 * Extracts and parses the first JSON object from a raw LLM response string.
 *
 * Tolerant to common LLM formatting problems: markdown code fences, bare
 * newlines / tabs inside string values, and unescaped double-quotes.  When
 * `llmRepairOpts` is supplied the function can also ask the LLM to repair its
 * own malformed output before falling back to local heuristics.
 *
 * **5-stage parsing strategy**
 *
 * 1. **Standard parse** — strips code fences, slices out the first `{…}`
 *    block, then calls `JSON.parse` directly.
 * 2. **LLM repair, attempt 1** — if `llmRepairOpts` is present, sends the
 *    broken slice to the LLM with a structured repair prompt and tries
 *    `JSON.parse` on the reply.
 * 3. **LLM repair, attempt 2** — repeats the LLM repair request a second
 *    time, feeding back the still-broken reply so the model can see its own
 *    prior failure.
 * 4. **Newline / tab escape** — replaces literal `\n`, `\r`, and `\t`
 *    characters embedded inside string values with their JSON escape
 *    sequences and retries `JSON.parse`.
 * 5. **Quote repair** — walks the string character-by-character, tracking
 *    whether the parser is inside a JSON string, and escapes any `"`
 *    that is not already preceded by a backslash and is not the
 *    opening/closing delimiter of a key or value.
 *
 * If all five stages fail the function returns `null`.
 *
 * @async
 * @param {string} text - Raw text from the LLM that is expected to contain a
 *   JSON object somewhere within it (may include markdown code fences or
 *   surrounding prose).
 * @param {{ getLLMResponse: Function, llmOpts: object } | undefined} llmRepairOpts -
 *   Optional.  When provided, `getLLMResponse` is called with a repair prompt
 *   and `llmOpts` is forwarded as its second argument.  Omit (or pass
 *   `undefined`) to skip the LLM-repair stages entirely.
 * @returns {Promise<object|null>} The parsed DM response object, or `null` if
 *   no valid JSON could be extracted after all repair attempts.
 */
export async function parseDMJson(text, llmRepairOpts) {
	if (!text) return null;

	text = String(text).trim();

	// Strip code fences anywhere in the text (LLMs sometimes prefix/suffix them)
	text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

	const slice = text.startsWith('{')
		? text
		: (() => {
				const first = text.indexOf('{'), last = text.lastIndexOf('}');
				return first !== -1 && last !== -1 && last > first ? text.slice(first, last + 1) : null;
			})();

	if (!slice) return null;

	/**
	 * Unwraps a `{ role, content }` message envelope that the LLM occasionally
	 * echoes from conversation history instead of returning a plain JSON object.
	 * When the envelope is detected the `content` string is parsed and returned;
	 * otherwise `obj` is returned unchanged.
	 *
	 * @param {object} obj - Candidate parsed value to inspect.
	 * @returns {object} The inner parsed object if an envelope was detected,
	 *   otherwise the original `obj`.
	 */
	function unwrap(obj) {
		if (obj && typeof obj === "object" && !obj.text && typeof obj.content === "string") {
			try { return JSON.parse(obj.content); } catch {}
		}
		return obj;
	}

	// Attempt 1: standard parse
	try { return unwrap(JSON.parse(slice)); } catch (e1) {
		console.warn(`⚠️ parseDMJson attempt 1 (standard parse) failed: ${e1.message}`);
	}

	// Attempt 2-3: ask the LLM to fix its own malformed JSON (up to 2 tries)
	if (llmRepairOpts?.getLLMResponse && llmRepairOpts?.llmOpts) {
		let lastBadJson = slice;
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				console.warn(`🔧 parseDMJson: requesting LLM repair (attempt ${attempt}/2)...`);
				const repairReply = await llmRepairOpts.getLLMResponse([
					{
						role: "system",
						content: `You are a JSON repair assistant. The following JSON is malformed and cannot be parsed. Fix it so it is valid JSON conforming to this schema:\n\n${DM_JSON_SCHEMA}\n\nRules:\n- Return ONLY the repaired JSON object — no markdown, no code fences, no explanation.\n- Preserve all original content/values — only fix structural JSON issues (missing commas, unescaped quotes, trailing commas, unclosed braces, etc.).\n- Do NOT add or remove fields beyond what is already present.`,
					},
					{
						role: "user",
						content: lastBadJson,
					},
				], llmRepairOpts.llmOpts);

				const repairText = typeof repairReply === "string" ? repairReply.trim() : "";
				// Strip code fences the repair LLM might add
				const cleaned = repairText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
				const parsed = JSON.parse(cleaned);
				console.log(`✅ parseDMJson: LLM repair attempt ${attempt} succeeded`);
				return unwrap(parsed);
			} catch (err) {
				console.warn(`⚠️ parseDMJson LLM repair attempt ${attempt} failed: ${err.message}`);
				// On the second attempt, feed the latest (still broken) reply back
				// so the LLM can see its own prior repair attempt
			}
		}
	}

	// Attempt 4: escape bare newlines/tabs inside string values
	try {
		return unwrap(JSON.parse(slice.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')));
	} catch (e2) {
		console.warn(`⚠️ parseDMJson attempt (newline escape) failed: ${e2.message}`);
	}

	// Attempt 5: repair unescaped double-quotes inside JSON string values.
	// Strategy: walk the string character-by-character tracking whether we're inside
	// a JSON string, and escape any " that isn't already preceded by a backslash
	// and isn't the opening/closing quote of a key or value.
	try {
		let repaired = '';
		let inString = false;
		let escaped = false;
		for (let i = 0; i < slice.length; i++) {
			const ch = slice[i];
			if (escaped) {
				repaired += ch;
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				repaired += ch;
				continue;
			}
			if (ch === '"') {
				if (!inString) {
					inString = true;
					repaired += ch;
				} else {
					// Peek ahead: if the next non-whitespace char is :, ,, }, or ] this is a closing quote
					let j = i + 1;
					while (j < slice.length && (slice[j] === ' ' || slice[j] === '\t')) j++;
					const next = slice[j];
					if (next === ':' || next === ',' || next === '}' || next === ']') {
						inString = false;
						repaired += ch;
					} else {
						// Unescaped quote inside a string value — escape it
						repaired += '\\"';
					}
				}
				continue;
			}
			repaired += ch;
		}
		return unwrap(JSON.parse(repaired));
	} catch (e3) {
		console.warn(`⚠️ parseDMJson attempt (quote repair) failed: ${e3.message}`);
	}

	return null;
}
