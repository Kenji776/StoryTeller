/**
 * turnTimer.js
 * Extracts turn-timer infrastructure, missed-turn handling, timer expiry,
 * rest-vote resolution, and TPK detection from server.js.
 */

/**
 * Creates and returns the complete turn-timer subsystem for a lobby session.
 * Encapsulates all timer state and exposes helper functions for scheduling,
 * cancellation, expiry handling, and rest resolution.
 *
 * @param {Object} deps - Dependency injection bundle (io, store, room, log, LLM helpers, broadcast fns, etc.)
 * @returns {{ activeTimers: Map, pendingTimerStarts: Map, restVoteTimers: Map,
 *             scheduleTimerAfterNarration: Function, startTurnTimer: Function,
 *             cancelTurnTimer: Function, handleTimerExpiry: Function,
 *             kickPlayerForInactivity: Function, isPlayerConnected: Function,
 *             resolveActiveTurn: Function, checkAndEndIfAllDead: Function,
 *             handleRestResolved: Function, sendState: Function }} Timer system object
 */
export function createTimerSystem(deps) {
	const {
		io,
		store,
		room,
		log,
		devMode,
		ELEVEN_API_KEY,
		serviceStatus,
		LLM_TIMEOUT_MS,
		HISTORY_SUMMARIZE_THRESHOLD,
		MAX_SUMMARY_LENGTH,
		getLLMResponse,
		llmOpts,
		parseDMJson,
		streamNarrationToClients,
		broadcastXPUpdates,
		broadcastHPUpdates,
		broadcastInventoryUpdates,
		broadcastGoldUpdates,
		broadcastConditionUpdates,
		broadcastPartyState,
		updateMap,
		resolveSfx,
		broadcastLobbies,
	} = deps;

	// ── Module-level state ────────────────────────────────────────────────────
	const activeTimers = new Map();        // lobbyId → { timeout, playerName }
	const pendingTimerStarts = new Map();  // lobbyId → fallback timeout handle — waits for narration:done before starting turn timer
	const restVoteTimers = new Map();      // lobbyId → timeoutId

	// ── Internal constants ────────────────────────────────────────────────────
	const READING_DELAY_MS = 60_000; // grace period when TTS is off
	const hasTTS = () => !devMode && !!ELEVEN_API_KEY && serviceStatus.elevenlabs;

	/**
	 * Schedules the turn timer to begin after narration has finished playing on the client.
	 * When TTS is active, waits for a `narration:done` socket event with a 3-minute safety
	 * fallback. When TTS is disabled, applies a fixed reading-delay immediately.
	 *
	 * @param {string} lobbyId - The ID of the lobby whose turn timer should be scheduled.
	 * @returns {void}
	 */
	function scheduleTimerAfterNarration(lobbyId) {
		if (!hasTTS()) {
			startTurnTimer(lobbyId, READING_DELAY_MS);
			return;
		}
		// Clear any previous pending start for this lobby
		if (pendingTimerStarts.has(lobbyId)) {
			clearTimeout(pendingTimerStarts.get(lobbyId));
		}
		// Safety fallback: start timer after 3 minutes even if narration:done never arrives
		const fallback = setTimeout(() => {
			if (pendingTimerStarts.has(lobbyId)) {
				pendingTimerStarts.delete(lobbyId);
				startTurnTimer(lobbyId, 0);
			}
		}, 3 * 60 * 1000);
		pendingTimerStarts.set(lobbyId, fallback);
	}

	/**
	 * Returns whether the named player has at least one live socket connection in the lobby.
	 *
	 * @param {string} lobbyId - The lobby to check.
	 * @param {string} playerName - The player name to look up.
	 * @returns {boolean} `true` if the player has an active socket; `false` otherwise.
	 */
	function isPlayerConnected(lobbyId, playerName) {
		const s = store.index[lobbyId];
		if (!s) return false;
		return Object.entries(s.sockets).some(
			([sid, rec]) => rec.playerName === playerName && io.sockets.sockets.has(sid)
		);
	}

	/**
	 * Advances past any disconnected players in the turn order after a turn-order change.
	 * Emits a `toast` warning for each skipped player and removes them from the store.
	 *
	 * @param {string} lobbyId - The lobby whose turn order should be resolved.
	 * @returns {{ current: string|null, order: string[] }} The resolved current player and turn order.
	 */
	function resolveActiveTurn(lobbyId) {
		const s = store.index[lobbyId];
		if (!s || s.phase !== "running") return store.turnInfo(lobbyId);

		let { current, order } = store.turnInfo(lobbyId);
		let steps = 0;

		while (current && !isPlayerConnected(lobbyId, current) && steps < order.length) {
			log(`⚠️ ${current} has no active connection — removing from turn order`);
			io.to(room(lobbyId)).emit("toast", {
				type: "warning",
				message: `${current} is not in the game — skipping their turn.`,
			});
			store.removeFromTurnOrder(lobbyId, current);
			const info = store.turnInfo(lobbyId);
			current = info.current;
			order = info.order;
			steps++;
			if (!order.length) break;
		}

		return store.turnInfo(lobbyId);
	}

	/**
	 * Checks whether all players in the lobby are dead (TPK) and, if so, ends the game.
	 * Generates an LLM epilogue narrative, streams it via TTS, then emits `game:over`.
	 * Does nothing if at least one player is still alive.
	 *
	 * @param {string} lobbyId - The lobby to check and potentially end.
	 * @returns {Promise<void>}
	 */
	async function checkAndEndIfAllDead(lobbyId) {
		if (!store.checkAllDead(lobbyId)) return;

		store.setPhase(lobbyId, "wiped");
		cancelTurnTimer(lobbyId);
		log(`💀 All players dead in lobby ${lobbyId} — generating TPK epilogue...`);

		// Show lock overlay while the LLM generates the epilogue
		io.to(room(lobbyId)).emit("ui:lock", { actor: "DM", message: "The DM is writing the final chapter..." });

		// Generate a dramatic epilogue via the LLM
		try {
			const msgs = store.composeWipeEpilogue(lobbyId);
			const rawReply = await Promise.race([
				getLLMResponse(msgs, llmOpts(lobbyId)),
				new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)),
			]);
			const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
			let epilogueHtml = "";
			let music = "sad_moment";
			let sfx = [];

			if (replyText) {
				try {
					const parsed = JSON.parse(replyText.replace(/^```json?\s*|```$/g, "").trim());
					epilogueHtml = parsed.text || replyText;
					if (parsed.music) music = parsed.music;
					if (Array.isArray(parsed.sfx)) sfx = parsed.sfx;
				} catch {
					epilogueHtml = replyText;
				}
			}

			if (epilogueHtml) {
				store.appendDM(lobbyId, epilogueHtml);
				io.to(room(lobbyId)).emit("narration", { content: epilogueHtml });
				if (music) io.to(room(lobbyId)).emit("music:change", { mood: music });
				if (sfx.length) {
					const { resolveSFXFiles } = await import("../services/sfxResolver.js");
					resolveSFXFiles(sfx).then(sfxFiles => {
						if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
					}).catch(() => {});
				}
				await streamNarrationToClients(io, room(lobbyId), epilogueHtml, store.getNarratorVoice(lobbyId));
			}
		} catch (err) {
			log(`⚠️ TPK epilogue generation failed: ${err.message}`);
			// Fall through to emit game:over even if epilogue fails
		}

		io.to(room(lobbyId)).emit("ui:unlock");
		io.to(room(lobbyId)).emit("game:over", { reason: "wiped" });
		broadcastLobbies();
	}

	/**
	 * Starts (or restarts) the turn countdown timer for the current active player.
	 * Applies an optional reading delay before the real countdown begins, emitting
	 * `timer:pending` during the delay and `timer:start` when the clock is live.
	 * Cancels any existing timer for the lobby before setting up the new one.
	 *
	 * @param {string} lobbyId - The lobby for which to start the timer.
	 * @param {number} [readingDelayMs=0] - Optional delay in ms before the turn clock starts.
	 * @returns {void}
	 */
	function startTurnTimer(lobbyId, readingDelayMs = 0) {
		cancelTurnTimer(lobbyId);
		const s = store.index[lobbyId];
		if (!s || !s.timerEnabled || !s.timerMinutes || s.phase !== "running") return;

		const { current } = store.turnInfo(lobbyId);
		if (!current) return;

		if (readingDelayMs > 0) {
			log(`⏱ Timer pending for ${current} in lobby ${lobbyId} (${readingDelayMs / 1000}s reading delay)`);
			io.to(room(lobbyId)).emit("timer:pending", { player: current, readingDelayMs, ttsActive: hasTTS() });
			const delayTimeout = setTimeout(() => {
				activeTimers.delete(lobbyId);
				startTurnTimer(lobbyId, 0);
			}, readingDelayMs);
			activeTimers.set(lobbyId, { timeout: delayTimeout, playerName: current });
			return;
		}

		const durationMs = s.timerMinutes * 60 * 1000;
		const endsAt = Date.now() + durationMs;

		io.to(room(lobbyId)).emit("timer:start", { player: current, endsAt, durationMs });
		log(`⏱ Timer started for ${current} in lobby ${lobbyId} (${s.timerMinutes}m)`);

		const timeout = setTimeout(() => handleTimerExpiry(lobbyId, current), durationMs);
		activeTimers.set(lobbyId, { timeout, playerName: current });
	}

	/**
	 * Cancels the active turn timer (or pending reading-delay) for a lobby and emits `timer:cancel`.
	 * Does nothing if no timer is currently running.
	 *
	 * @param {string} lobbyId - The lobby whose timer should be cancelled.
	 * @returns {void}
	 */
	function cancelTurnTimer(lobbyId) {
		const entry = activeTimers.get(lobbyId);
		if (!entry) return;
		clearTimeout(entry.timeout);
		activeTimers.delete(lobbyId);
		io.to(room(lobbyId)).emit("timer:cancel");
	}

	/**
	 * Removes a player from the lobby due to inactivity, disconnects their socket,
	 * and broadcasts the updated party and turn state to all remaining players.
	 *
	 * @param {string} lobbyId - The lobby from which the player should be removed.
	 * @param {string} playerName - The name of the player to kick.
	 * @returns {Promise<void>}
	 */
	async function kickPlayerForInactivity(lobbyId, playerName) {
		const s = store.index[lobbyId];
		if (!s) return;

		log(`🚫 Kicking ${playerName} from lobby ${lobbyId} for inactivity`);

		const sid = store.sidByPlayerName(lobbyId, playerName);

		if (s.players[playerName]) s.players[playerName].disconnected = true;
		store.removeFromTurnOrder(lobbyId, playerName);

		// Remove from sockets before disconnecting so the disconnecting handler skips it
		if (sid) delete s.sockets[sid];
		store.persist(lobbyId);

		io.to(room(lobbyId)).emit("toast", { type: "error", message: `${playerName} was removed from the adventure due to inactivity.` });
		io.to(room(lobbyId)).emit("player:left", { player: playerName });
		const { current, order } = resolveActiveTurn(lobbyId);
		io.to(room(lobbyId)).emit("turn:update", { current, order });

		if (sid) {
			const sock = io.sockets.sockets.get(sid);
			if (sock) sock.disconnect(true);
		}

		sendState(lobbyId);
		broadcastPartyState(io, store, lobbyId);
		broadcastLobbies();
	}

	/**
	 * Handles a turn-timer expiry for a player who did not act in time.
	 * Increments their missed-turn count, kicks them if the threshold is reached,
	 * otherwise submits a skip action to the LLM, broadcasts all resulting updates,
	 * advances to the next turn, and schedules the next timer.
	 *
	 * @param {string} lobbyId - The lobby in which the timer expired.
	 * @param {string} playerName - The player whose turn timed out.
	 * @returns {Promise<void>}
	 */
	async function handleTimerExpiry(lobbyId, playerName) {
		activeTimers.delete(lobbyId);
		const s = store.index[lobbyId];
		if (!s || s.phase !== "running") return;

		// Guard: verify it's still their turn
		const { current } = store.turnInfo(lobbyId);
		if (current !== playerName) return;

		log(`⏰ Turn timeout for ${playerName} in lobby ${lobbyId}`);

		io.to(room(lobbyId)).emit("timer:cancel");
		io.to(room(lobbyId)).emit("toast", { type: "warning", message: `${playerName}'s turn was skipped due to timeout.` });

		// Track missed turns; kick if threshold reached
		const missed = store.incrementMissedTurns(lobbyId, playerName);
		if (missed >= (s.maxMissedTurns || 3)) {
			await kickPlayerForInactivity(lobbyId, playerName);
			startTurnTimer(lobbyId, hasTTS() ? 0 : READING_DELAY_MS);
			return;
		}

		const skipText = `${playerName} took no action and stared blankly into the distance`;
		store.appendUser(lobbyId, playerName, skipText);
		io.to(room(lobbyId)).emit("action:log", { player: playerName, text: skipText, timestamp: Date.now() });

		try {
			io.to(room(lobbyId)).emit("ui:lock", { actor: playerName });

			const msgs = store.composeMessages(lobbyId, playerName, skipText, null);
			const rawReply = await Promise.race([
				getLLMResponse(msgs, llmOpts(lobbyId)),
				new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)),
			]);

			const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
			if (replyText) {
				log(`📝 [LLM raw response] lobby=${lobbyId} (timer skip):\n${replyText.slice(0, 2000)}${replyText.length > 2000 ? "…(truncated)" : ""}`);
				const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
				log(`🔍 [DM parse] parsed=${!!dmObj}, text=${JSON.stringify((dmObj?.text || "").slice(0, 200))}`);
				const narrationText = (dmObj && typeof dmObj === "object") ? (dmObj.text || dmObj.prompt || replyText) : replyText;

				if (dmObj && typeof dmObj === "object") {
					const u = dmObj.updates || {};
					broadcastXPUpdates(io, store, lobbyId, u.xp);
					broadcastHPUpdates(io, store, lobbyId, u.hp);
					await checkAndEndIfAllDead(lobbyId);

					// If everyone is dead, the epilogue already played — bail out
					if (store.index[lobbyId]?.phase === "wiped") return;

					broadcastInventoryUpdates(io, store, lobbyId, u.inventory);
					broadcastGoldUpdates(io, store, lobbyId, u.gold);
					broadcastConditionUpdates(io, store, lobbyId, u.conditions);
					if (Array.isArray(u.enemies)) store.updateEnemies(lobbyId, u.enemies);
					if (dmObj.combat_over) store.purgeDeadEnemies(lobbyId);
					broadcastPartyState(io, store, lobbyId);
					updateMap(io, store, lobbyId, dmObj.characters || [], dmObj.terrain || null);
					if (Array.isArray(dmObj.suggestions) && dmObj.suggestions.length) {
						io.to(room(lobbyId)).emit("suggestions:update", { suggestions: dmObj.suggestions });
					}
					if (dmObj.music) {
						store.setCurrentMusic(lobbyId, dmObj.music);
						io.to(room(lobbyId)).emit("music:change", { mood: dmObj.music });
					}
					if (Array.isArray(dmObj.sfx) && dmObj.sfx.length) {
						resolveSfx(dmObj.sfx, ELEVEN_API_KEY).then(sfxFiles => {
							if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
						}).catch(err => log("⚠️ SFX resolve error:", err.message));
					}
				}

				store.appendDM(lobbyId, narrationText);
				io.to(room(lobbyId)).emit("narration", { content: narrationText });
				await streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId));
			}
		} catch (err) {
			log(`⏰ Timer expiry LLM error: ${err.message}`);
		}

		// Don't advance turns or unlock if game already ended
		if (store.index[lobbyId]?.phase === "wiped") return;

		store.nextTurn(lobbyId);
		const { current: next, order } = resolveActiveTurn(lobbyId);
		io.to(room(lobbyId)).emit("turn:update", { current: next, order });
		io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
		io.to(room(lobbyId)).emit("ui:unlock");
		scheduleTimerAfterNarration(lobbyId);

		// Keep story summary current after timer-expiry turns too
		if (store.needsSummarization(lobbyId, HISTORY_SUMMARIZE_THRESHOLD)) {
			store.autoSummarize(lobbyId, getLLMResponse, llmOpts(lobbyId), 10, MAX_SUMMARY_LENGTH).catch(() => {});
		}
	}

	/**
	 * Finalises a rest-vote result after all players have voted (or the vote timer expired).
	 * On a passing vote, applies mechanical rest effects, requests LLM narration, streams
	 * TTS audio, then advances the turn. On failure, unlocks the UI and notifies players.
	 *
	 * @param {string} lobbyId - The lobby in which the rest vote was held.
	 * @param {"passed"|"failed"} result - Outcome of the rest vote.
	 * @param {"short"|"long"} type - The type of rest that was voted on.
	 * @param {string} proposer - The player name who initiated the rest proposal.
	 * @returns {Promise<void>}
	 */
	async function handleRestResolved(lobbyId, result, type, proposer) {
		// Clear the 120s timeout if it's still pending
		if (restVoteTimers.has(lobbyId)) {
			clearTimeout(restVoteTimers.get(lobbyId));
			restVoteTimers.delete(lobbyId);
		}
		store.clearRestVote(lobbyId);
		io.to(room(lobbyId)).emit("rest:vote:result", { passed: result === "passed", type });

		if (result !== "passed") {
			io.to(room(lobbyId)).emit("ui:unlock");
			io.to(room(lobbyId)).emit("toast", { type: "warning", message: "Rest vote failed — take a different action." });
			return;
		}

		// Apply mechanical effects immediately so party table updates right away
		store.applyRest(lobbyId, type);
		broadcastPartyState(io, store, lobbyId);

		// Lock UI while waiting for LLM narration
		io.to(room(lobbyId)).emit("ui:lock", { actor: proposer });

		// Ask the LLM to narrate the rest
		const restText = type === "long"
			? "[LONG REST] The party settles in for a full 8-hour long rest. All HP is restored and conditions are cleared. Narrate what happens — it may be peaceful, or something may occur during the night."
			: "[SHORT REST] The party takes a short rest of 1–2 hours, tending wounds and catching their breath. Narrate the brief respite.";

		try {
			store.appendUser(lobbyId, proposer, restText);
			const msgs = store.composeMessages(lobbyId, proposer, restText, null);
			const rawReply = await Promise.race([
				getLLMResponse(msgs, llmOpts(lobbyId)),
				new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timeout")), LLM_TIMEOUT_MS)),
			]);
			const replyText = typeof rawReply === "string" ? rawReply.trim() : "";
			if (replyText) {
				log(`📝 [LLM raw response] lobby=${lobbyId} (kick):\n${replyText.slice(0, 2000)}${replyText.length > 2000 ? "…(truncated)" : ""}`);
				const dmObj = await parseDMJson(replyText, { getLLMResponse, llmOpts: llmOpts(lobbyId) });
				log(`🔍 [DM parse] parsed=${!!dmObj}, text=${JSON.stringify((dmObj?.text || "").slice(0, 200))}`);
				let narrationText;
				if (dmObj && typeof dmObj === "object") {
					narrationText = dmObj.text || dmObj.prompt || replyText;
				} else {
					try {
						const fallback = JSON.parse(replyText);
						narrationText = fallback?.text || fallback?.content || replyText;
						if (typeof narrationText !== "string") narrationText = replyText;
					} catch {
						narrationText = replyText;
					}
				}
				if (dmObj && typeof dmObj === "object") {
					const u = dmObj.updates || {};
					broadcastXPUpdates(io, store, lobbyId, u.xp);
					broadcastInventoryUpdates(io, store, lobbyId, u.inventory);
					broadcastGoldUpdates(io, store, lobbyId, u.gold);
					broadcastConditionUpdates(io, store, lobbyId, u.conditions);
					if (Array.isArray(u.enemies)) store.updateEnemies(lobbyId, u.enemies);
					if (dmObj.combat_over) store.purgeDeadEnemies(lobbyId);
					broadcastPartyState(io, store, lobbyId);
					updateMap(io, store, lobbyId, dmObj.characters || [], dmObj.terrain || null);
					if (Array.isArray(dmObj.suggestions) && dmObj.suggestions.length) {
						io.to(room(lobbyId)).emit("suggestions:update", { suggestions: dmObj.suggestions });
					}
					if (dmObj.music) {
						store.setCurrentMusic(lobbyId, dmObj.music);
						io.to(room(lobbyId)).emit("music:change", { mood: dmObj.music });
					}
					if (Array.isArray(dmObj.sfx) && dmObj.sfx.length) {
						resolveSfx(dmObj.sfx, ELEVEN_API_KEY).then(sfxFiles => {
							if (sfxFiles.length) io.to(room(lobbyId)).emit("sfx:play", { effects: sfxFiles });
						}).catch(err => log("⚠️ SFX resolve error:", err.message));
					}
				}
				store.appendDM(lobbyId, narrationText);
				io.to(room(lobbyId)).emit("narration", { content: narrationText });
				await streamNarrationToClients(io, room(lobbyId), narrationText, store.getNarratorVoice(lobbyId));
			}
		} catch (err) {
			log(`⚠️ Rest LLM error: ${err.message}`);
		}

		store.nextTurn(lobbyId);
		const { current, order } = resolveActiveTurn(lobbyId);
		io.to(room(lobbyId)).emit("turn:update", { current, order });
		io.to(room(lobbyId)).emit("state:update", store.publicState(lobbyId));
		io.to(room(lobbyId)).emit("ui:unlock");
		scheduleTimerAfterNarration(lobbyId);
	}

	/**
	 * Emits the current public lobby state to all clients in the room via `state:update`.
	 *
	 * @param {string} lobbyId - The lobby whose state should be broadcast.
	 * @returns {void}
	 */
	function sendState(lobbyId) {
		const state = store.publicState(lobbyId);
		io.to(room(lobbyId)).emit("state:update", state);
		log(`📤 State sent for lobby ${lobbyId} (${state?.phase})`);
	}

	return {
		activeTimers,
		pendingTimerStarts,
		restVoteTimers,
		scheduleTimerAfterNarration,
		startTurnTimer,
		cancelTurnTimer,
		handleTimerExpiry,
		kickPlayerForInactivity,
		isPlayerConnected,
		resolveActiveTurn,
		checkAndEndIfAllDead,
		handleRestResolved,
		sendState,
	};
}
