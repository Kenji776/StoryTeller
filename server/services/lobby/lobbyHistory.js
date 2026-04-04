/**
 * History, summarization, and pinned-moment methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 *
 * Every method receives `this` as the LobbyStore instance so it can
 * access this.index and this.persist().
 */

/**
 * Returns the current Unix timestamp in milliseconds.
 *
 * @returns {number} Current time as milliseconds since epoch.
 */
function now() { return Date.now(); }

export const MAX_PINS = 12;

export const historyMethods = {
	// ==== History / Story ====

	/**
	 * Returns the last `n` history entries for a lobby.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {number} n       - Number of tail entries to return.
	 * @returns {Array<object>} Slice of the history array, or an empty array if the lobby is not found.
	 */
	tail(lobbyId, n) {
		const s = this.index[lobbyId];
		return s ? s.history.slice(-n) : [];
	},
	/**
	 * Appends a player (user-role) message to the lobby history and updates last activity.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} name    - Display name of the player sending the message.
	 * @param {string} content - The message text.
	 * @returns {void}
	 */
	appendUser(lobbyId, name, content) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.history.push({ role: "user", name, content });
		s.lastActivity = now();
		this.persist(lobbyId);
	},
	/**
	 * Appends a DM (assistant-role) response to the lobby history.
	 * Also seeds `storyContext` with this content when no summary has been built yet.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} content - The DM response text.
	 * @returns {void}
	 */
	appendDM(lobbyId, content) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.history.push({ role: "assistant", content });
		// Only set storyContext if no summary exists yet — once autoSummarize
		// has built a proper summary we must not overwrite it with a single response.
		if (!s._hasSummary) s.storyContext = content;
		this.persist(lobbyId);
	},
	/**
	 * Overwrites the lobby's running summary text (admin/manual tooling).
	 * Sets the summarization bookmark to the current history length without deleting history.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} content - The new summary text to store in `storyContext`.
	 * @returns {void}
	 */
	summarize(lobbyId, content) {
		// Admin tooling: update the running summary without deleting history.
		const s = this.index[lobbyId];
		if (!s) return;
		s.storyContext = content;
		s._hasSummary = true;
		s.summarizedUpTo = s.history.length;
		this.persist(lobbyId);
	},

	/**
	 * Returns true when enough NEW (unsummarized) messages have accumulated.
	 * We never count already-summarized history — only messages after summarizedUpTo.
	 */
	needsSummarization(lobbyId, threshold) {
		const s = this.index[lobbyId];
		if (!s) return false;
		const unsummarized = s.history.length - (s.summarizedUpTo || 0);
		return unsummarized >= threshold;
	},

	// ── Pinned Moments ──

	/**
	 * Pins a history entry as a notable moment, storing a snippet for later reference.
	 * Enforces the MAX_PINS cap and rejects duplicate or out-of-range indices.
	 *
	 * @param {string} lobbyId      - The lobby identifier.
	 * @param {number} historyIndex - Zero-based index into `s.history` to pin.
	 * @param {string} who          - Username of the player requesting the pin.
	 * @returns {{ ok: boolean, reason?: string, remaining?: number }} Result object indicating success or failure reason.
	 */
	pinMoment(lobbyId, historyIndex, who) {
		const s = this.index[lobbyId];
		if (!s) return { ok: false, reason: "not_found" };
		if (historyIndex < 0 || historyIndex >= s.history.length) return { ok: false, reason: "invalid_index" };
		if (!s.pinnedMoments) s.pinnedMoments = [];
		if (s.pinnedMoments.some(p => p.index === historyIndex)) return { ok: false, reason: "already_pinned" };
		if (s.pinnedMoments.length >= MAX_PINS) return { ok: false, reason: "limit_reached" };
		const entry = s.history[historyIndex];
		s.pinnedMoments.push({
			index: historyIndex,
			pinnedBy: who,
			pinnedAt: new Date().toISOString(),
			speaker: entry.role === "assistant" ? "DM" : (entry.name || "Player"),
			snippet: (entry.content || "").slice(0, 300),
		});
		this.persist(lobbyId);
		return { ok: true, remaining: MAX_PINS - s.pinnedMoments.length };
	},
	/**
	 * Removes a pinned moment by its original history index.
	 *
	 * @param {string} lobbyId      - The lobby identifier.
	 * @param {number} historyIndex - Zero-based index of the pinned entry to remove.
	 * @returns {boolean} `true` if a pin was removed, `false` if not found.
	 */
	unpinMoment(lobbyId, historyIndex) {
		const s = this.index[lobbyId];
		if (!s || !s.pinnedMoments) return false;
		const before = s.pinnedMoments.length;
		s.pinnedMoments = s.pinnedMoments.filter(p => p.index !== historyIndex);
		if (s.pinnedMoments.length < before) { this.persist(lobbyId); return true; }
		return false;
	},

	/**
	 * Build a running summary of unsummarized history and advance the bookmark.
	 * NEVER deletes history — the full log is always preserved for story reading.
	 *
	 * Uses a two-tier system:
	 *   - storyContext ("recent arc"): detailed summary of recent events (~800 words)
	 *   - ancientHistory: heavily compressed backstory of everything before the recent arc
	 *
	 * When storyContext exceeds maxSummaryLen, its content is compressed into
	 * ancientHistory and storyContext resets to just the new batch.
	 *
	 * @param {Function} getLLMResponse  - the LLM call function
	 * @param {object}   llmOpts        - { provider, model }
	 * @param {number}   keep           - recent messages to leave unsummarized (sent verbatim to LLM)
	 * @param {number}   maxSummaryLen  - when storyContext exceeds this, promote to ancientHistory
	 */
	async autoSummarize(lobbyId, getLLMResponse, llmOpts, keep = 6, maxSummaryLen = 60000) {
		const s = this.index[lobbyId];
		if (!s) return;

		// Prevent concurrent summarizations
		if (s._summarizing) {
			console.log(`⏭️ [summarize] Lobby ${lobbyId} — already in progress, skipping`);
			return;
		}
		s._summarizing = true;

		// Migration for existing lobbies
		if (s.summarizedUpTo == null) s.summarizedUpTo = 0;
		if (s.ancientHistory == null) s.ancientHistory = "";
		if (s.pinnedMoments == null) s.pinnedMoments = [];

		// Snapshot: summarize from summarizedUpTo to (current length - keep)
		const snapshotLen = s.history.length;
		const summarizeEnd = Math.max(snapshotLen - keep, s.summarizedUpTo);
		const toSummarize = s.history.slice(s.summarizedUpTo, summarizeEnd);

		if (toSummarize.length === 0) {
			s._summarizing = false;
			return;
		}

		// Build a condensed transcript from the new unsummarized messages.
		// DM history entries may be stored as raw JSON — extract the narrative
		// text so the summarizer sees clean prose, not JSON boilerplate.
		const transcript = toSummarize.map((m, i) => {
			const speaker = m.role === "assistant" ? "DM" : (m.name || "Player");
			let text = m.content || "";
			if (m.role === "assistant" && text.startsWith("{")) {
				try { text = JSON.parse(text).text || text; } catch {}
			}
			if (text.length > 500) text = text.slice(0, 500) + "…";
			return `[${i + 1}] ${speaker}: ${text}`;
		}).join("\n");

		// Collect pinned moment text to protect from summarization loss
		const pinnedText = (s.pinnedMoments || []).map(p =>
			`[PINNED by ${p.pinnedBy}] ${p.speaker}: ${p.snippet}`
		).join("\n");

		const existingSummary = s.storyContext || "";
		const needsPromotion = existingSummary.length > maxSummaryLen;

		console.log(`📝 [summarize] Lobby ${lobbyId}: incorporating ${toSummarize.length} new messages (history: ${snapshotLen}, bookmark: ${s.summarizedUpTo})${needsPromotion ? " [PROMOTING storyContext → ancientHistory]" : ""}`);

		try {
			// ── STEP 1: If storyContext is too long, compress it into ancientHistory ──
			if (needsPromotion) {
				const archiveReply = await getLLMResponse([
					{
						role: "system",
						content: `You are a campaign chronicler. Compress the following detailed summary into a SHORT backstory overview (~300 words). Keep ONLY: major plot beats, key NPCs and their fates, important decisions, and unresolved mysteries. Drop all combat details, routine events, and atmospheric description.

CRITICAL: Any lines below marked [PINNED] were flagged by players as important. These MUST appear in your output as near-verbatim bullet points — do not paraphrase, merge, or omit them. They are the most important facts in the entire summary.

Return ONLY the compressed text — no JSON, no fences.`,
					},
					{
						role: "user",
						content: `${s.ancientHistory ? "Existing backstory:\n" + s.ancientHistory + "\n\n" : ""}Summary to compress:\n${existingSummary}${pinnedText ? "\n\nPINNED MOMENTS (must preserve):\n" + pinnedText : ""}`,
					},
				], llmOpts);

				const archived = typeof archiveReply === "string" ? archiveReply.trim() : "";
				if (archived && !archived.startsWith("[Error")) {
					s.ancientHistory = archived;
					s.storyContext = ""; // reset — will be rebuilt below
					console.log(`   📜 ancientHistory updated (${archived.length} chars)`);
				}
			}

			// ── STEP 2: Merge new events into storyContext (the "recent arc") ──
			const currentSummary = s.storyContext || "";
			const reply = await getLLMResponse([
				{
					role: "system",
					content: `You are a campaign chronicler for a D&D game. Your job is to maintain a structured, running summary of RECENT events that a DM can use to stay consistent. Merge the previous summary with the new events into the format below (max 800 words / ~1000 tokens). Return ONLY the summary — no JSON, no markdown fences.${pinnedText ? "\n\nIMPORTANT — these moments were flagged by players as significant. Ensure they appear in the summary:\n" + pinnedText : ""}

FORMAT:
CURRENT GOAL: [One or two sentences: what the party is currently trying to accomplish and why]

SETTING: [Current location, environment, time of day, and any notable atmospheric details]

KEY CHARACTERS:
- [Name] — [Role/relationship to party, disposition, last known status, notable traits or abilities]
(Include ALL named NPCs, allies, enemies, and creatures encountered. For each, note whether they are: allied, neutral, hostile, dead, or unknown. Remove only those confirmed dead AND no longer plot-relevant.)

PARTY STATUS:
- [Brief note per player character: current situation, any ongoing personal arcs or promises they've made]

STORY SO FAR:
- [Bullet point per major plot beat, decision, or revelation — chronological order]
- [Keep bullets concise but complete: who did what, where, why, and the consequence]
- [Preserve unresolved hooks, promises, threats, and mysteries]
- [Include important dialogue, bargains, alliances, and betrayals]
- [Drop routine combat rounds, dice results, and mechanical details]
- [Always include the most recent events — never truncate the end]
- [As the story grows, compress older events into fewer bullets but never delete them entirely]

OPEN THREADS:
- [Unresolved plot hooks, unanswered questions, pending threats]
- [Promises or deals the party has made]
- [Known enemies still at large]
- [Items, locations, or mysteries yet to be explored]`,
				},
				{
					role: "user",
					content: `Previous summary:\n${currentSummary || "(Starting fresh — older events are in the backstory.)"}\n\nNew events to incorporate:\n${transcript}`,
				},
			], llmOpts);

			const summary = typeof reply === "string" ? reply.trim() : "";
			if (!summary || summary.startsWith("[Error")) {
				console.warn(`⚠️ [summarize] LLM returned empty/error — history untouched`);
				return;
			}

			// Advance the bookmark — history is NEVER deleted
			s.summarizedUpTo = summarizeEnd;
			s.storyContext = summary;
			s._hasSummary = true;
			this.persist(lobbyId);

			console.log(`✅ [summarize] Lobby ${lobbyId} complete:`);
			console.log(`   - Summarized up to message ${summarizeEnd} of ${s.history.length}`);
			console.log(`   - storyContext: ${summary.length} chars | ancientHistory: ${(s.ancientHistory || "").length} chars`);
		} catch (err) {
			console.warn(`⚠️ [summarize] Failed for lobby ${lobbyId}: ${err.message} — history untouched`);
		} finally {
			s._summarizing = false;
		}
	},
};
