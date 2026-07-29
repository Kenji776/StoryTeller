// === CONNECTION STATUS BANNER ===
// The client previously had no disconnect handling of any kind, so a player whose
// connection dropped saw a completely normal-looking UI that had simply stopped
// updating. This banner exists so that failure is never silent.

const CONNECTION_STATES = {
	online:       { text: "",                                  bg: "",         show: false },
	reconnecting: { text: "⚠️ Connection lost — reconnecting…", bg: "#8a6d1f", show: true },
	offline:      { text: "🔌 Disconnected — reconnecting…",    bg: "#8a2f2f", show: true },
	failed:       { text: "❌ Cannot reach the server. Reload the page to rejoin.", bg: "#8a2f2f", show: true },
	resyncing:    { text: "🔁 Catching up…",                    bg: "#2f5d8a", show: true },
	degraded:     { text: "⚠️ Out of sync — reload if things look wrong.", bg: "#8a6d1f", show: true },
};

/**
 * Shows or hides the connection banner.
 *
 * @description Renders into a lazily-created fixed banner so no markup change is
 *   needed in index.html. Called from the Socket.IO lifecycle handlers; `online`
 *   hides the banner rather than showing a reassuring message, because a permanent
 *   "connected" badge trains players to ignore the strip entirely.
 * @param {"online"|"reconnecting"|"offline"|"failed"} state - The connection state.
 * @param {string} [detail] - Optional diagnostic appended in smaller text.
 * @returns {void}
 */
function setConnectionStatus(state, detail) {
	const spec = CONNECTION_STATES[state] || CONNECTION_STATES.offline;

	let el = document.getElementById("connectionBanner");
	if (!el) {
		el = document.createElement("div");
		el.id = "connectionBanner";
		el.style.cssText = [
			"position:fixed", "top:0", "left:0", "width:100%", "z-index:10000",
			"padding:0.5em 1em", "text-align:center", "font-weight:600",
			"color:#fff", "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
			"transition:opacity 0.2s", "pointer-events:none",
		].join(";");
		document.body.appendChild(el);
	}

	if (!spec.show) {
		el.style.display = "none";
		return;
	}

	el.style.display = "block";
	el.style.background = spec.bg;
	el.innerHTML = detail
		? `${spec.text} <span style="opacity:0.7;font-weight:400;font-size:0.85em;">(${detail})</span>`
		: spec.text;
}

/**
 * Shows why an action was refused and how many chances are left.
 *
 * @description Rendered as a dismissible notice rather than a toast: a player whose
 *   idea was just refused needs to read the reason while they rewrite it, and a
 *   toast would vanish mid-thought. The pips make the cost concrete — three
 *   rejections forfeit the turn, and a player who cannot see that coming will feel
 *   ambushed by the skip.
 * @param {string} reason - Player-facing explanation from the server.
 * @param {number} [strikes] - Chances used so far.
 * @param {number} [maxStrikes] - Chances allowed.
 * @param {boolean} [retry] - Whether another attempt is still permitted.
 * @returns {void}
 */
function showRejectionNotice(reason, strikes, maxStrikes, retry) {
	let el = document.getElementById("rejectionNotice");
	if (!el) {
		el = document.createElement("div");
		el.id = "rejectionNotice";
		el.style.cssText = [
			"margin:0.5em 0", "padding:0.7em 0.9em", "border-radius:6px",
			"background:rgba(138,47,47,0.16)", "border-left:3px solid #c95c5c",
			"color:#f3d6d6", "font-size:0.95em",
		].join(";");
		const anchor = document.getElementById("actionInput")?.parentElement;
		anchor ? anchor.prepend(el) : document.body.appendChild(el);
	}

	const pips = Number.isFinite(strikes) && Number.isFinite(maxStrikes)
		? Array.from({ length: maxStrikes }, (_, i) => (i < strikes ? "●" : "○")).join(" ")
		: "";

	el.innerHTML = `
		<div style="display:flex;justify-content:space-between;gap:1em;align-items:baseline;">
			<strong>That won't work</strong>
			${pips ? `<span title="${strikes} of ${maxStrikes} chances used" style="letter-spacing:2px;opacity:0.85;">${pips}</span>` : ""}
		</div>
		<div style="margin-top:0.35em;">${reason || "Your character cannot do that."}</div>
		<div style="margin-top:0.35em;opacity:0.8;font-size:0.9em;">${
			retry === false
				? "You are out of chances this turn."
				: "Edit your action and try again — or press <em>What can I do?</em> for ideas."
		}</div>`;
	el.style.display = "block";
}

/**
 * @description Hides the rejection notice once the player moves on.
 * @returns {void}
 */
function clearRejectionNotice() {
	const el = document.getElementById("rejectionNotice");
	if (el) el.style.display = "none";
}

/**
 * Renders the advisor's suggestions as clickable cards.
 *
 * @description Clicking a card writes its sentence into the action input rather than
 *   submitting it, so the player stays the author — they can edit it, and they see
 *   what a workable action looks like. That is the difference between a tool that
 *   teaches and one that plays for you.
 * @param {Array<object>} options - Suggestions from the server, already filtered.
 * @param {string} note - Optional extra context.
 * @param {object} capability - The player's headline numbers.
 * @returns {void}
 */
function renderAdvisorOptions(options, note, capability) {
	const panel = document.getElementById("advisorPanel");
	if (!panel) return;
	panel.style.display = "block";

	const risk = { low: "#5c9c5c", medium: "#b8912f", high: "#c95c5c" };
	const head = capability
		? `<div style="opacity:0.8;font-size:0.85em;margin-bottom:0.6em;">
				HP ${capability.hp ?? "?"}/${capability.maxHp ?? "?"} ·
				${capability.slotsUnlimited ? "unlimited" : `${capability.slotsRemaining ?? 0} of ${capability.slotsMax ?? 0}`} ability uses left
				${capability.conditions?.length ? ` · ${capability.conditions.join(", ")}` : ""}
				${capability.isMyTurn ? "" : " · not your turn yet"}
			</div>`
		: "";

	if (!options?.length) {
		panel.innerHTML = `${head}<div style="opacity:0.85;">${note || "No suggestions right now."}</div>`;
		return;
	}

	panel.innerHTML = head + options.map((o, i) => `
		<button class="advisor-option" data-action="${String(o.action).replace(/"/g, "&quot;")}"
			style="display:block;width:100%;text-align:left;margin-bottom:0.5em;padding:0.6em 0.75em;
			       border-radius:6px;border:1px solid rgba(255,255,255,0.12);
			       border-left:3px solid ${risk[o.risk] || "#777"};background:rgba(255,255,255,0.04);
			       color:inherit;cursor:pointer;">
			<div style="font-weight:600;">${i + 1}. ${o.title}</div>
			<div style="opacity:0.9;margin-top:0.2em;">"${o.action}"</div>
			<div style="opacity:0.7;font-size:0.85em;margin-top:0.25em;">
				costs: ${o.cost}${o.check ? ` · ${o.check.plain}` : ""}
			</div>
			<div style="opacity:0.65;font-size:0.85em;font-style:italic;margin-top:0.2em;">${o.why}</div>
		</button>`).join("")
		+ (note ? `<div style="opacity:0.75;font-size:0.9em;margin-top:0.4em;">${note}</div>` : "");

	panel.querySelectorAll(".advisor-option").forEach((btn) => {
		btn.addEventListener("click", () => {
			const input = document.getElementById("actionInput");
			if (!input) return;
			input.value = btn.dataset.action;
			input.focus();
			panel.style.display = "none";
		});
	});
}

// === SEQUENCE TRACKING AND GAP RECOVERY ===
// Every state-bearing broadcast now arrives with a third argument:
//   { lid, seq, epoch, ts }
// Holding a watermark lets this client notice it missed something — the failure
// that was previously invisible — and ask for exactly the events it lacks.

let syncSeq = 0;      // highest sequence applied
let syncEpoch = 0;    // which server process those numbers belong to
let _resyncTimer = null;
let _resyncInFlight = false;

/**
 * Requests whatever this client missed, debounced.
 *
 * @description Debounced because a burst of missed events should produce one
 *   request, not one per event. The server answers through an acknowledgement
 *   callback rather than an event, so replayed events never pass back through the
 *   gap detector that asked for them.
 * @param {string} why - Diagnostic reason, logged only.
 * @returns {void}
 */
function scheduleResync(why) {
	if (_resyncTimer || _resyncInFlight || !lobbyId) return;
	_resyncTimer = setTimeout(() => {
		_resyncTimer = null;
		_resyncInFlight = true;
		setConnectionStatus("resyncing");
		console.warn(`🔁 Resyncing (${why}) from seq ${syncSeq}`);

		socket.emit("sync:request", { lobbyId, haveSeq: syncSeq, haveEpoch: syncEpoch }, (res) => {
			_resyncInFlight = false;
			if (!res || res.mode === "denied") {
				console.error("❌ Resync denied:", res?.reason);
				setConnectionStatus("degraded");
				return;
			}

			if (res.mode === "snapshot") {
				syncEpoch = res.epoch;
				syncSeq = res.seq;
				console.log(`📦 Resynced by snapshot at seq ${res.seq}`);
				if (typeof renderState === "function" && res.state) {
					currentState = res.state;
					renderState(res.state);
					renderLogs(res.state);
				}
			} else {
				console.log(`⏪ Replaying ${res.events.length} missed event(s)`);
				applyReplay(res.events);
				syncEpoch = res.epoch;
			}
			setConnectionStatus("online");
		});
	}, 150);
}

/**
 * Re-runs missed events through their normal handlers.
 *
 * @description Dispatches to the already-registered listeners directly rather than
 *   re-emitting, so a replayed event cannot re-enter `onAny` and be mistaken for
 *   another gap. Safe to re-apply because every replayable event carries its
 *   absolute post-value — `hp:update` sends `hp`, not a delta — so applying one
 *   twice lands on the same number.
 * @param {Array<{name: string, payload: object, meta: object}>} events - Missed events.
 * @returns {void}
 */
function applyReplay(events) {
	for (const e of events || []) {
		try {
			for (const fn of socket.listeners(e.name)) fn(e.payload, { ...e.meta, replay: true });
			if (e.meta?.seq > syncSeq) syncSeq = e.meta.seq;
		} catch (err) {
			console.warn(`⚠️ Replay of ${e.name} failed:`, err.message);
		}
	}
}

/**
 * Watches every inbound frame for a break in the sequence.
 *
 * @description Registered before the named handlers so the watermark is current by
 *   the time one runs. A gapped event is still applied — it is genuinely newer than
 *   what we hold — and the replay that lands a moment later fills in what came
 *   between.
 * @returns {void}
 */
function installGapDetection() {
	socket.onAny((event, payload, meta) => {
		if (!meta || typeof meta.seq !== "number") return;   // ephemeral or targeted
		if (meta.lid && lobbyId && meta.lid !== lobbyId) return;
		if (meta.replay) return;

		if (syncEpoch && meta.epoch !== syncEpoch) return scheduleResync("server restarted");
		if (!syncEpoch) syncEpoch = meta.epoch;

		if (meta.seq <= syncSeq) return;                     // already seen
		if (meta.seq === syncSeq + 1) { syncSeq = meta.seq; return; }

		const missed = meta.seq - syncSeq - 1;
		syncSeq = meta.seq;
		scheduleResync(`missed ${missed} event(s)`);
	});
}

function registerSocketEvents() {
	installGapDetection();

	socket.on("debug:setup", ({ raw, parsedMusic, parsedSuggestions }) => {
		console.group("🔍 [DEBUG] Setup LLM Response");
		console.log("Raw response:", raw);
		console.log("Parsed music:", parsedMusic);
		console.log("Parsed suggestions:", parsedSuggestions);
		console.groupEnd();
	});

	socket.on("game:ready", () => {
		console.log("✅ Game setup complete, hiding loading screen");
		hideLoading();
	});

	socket.on("lobby:created", ({ lobbyId: id, code }) => {
		lobbyId = id;
		lobbyCode = code;
		iAmHost = true;
		show(els.lobby);
	});

	socket.on("game:starting", ({ message }) => {
		console.log("Game starting event received");
		showLoading(message || "🌙 The Fates are Weaving Your Tale...");
	});

	socket.on("game:failed", ({ message }) => {
		console.error("[Game Start Failed]", message);
		hideLoading();
		show(els.lobby);
		appendLog(`[ERROR] ${message}`);
	});

	socket.on("lobby:joined", ({ lobbyId: id, code }) => {
		lobbyId = id;
		lobbyCode = code;
		iAmHost = false;

		// ✅ Show the lobby UI
		show(els.lobby);

		// ✅ Display lobby code in the header
		if (els.lobbyCode) els.lobbyCode.textContent = `#${code}`;

		// ✅ Request state update from server (to populate players)
		socket.emit("state:request", { lobbyId });
	});

	// === Socket events ===
	socket.on("state:update", (state) => {
		currentState = state;

		// Keep music manager aware of the current campaign world
		window.musicManager?.setWorldType(state.campaignSetting);

		if (state.party && state.party.length) {
			drawPartyComponent("partyContainer", state.party);
		}
		drawEnemyRoster("enemyRoster", state.enemies || []);

		// Always render base info
		renderState(state);

		// ✅ Always render logs (even if rejoining)
		renderLogs(state);

		if (state.phase === "running") {
			// If the game just started (no DM narration yet), ensure the loading
			// overlay is visible for all players — this covers cases where
			// game:starting was missed (e.g. a brief disconnect / race condition).
			if (!state.history || state.history.length === 0) {
				showLoading("The Dungeon Master is preparing your tale...");
			}
			enterGameMode();
			updateGameUI(state);

			// Resume music for players who joined or reconnected mid-game
			if (state.currentMusic && window.musicManager) {
				console.log(`🎵 state:update has currentMusic="${state.currentMusic}" — requesting mood`);
				window.musicManager.requestMood(state.currentMusic);
			} else if (!state.currentMusic) {
				console.log("🎵 state:update has no currentMusic");
			}
		} else {
			show(els.lobby);
		}
	});

	socket.on("action:log", ({ player, text }) => {
		const log = document.getElementById("storyLog");
		if (!log) return;
		const entry = document.createElement("div");
		entry.innerHTML = `<strong>${player}:</strong> ${text}`;
		log.appendChild(entry);
		log.scrollTop = log.scrollHeight;
	});

	socket.on("adventure:name", ({ name }) => {
		const titleEl = document.getElementById("adventureTitle");
		if (titleEl) titleEl.textContent = name || "Adventure";
		if (currentState) currentState.adventureName = name;
	});

	socket.on("turn:update", ({ current, order }) => {
		console.log(`[socket] turn:update received — current: ${current}, order: [${(order || []).join(", ")}]`);
		els.turnBanner.textContent = `Turn: ${current || "—"}`;
		setActionInputForTurn(current || null);
	});

	socket.on("party:update", ({ members, hostPlayer }) => {
		console.log("🧙 Party update received:", members);
		drawPartyComponent("partyContainer", members, false, hostPlayer);
	});

	socket.on("lobby:needsPassword", ({ code }) => {
		if (els.joinCode) els.joinCode.value = code;
		const modal = document.getElementById("passwordModal");
		const input = document.getElementById("lobbyPasswordInput");
		if (modal) { modal.style.display = "flex"; input?.focus(); }
	});

	socket.on("player:kicked", ({ reason }) => {
		alert(`You have been removed from the lobby.\n${reason || ""}`);
		lobbyId = null;
		lobbyCode = null;
		iAmHost = false;
		show(els.landing);
	});

	socket.on("player:joined", ({ player }) => {
		showToast(`${player} has joined the adventure!`, "info");
		appendActionLog(`⚔️ <strong>${player}</strong> joined the adventure!`, "system");
	});

	socket.on("player:left", ({ player }) => {
		showToast(`${player} has left the adventure.`, "warning");
		appendActionLog(`🚪 <strong>${player}</strong> disconnected.`, "system");
	});

	// Track whether the local player is dead so game:over can upgrade the modal
	let _myPlayerDead = false;

	socket.on("player:death", ({ player, message }) => {
		appendLog(`💀 ${message}`);

		// Stop any in-progress narration so the death event lands cleanly
		if (typeof stopNarration === "function") stopNarration();

		if (me.name === player) {
			_myPlayerDead = true;
			document.getElementById("actionInput").disabled = true;
			document.getElementById("actionButton").disabled = true;
			appendLog("☠️ You are dead and can no longer act.");

			// Show individual death modal immediately — if a TPK game:over follows,
			// showDeathModal("wipe") will seamlessly upgrade it in place.
			showDeathModal("death");
			const storyLog = document.getElementById("storyLog");
			if (storyLog) {
				const entries = storyLog.querySelectorAll(".dm-narration");
				const recent = Array.from(entries).slice(-3);
				recent.forEach(el => appendDeathNarration(el.innerHTML));
			}
		}
	});

	socket.on("dice:result", (r) => {
		const msg = `🎲 ${r.player || "Someone"} rolled ${r.kind} → ${r.value}` + (r.detail ? ` (base ${r.detail.base}, bonus ${r.detail.bonus})` : "");

		appendActionLog(msg, "dice-event");
		if (els.rollFeed) {
			const el = document.createElement("div");
			el.textContent = msg;
			el.classList.add("fade");
			els.rollFeed.prepend(el);
		}
	});

	socket.on("action:rejected", ({ reason, strikes, maxStrikes, retry }) => {
		appendLog(`[REJECTED] ${reason}\n`);
		window.UISounds?.deny();

		// Give the player their sentence back. handleSendAction clears the input the
		// moment it sends, so without this a rejection costs them the wording as well
		// as one of their three chances — and retyping it is exactly the friction a
		// first-time player does not need.
		if (window._lastSubmittedAction && els.actionInput && !els.actionInput.value.trim()) {
			els.actionInput.value = window._lastSubmittedAction;
			els.actionInput.focus();
			els.actionInput.select?.();
		}

		showRejectionNotice(reason, strikes, maxStrikes, retry);
	});

	socket.on("abilities:update", ({ player, change, name, description, abilities }) => {
		const gained = change !== "remove";
		appendActionLog(
			gained
				? `✨ <strong>${player}</strong> gained <em>${name}</em>${description ? ` — ${description}` : ""}`
				: `💨 <strong>${player}</strong> lost <em>${name}</em>`,
			"levelup-event",
		);

		if (me.name !== player) return;
		showToast(gained ? `You gained ${name}!` : `You lost ${name}.`, gained ? "success" : "warning");

		if (currentState?.players?.[player]) currentState.players[player].abilities = abilities;
		const container = document.getElementById("gameAbilitiesContainer");
		if (container && typeof drawAbilitiesComponent === "function") {
			drawAbilitiesComponent("gameAbilitiesContainer", abilities || [], false, true);
		}
	});

	socket.on("advisor:reply", ({ options, note, capability }) => {
		renderAdvisorOptions(options, note, capability);
	});

	socket.on("turn:skipped", ({ player, reason }) => {
		appendActionLog(`⏭️ <strong>${player}</strong>'s turn was skipped — ${reason}.`, "system");
		if (me.name === player) showToast(`Your turn was skipped — ${reason}.`, "warning", 6000);
	});

	// ── Illustrations ────────────────────────────────────────────────────────
	// The placeholder arrives first and is replaced in place when the image is
	// ready. Generation takes seconds, so the alternative is either a story beat
	// that stalls or a picture that appears from nowhere long after the moment.

	socket.on("illustration:pending", ({ id, caption, expected }) => {
		const log = document.getElementById("storyLog");
		if (!log || !id) return;

		const frame = document.createElement("div");
		frame.className = "illustration is-pending";
		frame.id = `illustration-${id}`;

		const slots = document.createElement("div");
		slots.className = "illustration-slots";
		for (let i = 0; i < Math.max(1, Number(expected) || 1); i += 1) {
			const slot = document.createElement("div");
			slot.className = "illustration-slot";
			slots.appendChild(slot);
		}
		frame.appendChild(slots);

		const label = document.createElement("div");
		label.className = "illustration-caption";
		label.textContent = caption ? `Illustrating: ${caption}` : "Illustrating this moment\u2026";
		frame.appendChild(label);

		log.appendChild(frame);
		log.scrollTop = log.scrollHeight;
	});

	socket.on("illustration:ready", ({ id, caption, images }) => {
		const frame = document.getElementById(`illustration-${id}`);
		if (!frame) return;

		frame.className = "illustration is-ready";
		frame.replaceChildren();

		const slots = document.createElement("div");
		slots.className = "illustration-slots";
		for (const image of images ?? []) {
			const img = document.createElement("img");
			img.className = "illustration-image";
			img.src = image.url;
			img.alt = image.name ? `${image.name} \u2014 ${caption ?? ""}` : (caption ?? "Scene illustration");
			img.loading = "lazy";
			slots.appendChild(img);
		}
		frame.appendChild(slots);

		if (caption) {
			const label = document.createElement("div");
			label.className = "illustration-caption";
			label.textContent = caption;
			frame.appendChild(label);
		}

		const log = document.getElementById("storyLog");
		if (log) log.scrollTop = log.scrollHeight;
	});

	socket.on("illustration:failed", ({ id, error }) => {
		const frame = document.getElementById(`illustration-${id}`);
		if (!frame) return;

		// Resolved to something, always. A placeholder left spinning is worse than
		// an honest line saying it did not work.
		frame.className = "illustration is-failed";
		frame.replaceChildren();
		const label = document.createElement("div");
		label.className = "illustration-caption";
		label.textContent = error ? `The illustration could not be drawn: ${error}` : "The illustration could not be drawn.";
		frame.appendChild(label);
	});

	// The server's verdict on whether this lobby can start. It arrives unprompted
	// when the host supplies a key, and on request when the settings window opens.
	socket.on("ai:state", (state) => {
		applyAiState(state);
	});

	// A model call failed mid-game for a reason the host can act on -- a missing,
	// rejected, expired or exhausted key. ADR 0009: this is not narration.
	socket.on("ai:unavailable", ({ message }) => {
		showToast(message, "error");
		if (lobbyId) socket.emit("ai:state:request", { lobbyId });
	});

	socket.on("toast", ({ type, message }) => {
		showToast(message, type);
	});

	// Handle streamed audio — route to the channel that owns this streamId
	socket.on("narration:audio", ({ data, streamId }) => {
		try {
			const chunk = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
			appendAudioChunk(streamId, chunk);
		} catch (err) {
			console.warn("⚠️ narration:audio skipped bad chunk:", err.message);
		}
	});

	socket.on("narration:audio:end", ({ streamId }) => {
		try {
			finalizeAudioStream(streamId);
		} catch (err) {
			console.warn("⚠️ narration:audio:end error — signalling done:", err.message);
			document.dispatchEvent(new CustomEvent("narration:playback:ended"));
		}
	});

	socket.on("debug:llm", (data) => {
		console.group("🧠 LLM Response Debug");
		console.log("Raw LLM response:", data.raw);
		console.log("Parsed object:", data.parsed);
		console.log("Final narration text:", data.narrationText);
		console.groupEnd();
	});

	// What another player is attempting. Their words never used to reach the table:
	// the only carrier was the TTS lifecycle, which sends the speaker and the audio
	// but not the text, so everyone else saw the DM react to something they had not
	// been shown. With audio off there was no trace of it at all.
	// A rules answer, for the asker alone. Deliberately not appended as story: the
	// previous behaviour published it to the whole table as DM narration.
	socket.on("ooc:reply", ({ question, answer }) => {
		if (typeof answer !== "string" || !answer.trim()) return;
		appendLog(`[rules] ${question ? `${question}\n` : ""}${answer.trim()}\n\n`);
	});

	socket.on("player:action", ({ player, text }) => {
		if (typeof text !== "string" || !text.trim()) return;
		appendLog(`${player || "Someone"}: ${text.trim()}\n\n`);
	});

	socket.on("narration", ({ content, status }) => {
		let narrationContent = (content || "").trim();
		if (narrationContent.startsWith('{')) {
			try {
				const parsed = JSON.parse(narrationContent);
				// Extract text or prompt from accidental raw JSON narration
				const extracted = parsed.text || parsed.prompt;
				if (typeof extracted === "string" && extracted) narrationContent = extracted;
			} catch {}
		}
		// Wrap each word in a <span> so the audio highlight system can target them
		const wrapped = typeof wrapNarrationWords === "function"
			? wrapNarrationWords(narrationContent)
			: narrationContent;
		appendLog("DM: " + wrapped + "\n\n");

		// Store the just-appended div so tts.js can find it for highlighting
		const storyLog = document.getElementById("storyLog");
		if (storyLog) window._activeNarrationDiv = storyLog.lastElementChild;

		if (!(content && content.trim().length > 0) || status === 204) {
			showNarratorIndicator(false);
		}
	});

	// Word-level alignment data for synchronized narration highlighting
	socket.on("narration:alignment", ({ streamId, words }) => {
		if (typeof setAlignmentData === "function") {
			setAlignmentData(streamId, words);
		}
	});

	socket.on("narration:start", ({ speaker, streamId, status, format }) => {
		// 🧩 Handle dev mode or no-audio condition gracefully
		if (status === 204 || localStorage.getItem("narrationEnabled") === "false") {
			showNarratorIndicator(false);
			// Signal done immediately so the server can start the turn timer
			document.dispatchEvent(new CustomEvent("narration:playback:ended"));
			return;
		}

		startNarration(speaker, streamId, format);
	});

	// === LEVEL UP EVENT HANDLING (client-side) ===
	socket.on("player:levelup", ({ newLevel, upcomingAbility, spellChoices }) => {
		// Update visible level field
		els.level.value = newLevel;
		appendActionLog(`🎉 <strong>${me.name}</strong> reached level ${newLevel}!`, "levelup-event");
		window.sfxManager?.play([{ file: "level_up_fanfare_mnf6yijp6b51.mp3", name: "Level up" }]);

		// Build the new ability preview block
		const abilityPreviewHTML = upcomingAbility
			? `<div style="margin:0.75em 0;padding:0.6em 0.8em;background:rgba(255,215,0,0.07);border-left:3px solid #ffd166;border-radius:4px;">
					<strong>✨ New ability: ${upcomingAbility.name}</strong><br>
					<span style="font-size:0.9em;opacity:0.85;">${upcomingAbility.description}</span>
					${upcomingAbility.details && Object.keys(upcomingAbility.details).length
						? `<div style="margin-top:0.4em;font-size:0.8em;opacity:0.7;">${
							Object.entries(upcomingAbility.details).map(([k, v]) => `<strong>${k}:</strong> ${v}`).join(" &nbsp;·&nbsp; ")
						}</div>`
						: ""}
				</div>`
			: "";

		// A caster picks one new spell per level, from their class list at the level they
		// are reaching or lower. A non-caster is sent an empty list and sees nothing.
		const choices = Array.isArray(spellChoices) ? spellChoices : [];
		let chosenSpell = null;
		const spellPickerHTML = choices.length
			? `<div style="margin:0.75em 0;">
					<strong>📖 Learn one new spell</strong>
					<div id="levelSpellPicker" class="spell-picker" style="max-height:180px;margin-top:0.4em;">
						${choices.map((sp) => `<button type="button" class="spell-option" data-spell="${sp.name}"
							title="${(sp.description || "").replace(/"/g, "&quot;")}">
							<span class="spell-name">${sp.name}</span>
							<span class="spell-meta">${sp.level === 0 ? "Cantrip" : `Level ${sp.level}`}${
								sp.damage ? ` · ${sp.damage} ${sp.damageType || ""}`.trimEnd() : ""
							}</span>
						</button>`).join("")}
					</div>
				</div>`
			: "";

		// Create a modal overlay
		const modal = document.createElement("div");
		modal.classList.add("modal");
		modal.innerHTML = `
    <div class="modal-content">
      <button class="modal-close">✕</button>
      <h3>🎉 Level ${newLevel}!</h3>
      ${abilityPreviewHTML}
      ${spellPickerHTML}
      <p style="margin-top:0.75em;">You have <strong>2 points</strong> to distribute among your attributes.</p>
      <p style="margin-top:0;"><em>You will also gain <strong>1d6 + CON mod</strong> HP and 1 spell slot automatically on confirm.</em></p>
      <div class="grid two">
        ${attrs
			.map(
				(a) => `
          <div>
            <label>${a.toUpperCase()}</label>
            <input type="number" id="lvl_${a}" value="0" min="0" max="2" />
          </div>
        `
			)
			.join("")}
      </div>
      <div class="row space-between" style="margin-top:1em;">
        <button id="cancelLevelUp" class="secondary">Cancel</button>
        <button id="confirmLevelUp" class="primary">Confirm</button>
      </div>
    </div>
  `;
		document.body.appendChild(modal);

		const confirmBtn = document.getElementById("confirmLevelUp");
		const cancelBtn = document.getElementById("cancelLevelUp");

		cancelBtn.addEventListener("click", () => modal.remove());

		// One pick, and clicking it again clears it — a player who changes their mind
		// should not have to cancel the whole level-up to do so.
		const spellButtons = modal.querySelectorAll("#levelSpellPicker .spell-option");
		spellButtons.forEach((button) => {
			button.addEventListener("click", () => {
				const name = button.dataset.spell;
				chosenSpell = chosenSpell === name ? null : name;
				spellButtons.forEach((other) => {
					other.classList.toggle("chosen", other.dataset.spell === chosenSpell);
				});
			});
		});

		confirmBtn.addEventListener("click", () => {
			const gains = {};
			let total = 0;
			attrs.forEach((a) => {
				const val = Number(document.getElementById(`lvl_${a}`).value || 0);
				gains[a] = val;
				total += val;
			});
			if (total !== 2) {
				alert("You must distribute exactly 2 points total among your attributes.");
				return;
			}

			// Apply locally for instant feedback
			attrs.forEach((a) => {
				const el = document.getElementById(a);
				if (el) el.value = Number(el.value) + (gains[a] || 0);
			});
			updatePointsDisplay();

			socket.emit("player:levelup:confirm", { lobbyId, gains, spell: chosenSpell });
			modal.remove();
			appendLog(`✅ Level-up applied locally and sent to server.\n`);
		});
	});

	// Confirmation from server
	socket.on("player:levelup:confirm", ({ newStats, newLevel, hpGained, newAbility, learnedSpell }) => {
		appendLog("✨ Level-up confirmed by server.\n");
		// Announced from the server's reply, not from the click: the pick is validated
		// there, and a refusal arrives as a toast instead.
		if (learnedSpell) {
			appendActionLog(`📖 <strong>${me.name}</strong> learned <strong>${learnedSpell.name}</strong>.`, "levelup-event");
		}

		// Sync stats (includes updated hp/max_hp from HP roll)
		if (newStats) {
			attrs.forEach((a) => {
				const el = document.getElementById(a);
				if (el && newStats[a] != null) el.value = newStats[a];
			});
			// Update HP display immediately
			const hpEl = document.getElementById("charHP");
			if (hpEl && newStats.hp != null) hpEl.textContent = newStats.hp;
		}

		// Sync currentState so renderState sees the new level and stats
		if (currentState?.players?.[me.name]) {
			if (newLevel) currentState.players[me.name].level = newLevel;
			if (newStats) currentState.players[me.name].stats = { ...currentState.players[me.name].stats, ...newStats };
		}

		// Add the new ability to currentState and refresh the abilities display
		if (newAbility && currentState?.players?.[me.name]) {
			const abilities = currentState.players[me.name].abilities = currentState.players[me.name].abilities || [];
			if (!abilities.some(a => a.name === newAbility.name)) {
				abilities.push(newAbility);
			}
			// Refresh ability list if the component is on screen
			const abilitiesContainer = document.getElementById("gameAbilitiesContainer") || document.getElementById("charBuilderAbilitiesContainer");
			if (abilitiesContainer && typeof drawAbilitiesComponent === "function") {
				const isGameContainer = abilitiesContainer.id === "gameAbilitiesContainer";
				drawAbilitiesComponent(abilitiesContainer.id, abilities, false, isGameContainer);
			}
			appendActionLog(`✨ Learned <strong>${newAbility.name}</strong>: ${newAbility.description}`, "levelup-event");
		}

		// Update spell slot display (max = newLevel, one slot per level)
		if (newLevel) {
			const spellSlotsUsed = currentState?.players?.[me.name]?.spellSlotsUsed || 0;
			const slotsEl = document.getElementById("charSpellSlots");
			if (slotsEl) slotsEl.textContent = `${Math.max(0, newLevel - spellSlotsUsed)}/${newLevel}`;
		}

		if (hpGained) {
			appendActionLog(`❤️ Gained <strong>+${hpGained} HP</strong> from level up!`, "hp-heal-event");
		}

		renderState(currentState);
	});

	// === XP UPDATES ===
	socket.on("xp:update", ({ player, xp, amount, reason }) => {
		console.log("🧩 [XP UPDATE EVENT]", { player, xp, amount, reason, me: me.name });

		if (me.name !== player) {
			console.log("↪️ Ignored XP update (not current player)");
			return;
		}

		appendActionLog(`🎖️ <strong>${player}</strong> gains ${amount} XP — ${reason}`, "xp-event");

		const thresholds = [0,300,900,2700,6500,14000,23000,34000,48000,64000,85000,100000,120000,140000,165000,195000,225000,265000,305000,355000,400000,450000,500000,560000,620000];
		const level = Number(els.level.value || 1);
		const next = thresholds[level] || 99999;
		const prev = thresholds[level - 1] || 0;
		const progress = Math.min(100, ((xp - prev) / (next - prev)) * 100);

		const xpFill = document.getElementById("xpFillGame") || document.getElementById("xpFill");
		const xpLabel = document.getElementById("xpLabelGame") || document.getElementById("xpLabel");

		if (xpFill) {
			xpFill.style.width = `${progress}%`;
			console.log(`📊 XP bar updated: ${progress.toFixed(1)}%`);
		}
		if (xpLabel) {
			xpLabel.textContent = `${xp} / ${next} XP`;
			console.log(`📈 XP label updated: ${xp} / ${next}`);
		}

		// Keep currentState in sync so renderState doesn't show stale XP
		if (currentState?.players?.[player]) {
			currentState.players[player].xp = xp;
		}

		showToast(`You got ${amount} XP because ${reason}`, "success");
		window.sfxManager?.play([{ file: "treasure_chest_open_mnf6wqthkpnx.mp3", name: "XP gain" }]);
	});

	// === SPELL SLOT UPDATES ===
	socket.on("spellslots:update", ({ player, spellSlotsUsed, maxSlots }) => {
		const slotsLeft = Math.max(0, maxSlots - spellSlotsUsed);
		const msg = `🔮 ${player}'s spell slots: ${slotsLeft}/${maxSlots} remaining`;
		appendActionLog(msg, "spellslot-event");

		if (me.name === player) {
			if (currentState?.players?.[player]) {
				currentState.players[player].spellSlotsUsed = spellSlotsUsed;
			}
			const el = document.getElementById("charSpellSlots");
			if (el) el.textContent = `${slotsLeft}/${maxSlots}`;
			showToast(msg, slotsLeft === 0 ? "danger" : "info");
			// Redraw abilities so Use/Cast buttons reflect new slot state
			const abilities = currentState?.players?.[player]?.abilities || [];
			const container = document.getElementById("gameAbilitiesContainer");
			if (container && typeof drawAbilitiesComponent === "function") {
				drawAbilitiesComponent("gameAbilitiesContainer", abilities, false, true);
			}
		}
	});

	// === HP UPDATES ===
	socket.on("hp:update", ({ player, hp, delta, reason }) => {
		console.log("🧩 [HP UPDATE EVENT]", { player, hp, delta, reason });

		const msg = delta >= 0 ? `❤️ ${player} recovers ${Math.abs(delta)} HP${reason ? ` — ${reason}` : ""}` : `💔 ${player} takes ${Math.abs(delta)} damage${reason ? ` — ${reason}` : ""}`;

		showToast(msg, delta >= 0 ? "success" : "danger");
		appendActionLog(msg, delta >= 0 ? "hp-heal-event" : "hp-damage-event");

		// Sync currentState so renderState doesn't show stale HP
		if (currentState?.players?.[player]?.stats) {
			currentState.players[player].stats.hp = hp;
		}

		if (me.name === player) {
			const hpEl = document.getElementById("charHP");
			if (hpEl) {
				hpEl.textContent = hp;
				console.log(`💪 HP updated for ${player}: now ${hp}`);
			} else {
				console.warn("⚠️ charHP element not found, UI not updated");
			}

			// Dismiss death modal if player has been revived
			if (hp > 0) {
				_myPlayerDead = false;
				hideDeathModal();
			}
		} else {
			console.log(`↪️ HP event for another player (${player}), skipping UI update`);
		}
	});

	// === GOLD UPDATES ===
	socket.on("gold:update", ({ player, gold, delta }) => {
		console.log("🧩 [GOLD UPDATE EVENT]", { player, gold, delta });

		const msg = delta >= 0 ? `💰 ${player} gains ${Math.abs(delta)} gold (now ${gold})` : `💰 ${player} loses ${Math.abs(delta)} gold (now ${gold})`;

		showToast(msg, delta >= 0 ? "success" : "warning");
		appendActionLog(msg, "gold-event");
		if (delta > 0) window.sfxManager?.play([{ file: "coin_pouch_jingle_mnf6yyehe52u.mp3", name: "Gold gain" }]);

		// Sync currentState so renderState doesn't show stale gold
		if (currentState?.players?.[player]) {
			currentState.players[player].gold = gold;
		}

		if (me.name === player) {
			const el = document.getElementById("charGold");
			if (el) {
				el.textContent = gold;
				console.log(`💰 Gold updated for ${player}: now ${gold}`);
			} else {
				console.warn("⚠️ charGold element not found, UI not updated");
			}
		} else {
			console.log(`↪️ Gold event for another player (${player}), skipping UI update`);
		}
	});

	// === REST VOTING ===
	socket.on("rest:vote:start", (state) => updateRestVoteModal(state, true));
	socket.on("rest:vote:update", (state) => updateRestVoteModal(state, false));

	socket.on("rest:vote:result", ({ passed, type }) => {
		clearRestVoteTimer();
		const resultEl = document.getElementById("restVoteResult");
		const btnsEl   = document.getElementById("restVoteBtns");
		if (resultEl) {
			resultEl.textContent = passed
				? `✅ Vote passed — ${type === "long" ? "Long" : "Short"} rest begins!`
				: "❌ Vote failed — adventure continues!";
			resultEl.style.color = passed ? "#6f6" : "#f66";
			resultEl.style.display = "block";
		}
		if (btnsEl) btnsEl.style.display = "none";
		setTimeout(() => {
			const modal = document.getElementById("restVoteModal");
			if (modal) modal.style.display = "none";
			if (resultEl) { resultEl.style.display = "none"; resultEl.textContent = ""; }
			if (btnsEl) btnsEl.style.display = "";
		}, 2500);
	});

	// === SUGGESTIONS ===
	socket.on("suggestions:update", ({ suggestions }) => {
		updateDMSuggestions(suggestions);
	});

	socket.on("music:change", ({ mood }) => {
		// Ensure world type is current before matching
		if (currentState?.campaignSetting) {
			window.musicManager?.setWorldType(currentState.campaignSetting);
		}
		if (mood) {
			window.musicManager?.requestMood(mood);
		} else {
			window.musicManager?.stop();
		}
	});

	// === SOUND EFFECTS ===
	socket.on("sfx:play", ({ effects }) => {
		window.sfxManager?.play(effects);
	});

	// === ROLL REQUIRED ===
	socket.on("roll:required", ({ player, sides, stats, mods, dc }) => {
		const statStr = stats.length ? ` using ${stats.map(s => s.toUpperCase()).join(" + ")}` : "";
		const modStr = mods !== 0 ? ` (mod ${mods >= 0 ? "+" : ""}${mods})` : "";
		const dcStr = dc ? ` (DC ${dc})` : "";
		const msg = `🎲 ${player} must roll a d${sides}${statStr}${modStr}${dcStr}!`;
		appendActionLog(msg, "dice-event");
		showToast(msg, "info");
		if (me.name === player) {
			enterRollRequiredMode({ sides, stats, mods, dc });
		}
	});

	// === CONDITIONS UPDATES ===
	socket.on("conditions:update", ({ player, conditions }) => {
		console.log("🧩 [CONDITIONS UPDATE EVENT]", { player, conditions });

		const msg = `⚔️ ${player}'s conditions: ${conditions.length ? conditions.join(", ") : "none"}`;
		showToast(msg, "info");
		appendActionLog(msg, "conditions-event");

		// Sync currentState so renderState doesn't show stale conditions
		if (currentState?.players?.[player]) {
			currentState.players[player].conditions = conditions;
		}

		if (me.name === player) {
			const condEl = document.getElementById("charConditions");
			if (condEl) {
				condEl.textContent = conditions.join(", ") || "None";
				console.log(`🌀 Conditions updated for ${player}:`, conditions);
			} else {
				console.warn("⚠️ charConditions element not found");
			}
		}
	});

	// === INVENTORY UPDATES ===
	socket.on("inventory:update", ({ player, item, change, newCount, description, attributes }) => {
		console.log("🧩 [INVENTORY UPDATE EVENT]", {
			player,
			item,
			change,
			newCount,
			description,
			attributes,
		});

		appendActionLog(`🎒 <strong>${player}</strong> ${change} <em>${item}</em> (now has ${newCount})`, "inventory-event");

		if (me.name !== player) {
			console.log(`↪️ Inventory event for another player (${player}), skipping update`);
			return;
		}

		if (!currentState?.players?.[player]) {
			console.warn(`⚠️ No player record found for ${player} in currentState`);
			return;
		}

		const p = currentState.players[player];
		p.inventory = Array.isArray(p.inventory) ? p.inventory : [];

		p.inventory = p.inventory.map((i) => {
			if (typeof i === "string") return { name: i, count: 1, description: "", attributes: {} };
			return {
				name: i.name || "Unknown",
				count: i.count ?? 1,
				description: i.description ?? "",
				attributes: i.attributes ?? {},
			};
		});

		let existing = p.inventory.find((i) => i.name.toLowerCase() === item.toLowerCase());
		if (!existing && newCount > 0) {
			existing = { name: item, count: newCount, description: description || "", attributes: attributes || {} };
			p.inventory.push(existing);
			console.log(`➕ Added new item to inventory: ${item} (${newCount})`);
		} else if (existing) {
			existing.count = newCount;
			if (description) existing.description = description;
			if (attributes && Object.keys(attributes).length) {
				existing.attributes = { ...existing.attributes, ...attributes };
			}
			if (newCount <= 0) {
				p.inventory = p.inventory.filter((i) => i.name.toLowerCase() !== item.toLowerCase());
				console.log(`❌ Removed item ${item} from inventory`);
			} else {
				console.log(`🔄 Updated existing item ${item} count → ${newCount}`);
			}
		}

		currentState.players[player] = p;

		console.log('Updating inventory container with data from LLM Event');
		console.log(p.inventory);
		const eqMap = {
				weapon:  p.weapon?.name  || "",
				armor:   p.armor?.name   || "",
				trinket: p.trinket?.name || "",
			};
		drawInventoryComponent("gameInventoryContainer", p.inventory, false, eqMap);
	});

	socket.on("join:inProgress", ({ lobbyCode, availableChars, hibernating }) => {
		console.log("⚠️ Game already in progress:", lobbyCode, availableChars);
		showRejoinModal(lobbyCode, availableChars, hibernating);
	});

	socket.on("join:confirmed", ({ lobbyId: id, lobbyCode: code, state, isHost: hostFlag }) => {
		console.log("[client] Mid-game join confirmed. lobbyId:", id, "isHost:", !!hostFlag);
		lobbyId = id;
		lobbyCode = code;
		joiningInProgress = false;
		pendingJoinCode = null;
		iAmHost = !!hostFlag;
		currentState = state;

		// Restore hidden buttons in case player navigates back
		["startGame", "phaseReady"].forEach((elId) => {
			const el = document.getElementById(elId);
			if (el) el.classList.remove("hidden");
		});

		enterGameMode();
		updateGameUI(state);
		renderLogs(state);
	});

	socket.on("game:over", ({ reason }) => {
		if (reason === "wiped") {
			appendLog("☠️ <strong>The entire party has been slain. The adventure ends in darkness...</strong>");

			// Epilogue narration is already in the DOM — the server sends narration
			// before game:over and awaits TTS in between, so no delay needed.
			// If the death modal is already showing (individual death), this
			// seamlessly upgrades it to the wipe modal in place.
			showDeathModal("wipe", { returnToLobby: true });
			const storyLog = document.getElementById("storyLog");
			if (storyLog) {
				const entries = storyLog.querySelectorAll(".dm-narration");
				const recent = Array.from(entries).slice(-5);
				recent.forEach(el => appendDeathNarration(el.innerHTML));
			}
		} else if (reason === "completed") {
			appendLog("🏆 <strong>Victory! The campaign has been completed. Your legend will be remembered.</strong>");
			showToast("Campaign completed! The adventure is over.", "success");
		}
	});

	socket.on("timer:pending", ({ player, readingDelayMs, ttsActive }) => {
		showTimerPending(player, readingDelayMs, ttsActive);
	});

	socket.on("timer:start", ({ player, endsAt, durationMs }) => {
		startTimerDisplay(player, endsAt, durationMs);
		// Audible cue that the turn timer has begun
		window.sfxManager?.play([{ file: "war_horn_blast_mnf6xmv0exwj.mp3", name: "Turn timer started" }]);
	});

	socket.on("timer:cancel", () => {
		stopTimerDisplay();
	});

	// Listen for lock/unlock signals
	socket.on("ui:lock", ({ actor, message }) => lockUI(actor, message));
	socket.on("ui:unlock", () => unlockUI());

	// === CONNECTION RESILIENCE ===
	// Socket.IO reconnects automatically, but with a NEW socket id. Room membership
	// and the server's socket→player mapping are both keyed to the old one, so a
	// reconnected client is silently deaf: it receives no further lobby broadcasts
	// and its actions come back as "Unknown player". Nothing on screen changed, so
	// the player has no idea. Re-announcing ourselves on every reconnect is what
	// closes that hole.
	let _hasConnectedBefore = false;

	// The server issues a session token the first time it knows who we are. Presenting
	// it on reconnect is what lets the server treat us as the same player rather than
	// a stranger on a new socket. Kept in sessionStorage so it survives a reload but
	// does not leak into another tab playing a different character.
	socket.on("session:token", ({ token, lobbyId: id, seq, epoch }) => {
		try {
			sessionStorage.setItem("st.sessionToken", token);
			sessionStorage.setItem("st.sessionLobby", id || "");
			sessionStorage.setItem("st.syncSeq", String(seq ?? 0));
			syncSeq = seq ?? 0; syncEpoch = epoch ?? 0;
			sessionStorage.setItem("st.syncEpoch", String(epoch ?? 0));
		} catch { /* private browsing — resume degrades to the explicit rejoin path */ }
	});

	socket.on("session:resumed", (res) => {
		if (res?.ok) {
			console.log(`🔄 Session resumed as ${res.playerName} (seq ${res.seq})`);
			try {
				sessionStorage.setItem("st.syncSeq", String(res.seq ?? 0));
				syncSeq = res.seq ?? 0; syncEpoch = res.epoch ?? 0;
				sessionStorage.setItem("st.syncEpoch", String(res.epoch ?? 0));
			} catch { /* ignore */ }
			setConnectionStatus("online");
			return;
		}
		// The token expired or the server restarted. Fall back to the explicit path,
		// which verifies character ownership properly.
		console.warn(`⚠️ Session resume refused (${res?.reason}) — falling back`);
		try { sessionStorage.removeItem("st.sessionToken"); } catch { /* ignore */ }
		resumeSession();
	});

	/**
	 * Re-establishes this socket's membership after a reconnect.
	 *
	 * @description Chooses the strongest re-entry the current phase allows. Mid-game
	 *   `join:rejoin` is required because it re-registers the socket→player mapping
	 *   that `playerBySid` needs before the player can act again; `state:request` only
	 *   re-joins the room, which is enough to start receiving events but not enough to
	 *   send them. Outside a running game the room is all that matters.
	 * @returns {void}
	 */
	function resumeSession() {
		if (!lobbyId) return;
		const phase = currentState?.phase;
		const charName = me?.name;
		const characterId = currentState?.players?.[charName]?.characterId;

		if (charName && lobbyCode && (phase === "running" || phase === "hibernating")) {
			console.log(`🔄 Reconnected — resuming as ${charName} in ${lobbyCode}`);
			socket.emit("join:rejoin", { lobbyCode, charName, clientId, characterId });
		} else {
			console.log(`🔄 Reconnected — re-requesting state for ${lobbyId}`);
			socket.emit("state:request", { lobbyId });
		}
	}

	// Subscribe to live lobby list updates (for landing page)
	socket.on("connect", () => {
		socket.emit("lobbies:watch");
		setConnectionStatus("online");
		if (_hasConnectedBefore) {
			// Prefer the session token: it restores the player's identity, room and
			// turn-order seat in one step. resumeSession() is the fallback for a token
			// that has expired or was never issued.
			let token = null;
			try { token = sessionStorage.getItem("st.sessionToken"); } catch { /* ignore */ }
			if (token) socket.emit("session:resume", { token });
			else resumeSession();
		}
		_hasConnectedBefore = true;
	});
	socket.emit("lobbies:watch"); // also subscribe immediately if already connected

	socket.on("disconnect", (reason) => {
		// "io client disconnect" is our own deliberate teardown (init.js beforeunload);
		// anything else is a real loss the player needs to know about.
		if (reason === "io client disconnect") return;
		console.warn(`🔌 Disconnected: ${reason}`);
		setConnectionStatus("offline", reason);
	});

	socket.on("connect_error", (err) => {
		setConnectionStatus("reconnecting", err?.message);
	});

	socket.io.on("reconnect_attempt", (n) => {
		setConnectionStatus("reconnecting", `attempt ${n}`);
	});

	socket.io.on("reconnect_failed", () => {
		// Socket.IO has exhausted its attempts and will not retry on its own.
		setConnectionStatus("failed");
	});

	socket.on("lobbies:update", ({ lobbies }) => {
		renderLobbiesList(lobbies);
	});

	socket.on("lobby:closed", () => {
		showToast("The host has left. This lobby has been closed.", "error", 5000);
		show(els.landing);
		fetchActiveLobbies();
	});

	// When audio playback ends (or is skipped), tell the server so it can start the turn timer
	document.addEventListener("narration:playback:ended", () => {
		if (socket && lobbyId) socket.emit("narration:done", { lobbyId });
	});

	console.log("📡 GameApp socket events registered");
}
