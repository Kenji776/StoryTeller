// =====================================================
// 🧩 SAFE EVENT ATTACHMENT HELPER
// =====================================================
function safeAddEvent(selectorOrEl, event, handler, options) {
	let elements = [];

	if (typeof selectorOrEl === "string") {
		elements = document.querySelectorAll(selectorOrEl);
	} else if (selectorOrEl instanceof Element) {
		elements = [selectorOrEl];
	} else if (selectorOrEl && selectorOrEl.length) {
		elements = selectorOrEl; // NodeList or array
	}

	if (!elements.length) {
		console.warn(`⚠️ [safeAddEvent] Element(s) not found for selector:`, selectorOrEl);
		return;
	}

	elements.forEach((el) => {
		el.addEventListener(event, handler, options);
	});
}

// =====================================================
// 🎲 PENDING ROLL STATE
// =====================================================
let pendingRoll = null; // { sides, stats, mods, dc }

function enterRollRequiredMode({ sides, stats, mods, dc = 0 }) {
	pendingRoll = { sides, stats, mods, dc };

	// Lock text input, send button, quick actions
	if (els.actionInput) els.actionInput.disabled = true;
	if (els.sendAction) els.sendAction.disabled = true;
	const qa = document.getElementById("quickActionSelect");
	if (qa) qa.disabled = true;

	// Lock all dice except the required one; highlight the required one
	document.querySelectorAll(".die").forEach(btn => {
		if (Number(btn.dataset.sides) === sides) {
			btn.classList.add("die-required");
			btn.disabled = false;
		} else {
			btn.classList.remove("die-required");
			btn.disabled = true;
		}
	});
}

function clearPendingRoll() {
	pendingRoll = null;
	document.querySelectorAll(".die").forEach(btn => {
		btn.classList.remove("die-required");
		btn.disabled = true;
	});
}

// =====================================================
// 🎧 EVENT HANDLER FUNCTIONS (CALLABLE DIRECTLY)
// =====================================================

// === Play Preview ===
async function handlePlayPreview() {
	const id = els.voiceSelect.value;
	if (!id) return alert("Select a voice first!");

	const audio = new Audio(`/api/voice-preview/${id}`);

	try {
		const res = await fetch(`/api/voice-preview/${id}`);
		if (res.status === 204) {
			// ✅ Dev mode — no audio returned
			const msg = await res.json().catch(() => ({}));
			alert(msg.message || "Voice preview disabled in developer mode.");
			return;
		}
		if (!res.ok) throw new Error(`Preview failed (${res.status})`);
		audio.play().catch((err) => console.warn("Preview playback failed:", err));
	} catch (err) {
		console.error("⚠️ Error playing preview:", err);
	}
}

// === Validate on Save ===
function handleValidateSave(ev) {
	if (!updatePointsDisplay()) {
		if (ev) ev.preventDefault();
		alert("You have spent too many points! Please reduce ability scores.");
		return false;
	}
	return true;
}

// === Create Lobby ===
async function handleCreateLobby() {
	try {
		const isPrivate = document.getElementById("lobbyPrivate")?.checked;
		const rawPassword = document.getElementById("lobbyPassword")?.value?.trim();
		let password = null;
		if (isPrivate && rawPassword) {
			password = await hashPassword(rawPassword);
		} else if (isPrivate && !rawPassword) {
			return alert("Please enter a password for your private lobby.");
		}
		socket.emit("lobby:create", password ? { password } : {});
		console.log("[client] Sent lobby:create", password ? "(password protected)" : "(open)");
	} catch (err) {
		console.error("[client] Failed to create lobby:", err);
		alert("Error creating lobby: " + err.message);
	}
}

// === Join Lobby ===
/**
 * Puts this client into the watching-only view.
 *
 * @description A body class rather than a per-element sweep, so a control added later is
 *   hidden by the stylesheet instead of being missed by a list here. Nothing about this is
 *   a security boundary — the server refuses `player:sheet` and `player:ready` from an
 *   observer outright, and `action:submit` never resolves them to an actor. This only
 *   stops the client offering a button that would be rejected.
 * @returns {void}
 */
function enterObserverMode() {
	window.isObserver = true;
	document.body.classList.add("observing");

	if (!document.getElementById("observerBanner")) {
		const banner = document.createElement("div");
		banner.id = "observerBanner";
		banner.className = "observer-banner";
		banner.innerHTML = "👁️ <strong>Watching</strong> — you have no character in this game. "
			+ "You can still read the story and talk in chat.";
		const lobbyEl = document.getElementById("lobby");
		lobbyEl?.insertBefore(banner, lobbyEl.firstChild);
	}
}

function handleJoinLobby(preHashedPassword = null) {
	try {
		const code = (els.joinCode.value || "").trim().toUpperCase();
		if (!code) return alert("Enter a code before joining.");
		// Watching takes no character, so it is the one join that works against a game
		// already under way without picking a seat first.
		const asObserver = !!document.getElementById("joinAsObserver")?.checked;
		console.log("[client] Attempting to join lobby code:", code, asObserver ? "(observing)" : "");
		socket.emit("lobby:join", { code, password: preHashedPassword || undefined, asObserver });

		// Add timeout check in case server never responds
		const timeout = setTimeout(() => {
			alert("No response from server — check console for details.");
			console.error("[client] joinLobby timed out — possible connection or code issue.");
		}, 5000);

		// If game is already running the server sends join:inProgress — clear the timeout
		socket.once("join:inProgress", () => clearTimeout(timeout));

		socket.once("lobby:joined", (data) => {
			clearTimeout(timeout);
			console.log("[client] Joined lobby:", data);
			lobbyId = data.lobbyId;
			lobbyCode = data.code;
			iAmHost = false;
			if (data.observer) enterObserverMode();
			show(els.lobby);
		});

		socket.once("toast", (msg) => {
			clearTimeout(timeout);
			console.warn("[client] Server toast:", msg);
			showToast(msg.message, msg.type);
		});
	} catch (err) {
		console.error("[client] Join lobby error:", err);
		alert("Error joining lobby: " + err.message);
	}
}

// === Phase Ready ===
function handlePhaseReady() {
	socket.emit("lobby:phase", { lobbyId, phase: "readyCheck" });
}

// === Start Game ===
function handleStartGame() {
	console.log('Starting Game for Lobby: ' + lobbyId);
	showLoading("Summoning the Dungeon Master...");
	socket.emit("game:start", { lobbyId });
}

// === Save Character Sheet ===
function handleSaveCharacterSheet() {
	if (!updatePointsDisplay()) {
		alert("You have spent too many points! Please reduce ability scores.");
		return;
	}

	const rawSheet = buildCurrentSheet();

	// Carry imported XP / gold through to the server so they aren't reset to 0
	const sheet = {
		...rawSheet,
		level: Number(rawSheet.level) || 1,
		xp:    _pendingImportXP   !== null ? Number(_pendingImportXP)   : undefined,
		gold:  _pendingImportGold !== null ? Number(_pendingImportGold) : undefined,
	};
	// Strip undefined keys so the server spread doesn't clobber existing values with undefined
	if (sheet.xp   === undefined) delete sheet.xp;
	if (sheet.gold === undefined) delete sheet.gold;

	let oldName = me.name;
	me.name = (els.name.value || "").trim();
	if (!me.name) return alert("Enter a name before saving.");

	// When joining an in-progress game, skip server sheet sync — it happens at join time
	if (!joiningInProgress) {
		socket.emit("player:sheet", { lobbyId, name: me.name, sheet });
		// Clear pending import values after they've been sent
		_pendingImportXP          = null;
		_pendingImportGold        = null;
		_pendingImportCharacterId = null;

		// Name changed? Inform chat system
		if (me.name !== oldName) {
			socket.emit("chat:updateName", { lobbyId, oldName, newName: me.name, clientId });
		}
	}

	hasSavedSheet = true;

	els.toggleReady.disabled = false;
	els.toggleReady.removeAttribute("title");
	els.toggleReady.classList.remove("disabled-btn");
	els.toggleReady.classList.add("pulse-enable");
	setTimeout(() => els.toggleReady.classList.remove("pulse-enable"), 600);

	// A portrait is drawn only when the player asks for one, by pressing the button.
	// Saving used to generate on the player's behalf, which meant a page they had not
	// touched could spend twenty to forty seconds and an image charge drawing a
	// character nobody had chosen. Guessing when they want one is not worth the money.
}

// === Chat Toggle ===
function handleOpenChat() {
	try {
		openChat();
		console.log("[UI] Chat panel toggled");
	} catch (err) {
		console.warn("⚠️ Failed to toggle chat:", err);
	}
}

// === Randomize Character ===
function handleRandomizeCharacter() {
	try {
		randomizeCharacter();

		// `randomizeCharacter` assigns to `.value` directly, and a programmatic
		// assignment fires neither `change` nor `input` — the only events the prompt
		// box listens to. Without this the description would still describe whatever
		// was there before the roll.
		refreshPortraitPrompt();

		handleSaveCharacterSheet();

		console.log("[UI] Character randomized");
	} catch (err) {
		console.warn("⚠️ Failed to randomize character:", err);
	}
}

// === Send Action ===
async function handleSendAction() {
	const text = els.actionInput.value.trim();
	if (!text) return;
	appendLog(`> ${me.name}: ${text}\n`);
	// Remembered so a rejection can hand the wording back instead of making the
	// player retype it — see the action:rejected handler.
	window._lastSubmittedAction = text;
	els.actionInput.value = "";
	if (typeof clearRejectionNotice === "function") clearRejectionNotice();
	// Stop the DM narration so the player's action can be read on its own channel
	await stopDMNarration();
	socket.emit("action:submit", { lobbyId, text });
}

/**
 * Asks the server what this character could do right now.
 *
 * @description Deliberately asks the server rather than reasoning in the browser:
 *   the answer has to agree with the same capability model the feasibility gate
 *   uses, and only the server holds that. Shows a placeholder immediately, because
 *   the reply involves a model call and silence would read as a broken button.
 * @returns {void}
 */
function handleAskAdvisor() {
	if (!lobbyId || !me?.name) return;
	const panel = document.getElementById("advisorPanel");
	if (panel) {
		panel.style.display = "block";
		panel.innerHTML = '<div style="opacity:0.75;">Thinking about what you could do…</div>';
	}
	socket.emit("advisor:ask", { lobbyId, playerName: me.name });
}

// === Action Input KeyDown ===
function handleActionInputKey(e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		handleSendAction();
	}
}

// === Dice Roll ===
function handleDiceRoll(e) {
	const btn = e.currentTarget;
	const sides = Number(btn.dataset.sides || 20);
	const raw = Math.floor(Math.random() * sides) + 1;

	let rollText;

	if (pendingRoll && pendingRoll.sides === sides) {
		// Apply D&D 5e stat modifiers: floor((stat - 10) / 2)
		const playerStats = currentState?.players?.[me.name]?.stats || {};
		let modTotal = 0;
		const modParts = [];

		for (const stat of (pendingRoll.stats || [])) {
			const statVal = Number(playerStats[stat.toLowerCase()] ?? 10);
			const mod = Math.floor((statVal - 10) / 2);
			modTotal += mod;
			modParts.push(`${stat.toUpperCase()} ${mod >= 0 ? "+" : ""}${mod}`);
		}

		const flatMod = Number(pendingRoll.mods) || 0;
		if (flatMod !== 0) {
			modTotal += flatMod;
			modParts.push(`mod ${flatMod >= 0 ? "+" : ""}${flatMod}`);
		}

		const total = raw + modTotal;
		const modStr = modParts.length ? ` [${modParts.join(", ")}]` : "";
		const dc = Number(pendingRoll.dc) || 0;
		const dcStr = dc ? ` vs DC ${dc}` : "";
		const outcomeStr = dc ? ` — ${total >= dc ? "SUCCESS" : "FAILURE"}` : "";
		rollText = `[ROLL] ${me.name} rolls a d${sides} → ${raw}${modStr} = ${total} total${dcStr}${outcomeStr}! [/ROLL]`;
		clearPendingRoll();
	} else {
		rollText = `[ROLL] ${me.name} rolls a d${sides} and gets ${raw}! [/ROLL]`;
	}

	appendLog(`[${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}] ${rollText}\n`);
	socket.emit("action:submit", { lobbyId, text: rollText });
}

// === Quick Action Select ===
function handleQuickActionSelect(e) {
	const val = e.target.value;
	e.target.value = ""; // always reset
	if (!val) return;

	// Special values: rest proposals
	if (val.startsWith("__rest:")) {
		const type = val.replace("__rest:", "");
		socket.emit("rest:propose", { lobbyId, type });
		return;
	}

	// Basic weapon attack — build the string from the player's equipped weapon
	if (val === "__attack:basic") {
		const playerData = window.currentState?.players?.[me?.name];
		const weapon = playerData?.weapon;
		let text;
		if (weapon?.name) {
			text = `I attack with my ${weapon.name} (${weapon.damage} ${weapon.damageType})`;
		} else {
			text = "I make a basic weapon attack";
		}
		if (els.actionInput) {
			els.actionInput.value = text;
			els.actionInput.focus();
			els.actionInput.setSelectionRange(text.length, text.length);
		}
		return;
	}

	if (els.actionInput) {
		els.actionInput.value = val;
		els.actionInput.focus();
	}
}

function updateDMSuggestions(suggestions) {
	const group = document.getElementById("dmSuggestionsGroup");
	if (!group) return;
	group.innerHTML = "";
	if (!suggestions || !suggestions.length) {
		group.style.display = "none";
		return;
	}
	for (const s of suggestions) {
		const opt = document.createElement("option");
		opt.value = s;
		opt.textContent = s;
		group.appendChild(opt);
	}
	group.style.display = "";
}

// === Toggle Ready ===
function handleToggleReady() {
	if (!hasSavedSheet) {
		alert("Please save your character sheet before marking ready.");
		return;
	}

	// Mid-game join: send sheet and request to join the running game
	if (joiningInProgress) {
		const sheet = buildCurrentSheet();
		// Restore imported XP/gold so they aren't lost on mid-game join
		if (_pendingImportXP   !== null) sheet.xp   = Number(_pendingImportXP)   || 0;
		if (_pendingImportGold !== null) sheet.gold  = Number(_pendingImportGold) || 0;
		socket.emit("player:join:game", {
			lobbyCode: pendingJoinCode,
			name: me.name,
			sheet,
		});
		els.toggleReady.disabled = true;
		els.toggleReady.textContent = "Joining...";
		return;
	}

	const sheet = buildCurrentSheet();
	socket.emit("player:sheet", { lobbyId, name: me.name, sheet });

	ready = !ready;
	socket.emit("player:ready", { lobbyId, ready });
	els.toggleReady.textContent = ready ? "Unready" : "I'm Ready";

	const disableFields = ["name", "race", "cls", "hp", "str", "dex", "con", "int", "wis", "cha", "abilities", "inventory", "desc"];

	disableFields.forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		el.disabled = ready;
		el.readOnly = ready;
	});

	// Lock buttons that would let the player bypass the sheet lock
	if (els.randomCharBtn) els.randomCharBtn.disabled = ready;
	if (els.saveSheet) els.saveSheet.disabled = ready;
	if (els.generateCharImageBtn) els.generateCharImageBtn.disabled = ready;

	document.querySelectorAll(".form input, .form select, .form textarea").forEach((el) => {
		el.classList.toggle("locked", ready);
	});
}

// === Race Change ===
function handleRaceChange(e) {
	const race = e.target.value;
	const r = raceMods[race];
	if (!r) return;

	appendLog(`[Race] ${race}: ${r.note}`);
	updatePointsDisplay();

	// Show final stats (base points + racial bonus) in the attributes display
	const currentSheet = buildCurrentSheet();
	drawAttributesComponent("charBuilderAttributesContainer", currentSheet.stats, false);
}

// === Class Change ===
function handleClassChange(e) {
	const cls = e.target.value;
	const build = defaultBuilds[cls];
	if (!build) {
		appendLog(`[Class] ${cls}: No defaults found.`);
		return;
	}
	appendLog(`[Class] ${cls}: Default abilities and inventory loaded.`);

	drawAbilitiesComponent("charBuilderAbilitiesContainer", build.abilities, true);
	drawInventoryComponent("charBuilderInventoryContainer", build.inventory, true);
	updatePointsDisplay();
}

function handleOpenMap(e){
	window.open(`components/map.html?lobbyId=${lobbyId}`, "_blank", "width=820,height=660,resizable=yes");
}

function handleOpenInitiative(e) {
	window.open(`components/initiative.html?lobbyId=${lobbyId}`, "_blank", "width=320,height=480,resizable=yes");
}

function handleOpenOptions(e) {
	window.open(`components/options.html?lobbyId=${lobbyId}`, "_blank", "width=820,height=700,resizable=yes");
}

// === Player Options Modal (font chooser) ===
const STORY_FONTS = {
	"Cinzel":       "'Cinzel', serif",
	"Lora":         "'Lora', serif",
	"Crimson Pro":  "'Crimson Pro', serif",
};

function applyStoryFont(fontName) {
	const value = STORY_FONTS[fontName] || STORY_FONTS["Lora"];
	if (els.storyLog) els.storyLog.style.fontFamily = value;
	document.querySelectorAll(".font-option").forEach(btn => {
		btn.classList.toggle("active", btn.dataset.font === fontName);
	});
}

// Narration enabled state — persisted in localStorage, read by sockets.js
function isNarrationEnabled() {
	return localStorage.getItem("narrationEnabled") !== "false";
}

function applyNarrationToggle() {
	const checkbox = document.getElementById("narrationEnabledToggle");
	if (checkbox) checkbox.checked = isNarrationEnabled();
}

function handleNarrationToggle(e) {
	localStorage.setItem("narrationEnabled", e.target.checked ? "true" : "false");
}

function handleOpenPlayerOptions() {
	if (!els.playerOptionsModal) return;
	const saved = localStorage.getItem("storyFont") || "Lora";
	applyStoryFont(saved);
	applyNarrationToggle();
	renderPlayerOptionsGameSettings();
	els.playerOptionsModal.style.display = "flex";
}

function renderPlayerOptionsGameSettings() {
	const el = document.getElementById("playerOptionsGameSettings");
	if (!el || !currentState) { if (el) el.innerHTML = ""; return; }
	const s = currentState;

	const brutalityLabels = ["Kid Safe","Kid Safe","Lighthearted","Lighthearted","Standard","Standard","Gritty","Gritty","Brutal","Brutal","Ultimate Brutality"];
	const brutalityColors = (n) => n <= 2 ? "#4a9a4a" : n <= 4 ? "#8a8a20" : n <= 6 ? "#9a8050" : n <= 8 ? "#9a4a20" : "#9a2020";
	const bLevel = s.brutalityLevel ?? 5;
	const SETTING_LABELS = { standard: "⚔️ High Fantasy", dark_ages: "🏚️ Dark Ages", steampunk: "⚙️ Steampunk", pirate: "🏴‍☠️ Pirate Age", scifi: "🚀 Sci-fi Fantasy" };
	const DIFF_LABELS    = { casual: "🌸 Casual", standard: "⚔️ Standard", hardcore: "💀 Hardcore", merciless: "☠️ Merciless" };
	const LOOT_LABELS    = { sparse: "💰 Sparse", fair: "💎 Fair", generous: "🎁 Generous" };

	const rows = [
		s.campaignTone  ? `<div class="lgo-row"><span class="lgo-key">Tone</span><span class="lgo-val">${s.campaignTone.emoji} ${s.campaignTone.label}</span></div>` : "",
		s.campaignTheme ? `<div class="lgo-row"><span class="lgo-key">Theme</span><span class="lgo-val">${s.campaignTheme.emoji} ${s.campaignTheme.label}</span></div>` : "",
		`<div class="lgo-row"><span class="lgo-key">Setting</span><span class="lgo-val">${SETTING_LABELS[s.campaignSetting || "standard"]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Difficulty</span><span class="lgo-val">${DIFF_LABELS[s.difficulty || "standard"]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Loot</span><span class="lgo-val">${LOOT_LABELS[s.lootGenerosity || "fair"]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Intensity</span><span class="lgo-val" style="color:${brutalityColors(bLevel)};">⚡ ${brutalityLabels[bLevel]}</span></div>`,
	].filter(Boolean).join("");

	el.innerHTML = `
		<hr />
		<h4 style="margin-bottom:0.5em;">Game Settings</h4>
		<div class="lgo-panel">${rows}</div>`;
}

function handleClosePlayerOptions() {
	if (els.playerOptionsModal) els.playerOptionsModal.style.display = "none";
}

function handleFontOptionClick(e) {
	const btn = e.target.closest(".font-option");
	if (!btn) return;
	const fontName = btn.dataset.font;
	localStorage.setItem("storyFont", fontName);
	applyStoryFont(fontName);
}

safeAddEvent(els.openPlayerOptionsBtn, "click", handleOpenPlayerOptions);
safeAddEvent(document.getElementById("readStoryGameBtn"), "click", () => {
	if (lobbyCode) showStoryModal(lobbyCode);
});
// === Ask DM (popup window) ===
safeAddEvent(document.getElementById("askDMBtn"), "click", () => {
	const url = `/dm-chat.html?lobbyId=${encodeURIComponent(lobbyId)}&name=${encodeURIComponent(me.name)}&clientId=${clientId}`;
	window.open(url, "AskDM", "width=600,height=700");
});

// playerOptionsClose removed — handled by centralized .modal-close
if (els.playerOptionsModal) {
	els.playerOptionsModal.addEventListener("click", (e) => {
		if (e.target === els.playerOptionsModal) handleClosePlayerOptions();
	});
	els.playerOptionsModal.querySelector(".font-picker")?.addEventListener("click", handleFontOptionClick);
	document.getElementById("narrationEnabledToggle")?.addEventListener("change", handleNarrationToggle);
}

// === Show / hide the portrait placeholder ===
function showCharacterImage(url) {
	const placeholder = document.getElementById("charImagePlaceholder");
	if (placeholder) placeholder.style.display = "none";
	if (els.charImagePreview) {
		els.charImagePreview.src = url;
		els.charImagePreview.classList.remove("hidden");
	}
}

// === Portrait prompt box ===

/**
 * The generated text last written into the prompt box.
 *
 * @description Held so a refresh can replace exactly that much and leave whatever the
 *   player added after it untouched. The earlier approach — stop refreshing entirely
 *   once they typed — meant someone who added "in an epic pose" and then changed
 *   their armour was left describing armour they no longer wore.
 */
let lastGeneratedPrompt = "";

/**
 * @description Rewrites the generated part of the prompt box from the current
 *   character choices, leaving anything the player added after it alone. Called on
 *   every field change, so the box is current by the time anyone opens it.
 *
 *   `window.buildPortraitPrompt` rather than an import: this file is a classic
 *   script, and the builder is an ES module so the server can share it. The shim in
 *   index.html bridges the two.
 * @returns {void}
 */
function refreshPortraitPrompt() {
	const box = document.getElementById("portraitPrompt");
	if (!box || typeof window.buildPortraitPrompt !== "function") return;

	try {
		const sheet = buildCurrentSheet();
		sheet.name = (els.name?.value || "").trim();

		const next = window.buildPortraitPrompt(sheet);
		box.value = window.mergePromptUpdate(box.value, lastGeneratedPrompt, next);
		lastGeneratedPrompt = next;

		const hint = document.getElementById("portraitPromptHint");
		if (hint && !hint.dataset.sticky) {
			hint.textContent = box.value.startsWith(next) && box.value.length > next.length
				? "Your additions are kept; the description above them follows your sheet."
				: "";
		}
	} catch (err) {
		console.warn("Could not build portrait prompt:", err.message);
	}
}

/**
 * @description Wires the box up. The reset button discards the player's additions and
 *   returns the box to the sheet.
 * @returns {void}
 */
function initPortraitPrompt() {
	const box = document.getElementById("portraitPrompt");
	const hint = document.getElementById("portraitPromptHint");
	const reset = document.getElementById("resetPortraitPrompt");
	if (!box) return;

	if (reset) {
		reset.addEventListener("click", () => {
			box.value = "";
			lastGeneratedPrompt = "";
			refreshPortraitPrompt();
			if (hint) {
				hint.dataset.sticky = "1";
				hint.textContent = "Reset from your character sheet.";
				setTimeout(() => { delete hint.dataset.sticky; }, 2500);
			}
		});
	}

	refreshPortraitPrompt();
}

// === Generate Character Image ===
/**
 * @description Generates the portrait from whatever is in the prompt box. Only ever
 *   reached by the player pressing the button — nothing draws on their behalf — so an
 *   unmet precondition is always worth saying out loud rather than failing quietly.
 * @returns {Promise<void>}
 */
async function handleGenerateCharImage() {
	/**
	 * @description Reports a precondition failure.
	 * @param {string} message - What is missing.
	 * @returns {void}
	 */
	const stop = (message) => alert(message);

	const name = (els.name?.value || "").trim();
	if (!name) return stop("Enter a character name before generating an image.");
	// During mid-game join lobbyId isn't assigned yet — skip silently; image generates post-join
	if (!lobbyId && !joiningInProgress) return stop("You must be in a lobby first.");
	if (!lobbyId) return; // joiningInProgress: defer until join confirmed

	// Nothing to draw yet. A portrait was being requested on page load from an empty
	// box, spending a twenty-to-forty second call — and a charge — on a prompt that
	// described nobody.
	const readyBox = document.getElementById("portraitPrompt");
	if (typeof window.isPromptReady === "function" && !window.isPromptReady(readyBox?.value || "")) {
		return stop("Fill in your character first — the portrait description below is still empty.");
	}

	const btn = els.generateCharImageBtn;
	const origText = btn.textContent;
	btn.disabled = true;
	btn.textContent = "Generating…";

	// An overlay over the whole portrait box, not markup written into the
	// placeholder. Once a portrait exists the placeholder is display:none, so the
	// old spinner went into an invisible element and re-generating looked like a
	// dead button for the twenty-odd seconds the model takes.
	const busy = document.getElementById("charImageBusy");
	const elapsedEl = document.getElementById("charImageBusyElapsed");
	if (busy) busy.classList.remove("hidden");

	const startedAt = Date.now();
	const ticker = elapsedEl
		? setInterval(() => {
			elapsedEl.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s — this takes around 20–40 seconds`;
		}, 1000)
		: null;

	/**
	 * @description Clears the busy state however the attempt ended.
	 * @returns {void}
	 */
	const stopBusy = () => {
		if (ticker) clearInterval(ticker);
		if (busy) busy.classList.add("hidden");
		if (elapsedEl) elapsedEl.textContent = "this takes around 20–40 seconds";
	};

	try {
		const sheet = buildCurrentSheet();
		sheet.name = name;

		// Whatever is in the box at this moment is what gets drawn. The sheet still
		// goes along so the server can fall back if the box is empty.
		const promptBox = document.getElementById("portraitPrompt");
		const prompt = (promptBox?.value || "").trim()
			|| (typeof window.buildPortraitPrompt === "function" ? window.buildPortraitPrompt(sheet) : "");

		const res = await fetch("/api/character-image", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ lobbyId, playerName: name, sheet, prompt }),
		});

		if (res.status === 204) {
			// Developer mode declines image generation. Say so rather than appearing
			// to do nothing, which is indistinguishable from a broken button.
			alert("Image generation is disabled in developer mode.");
			return;
		}
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Image generation failed");

		// Cache-bust: a re-generation overwrites the same filename, so the browser
		// would otherwise keep showing the previous portrait and the button would
		// once again look as though it had done nothing.
		showCharacterImage(`${data.url}?t=${Date.now()}`);
	} catch (err) {
		console.error("Character image error:", err);
		alert(`Failed to generate image: ${err.message}`);
	} finally {
		stopBusy();
		btn.disabled = false;
		btn.textContent = origText;
	}
}

// =====================================================
// 📤 CHARACTER EXPORT
// =====================================================

// XP / gold / characterId preserved across import → save, so they survive the round-trip
let _pendingImportXP          = null;
let _pendingImportGold        = null;
let _pendingImportCharacterId = null;

async function handleExportCharacter() {
	let name, sheet;

	const inGame = !document.getElementById("game")?.classList.contains("hidden");

	if (inGame && currentState && me.name) {
		// In-game: upsertPlayer spreads the sheet flat onto the player object,
		// so ALL fields (level, xp, gold, stats …) are top-level — there is no .sheet sub-object.
		const player = currentState.players?.[me.name];
		if (!player) { showToast("Character not found in current game", "warning"); return; }
		name  = me.name;
		sheet = {
			characterId: player.characterId   || null,
			class:       player.class         || "",
			race:        player.race          || "",
			alignment:   player.alignment     || "",
			background:  player.background    || "",
			deity:       player.deity         || "",
			gender:      player.gender        || "",
			age:         player.age           || "",
			height:      player.height        || "",
			weight:      player.weight        || "",
			level:       Number(player.level) || 1,
			xp:          Number(player.xp)    || 0,
			gold:        Number(player.gold)  || 0,
			stats:       player.stats         || {},
			abilities:   player.abilities     || [],
			inventory:   player.inventory     || [],
			description: player.description   || "",
			voice_id:    player.voice_id      || null,
			conditions:  player.conditions    || [],
			imageUrl:    player.imageUrl       || null,
		};
	} else {
		// Lobby: build from form, coercing all numerics explicitly
		name = (els.name?.value || "").trim();
		if (!name) { showToast("Enter a character name before exporting", "warning"); return; }
		const raw = buildCurrentSheet();
		// characterId: prefer what the server assigned (in currentState), fall back to imported value
		const knownCharId = currentState?.players?.[name]?.characterId || _pendingImportCharacterId || undefined;
		sheet = {
			...raw,
			characterId: knownCharId,
			level: Number(raw.level) || 1,
			xp:    Number(_pendingImportXP)   || 0,
			gold:  Number(_pendingImportGold) || 0,
			stats: {
				...raw.stats,
				hp:     Number(raw.stats?.hp)     || 10,
				max_hp: Number(raw.stats?.max_hp) || Number(raw.stats?.hp) || 10,
				str:    Number(raw.stats?.str)    || 8,
				dex:    Number(raw.stats?.dex)    || 8,
				con:    Number(raw.stats?.con)    || 8,
				int:    Number(raw.stats?.int)    || 8,
				wis:    Number(raw.stats?.wis)    || 8,
				cha:    Number(raw.stats?.cha)    || 8,
			},
		};
	}

	try {
		const res = await fetch("/api/character/export", {
			method:  "POST",
			headers: { "Content-Type": "application/json" },
			body:    JSON.stringify({ name, sheet }),
		});
		if (!res.ok) throw new Error((await res.json()).error || "Export failed");

		const exportData = await res.json();
		const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement("a");
		a.href     = url;
		a.download = `${name.replace(/\s+/g, "_")}.stchar`;
		a.click();
		URL.revokeObjectURL(url);

		showToast(`${name} exported!`, "success");
	} catch (err) {
		console.error("Export error:", err);
		showToast("Export failed: " + err.message, "danger");
	}
}

// =====================================================
// 📥 CHARACTER IMPORT
// =====================================================
async function handleImportCharacter(e) {
	const file = e.target.files[0];
	if (!file) return;
	e.target.value = ""; // reset so the same file can be re-imported

	const importBtn = els.importCharBtn;
	let prevLabel;
	if (importBtn) {
		prevLabel = importBtn.textContent;
		importBtn.disabled = true;
		importBtn.textContent = "⏳ Importing...";
	}

	try {
		const text       = await file.text();
		const { v, data, sig } = JSON.parse(text);

		const res = await fetch("/api/character/import", {
			method:  "POST",
			headers: { "Content-Type": "application/json" },
			body:    JSON.stringify({ data, sig }),
		});
		const json = await res.json();
		if (!res.ok) { showToast(json.error || "Import failed", "danger"); return; }

		const { name, sheet } = json.character;

		// Stash XP / gold / characterId so they survive the save round-trip to the server
		_pendingImportXP          = Number(sheet.xp)   || 0;
		_pendingImportGold        = Number(sheet.gold)  || 0;
		_pendingImportCharacterId = sheet.characterId   || null;

		// ── Populate basic form fields ──
		if (els.name)         els.name.value         = name             || "";
		if (els.raceSelect)   els.raceSelect.value   = sheet.race       || "";
		if (els.charClass)    els.charClass.value    = sheet.class      || "";
		if (els.alignment)    els.alignment.value    = sheet.alignment  || "";
		if (els.background)   els.background.value   = sheet.background || "";
		if (els.deity)        els.deity.value        = sheet.deity      || "";
		if (els.gender)       els.gender.value       = sheet.gender     || "";
		if (els.age)          els.age.value          = sheet.age        || "";
		if (els.height)       els.height.value       = sheet.height     || "";
		if (els.weight)       els.weight.value       = sheet.weight     || "";
		// Level is controlled by lobby startingLevel — don't overwrite from imported sheet
		// HP is derived from level + CON — recalculate after stats are loaded
		if (els.level && window.currentState?.startingLevel) {
			els.level.value = window.currentState.startingLevel;
		}
		if (els.desc)         els.desc.value         = sheet.description || "";
		if (els.voiceSelect)  els.voiceSelect.value  = sheet.voice_id   || "";

		// Update the gold display so buildCurrentSheet() can read it
		const goldDisplayEl = document.getElementById("charGold");
		if (goldDisplayEl) goldDisplayEl.textContent = _pendingImportGold;

		// Show XP / gold in the action log so the player can see what was preserved
		if (_pendingImportXP || _pendingImportGold) {
			appendLog(`[Import] Preserving XP: ${_pendingImportXP} | Gold: ${_pendingImportGold} — will apply on Save Sheet`);
		}

		// ── Stats: strip race mods so sliders hold the true base values ──
		const mods     = (typeof raceMods !== "undefined" && raceMods[sheet.race]?.mod) || {};
		const statKeys = ["str", "dex", "con", "int", "wis", "cha"];
		for (const stat of statKeys) {
			const base   = Math.max(8, Math.min(25, (sheet.stats?.[stat] || 10) - (mods[stat] || 0)));
			const slider = document.getElementById(`${stat}_slider`);
			const input  = document.getElementById(stat);
			if (slider) slider.value = base;
			if (input)  input.value  = base;
		}

		// ── Refresh abilities, inventory, and attribute display ──
		// Spell picks are adopted before the class change fires, because that dispatch is
		// what fetches the new class's pool and reconciles the picks against it.
		if (typeof setSpellPicks === "function") setSpellPicks(sheet.spells);
		els.raceSelect?.dispatchEvent(new Event("change"));
		els.charClass?.dispatchEvent(new Event("change"));
		updatePointsDisplay();

		showToast(`${name} imported!`, "success");
	} catch (err) {
		console.error("Import error:", err);
		showToast("Failed to read character file", "danger");
	} finally {
		if (importBtn) {
			importBtn.disabled = false;
			importBtn.textContent = prevLabel;
		}
	}
}

// =====================================================
// 🪄 ATTACH SAFE EVENT BINDINGS
// =====================================================
safeAddEvent(els.voicePlay, "click", handlePlayPreview);
safeAddEvent(els.saveSheet, "click", handleValidateSave);
safeAddEvent(els.createLobby, "click", handleCreateLobby);
safeAddEvent(els.joinLobby, "click", () => handleJoinLobby());

// Toggle password field visibility
const lobbyPrivateChk = document.getElementById("lobbyPrivate");
const lobbyPasswordFld = document.getElementById("lobbyPassword");
if (lobbyPrivateChk && lobbyPasswordFld) {
	lobbyPrivateChk.addEventListener("change", () => {
		lobbyPasswordFld.style.display = lobbyPrivateChk.checked ? "" : "none";
		if (!lobbyPrivateChk.checked) lobbyPasswordFld.value = "";
	});
}

// Password modal wiring
const passwordModal = document.getElementById("passwordModal");
const submitPasswordBtn = document.getElementById("submitPasswordBtn");
const cancelPasswordBtn = document.getElementById("cancelPasswordBtn");
const lobbyPasswordInput = document.getElementById("lobbyPasswordInput");

if (cancelPasswordBtn) {
	cancelPasswordBtn.addEventListener("click", () => {
		passwordModal.style.display = "none";
		lobbyPasswordInput.value = "";
	});
}
if (submitPasswordBtn) {
	submitPasswordBtn.addEventListener("click", async () => {
		const raw = lobbyPasswordInput.value.trim();
		if (!raw) return alert("Enter the password.");
		const hashed = await hashPassword(raw);
		passwordModal.style.display = "none";
		lobbyPasswordInput.value = "";
		handleJoinLobby(hashed);
	});
}
if (lobbyPasswordInput) {
	lobbyPasswordInput.addEventListener("keydown", async (e) => {
		if (e.key === "Enter") submitPasswordBtn?.click();
	});
}
safeAddEvent(els.phaseReady, "click", handlePhaseReady);
safeAddEvent(els.startGame, "click", handleStartGame);
safeAddEvent(els.saveSheet, "click", handleSaveCharacterSheet);
safeAddEvent(els.chatBtn, "click", handleOpenChat);
safeAddEvent(els.randomCharBtn, "click", handleRandomizeCharacter);
safeAddEvent(els.sendAction, "click", handleSendAction);
safeAddEvent(document.getElementById("advisorBtn"), "click", handleAskAdvisor);
safeAddEvent(els.actionInput, "keydown", handleActionInputKey);
safeAddEvent(".die", "click", handleDiceRoll);
safeAddEvent(document.getElementById("quickActionSelect"), "change", handleQuickActionSelect);
safeAddEvent(els.toggleReady, "click", handleToggleReady);
safeAddEvent(els.raceSelect, "change", handleRaceChange);
safeAddEvent(els.charClass, "change", handleClassChange);
safeAddEvent(els.openMapBtn, "click", handleOpenMap);
safeAddEvent(els.openInitiativeBtn, "click", handleOpenInitiative);
safeAddEvent(els.openOptionsBtn, "click", handleOpenOptions);
safeAddEvent(els.generateCharImageBtn, "click", handleGenerateCharImage);

// === Portrait prompt ===
// Rebuilt whenever a choice that shows in the picture changes, so the box is already
// filled in by the time anyone opens it. Stops refilling once the player types.
document.addEventListener("portraitPrompt:ready", initPortraitPrompt);
for (const id of ["raceSelect", "charClass", "gender", "age", "height", "weight", "alignment",
	"background", "desc", "weaponSelect", "armorSelect", "trinketSelect", "level", "name"]) {
	safeAddEvent(document.getElementById(id), "change", refreshPortraitPrompt);
	safeAddEvent(document.getElementById(id), "input", refreshPortraitPrompt);
}
safeAddEvent(els.exportCharBtn, "click", handleExportCharacter);
safeAddEvent(els.exportCharGameBtn, "click", handleExportCharacter);
safeAddEvent(els.importCharBtn, "click", () => els.importCharInput?.click());
safeAddEvent(els.importCharInput, "change", handleImportCharacter);

// === DM Options (Host Admin) ===
function handleDMOptions() {
	const modal = document.getElementById("dmAuthModal");
	const statusEl = document.getElementById("dmAuthStatus");
	const uploadBtn = document.getElementById("dmAuthUploadBtn");
	const fileInput = document.getElementById("hostCharFileInput");
	if (!modal || !fileInput) return;

	statusEl.textContent = "";
	statusEl.style.color = "";
	uploadBtn.disabled = false;
	modal.style.display = "flex";

	fileInput.value = "";
	fileInput.onchange = async (e) => {
		const file = e.target.files?.[0];
		if (!file) return;
		uploadBtn.disabled = true;
		statusEl.style.color = "#aaa";
		statusEl.textContent = "Verifying...";
		try {
			const text = await file.text();
			const charFile = JSON.parse(text);
			if (!charFile.data || !charFile.sig) {
				statusEl.style.color = "#f44";
				statusEl.textContent = "Invalid file — not a .stchar character export.";
				uploadBtn.disabled = false;
				return;
			}
			const res = await fetch("/api/admin/host-verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ lobbyCode, data: charFile.data, sig: charFile.sig }),
			});
			const result = await res.json();
			if (!res.ok) {
				statusEl.style.color = "#f44";
				statusEl.textContent = result.error || "Verification failed.";
				uploadBtn.disabled = false;
				return;
			}
			statusEl.style.color = "#4caf50";
			statusEl.textContent = "Verified! Opening DM tools...";
			const parsed = JSON.parse(atob(charFile.data));
			const characterId = parsed.sheet?.characterId;
			setTimeout(() => {
				modal.style.display = "none";
				window.open(`/admin/admin.html?host=1&lobby=${encodeURIComponent(lobbyCode)}&charId=${encodeURIComponent(characterId)}`, "_blank");
			}, 600);
		} catch (err) {
			statusEl.style.color = "#f44";
			statusEl.textContent = "Failed to read file: " + err.message;
			uploadBtn.disabled = false;
		}
	};
}
safeAddEvent(document.getElementById("dmOptionsBtn"), "click", handleDMOptions);
safeAddEvent(document.getElementById("dmAuthUploadBtn"), "click", () => {
	document.getElementById("hostCharFileInput")?.click();
});
// dmAuthCancelBtn removed — handled by centralized .modal-close

// === End Campaign ===
function handleEndCampaign() {
	if (!confirm("Mark this campaign as completed (Victory)? This cannot be undone.")) return;
	socket.emit("game:end", { lobbyId });
}
safeAddEvent(els.endCampaignBtn, "click", handleEndCampaign);

// === Help Modal ===
safeAddEvent(document.getElementById("helpBtn"), "click", () => {
	document.getElementById("helpModal").style.display = "flex";
});
// Close on backdrop click
safeAddEvent(document.getElementById("helpModal"), "click", (e) => {
	if (e.target === document.getElementById("helpModal"))
		document.getElementById("helpModal").style.display = "none";
});
