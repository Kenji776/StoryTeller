const socket = io();
window.socket = socket; // exposed for popup windows (options, etc.)

let lobbyId = null;
let lobbyCode = null;
let me = { name: null };
let currentState = null;
let iAmHost = false;
let ready = false;
let joiningInProgress = false; // true when creating a new char to join a running game
let pendingJoinCode = null;    // lobby code for the in-progress game being joined


// === Global modal close handler ===
// Any button with class "modal-close" will close its parent modal
// (works for both static display:none modals and dynamically appended ones)
document.addEventListener("click", (e) => {
	const btn = e.target.closest(".modal-close");
	if (!btn) return;
	const modal = btn.closest(".modal, .add-modal");
	if (!modal) return;
	if (modal.id) { modal.style.display = "none"; } else { modal.remove(); }
});

let renderedHistoryCount = 0;
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const clientId = Math.random()
	.toString(36)
	.slice(2, 10);

const narratorIndicator = document.getElementById("narratorIndicator");
const narratorText = document.getElementById("narratorText");
const stopNarrationBtn = document.getElementById("stopNarrationBtn");

function showNarratorIndicator(show, text = "Narrating...") {
	narratorText.textContent = text;
	narratorIndicator.classList.toggle("hidden", !show);
}

/** === TOAST TEST (call testToasts() from browser console) === **/
function testToasts() {
	const samples = [
		["You gained 25 XP for slaying the goblin!", "success"],
		["Healing Potion removed from inventory", "warning"],
		["You took 8 damage from a fire trap", "danger"],
		["The DM sets the scene...", "info"],
		["Critical hit! Double damage!", "success"],
		["A mysterious figure watches from the shadows", "info"],
		["You found 50 gold coins", "success"],
		["Poisoned! -2 to all rolls for 3 turns", "danger"],
	];
	samples.forEach(([msg, type], i) => {
		setTimeout(() => showToast(msg, type, 6000), i * 400);
	});
}

/** === FANTASY TOAST STACKING === **/
const _toastState = { container: null, toasts: [] }; // tracks active toast elements in order
const _pendingToasts = []; // queued while UI lock overlay is showing
let _uiLocked = false;    // true while the "Resolving Action" overlay is visible

function _reflowToasts() {
	const GAP = 10;
	const baseTopVh = 10; // starting position in vh
	const basePx = (baseTopVh / 100) * window.innerHeight;
	let cursor = basePx;
	for (const t of _toastState.toasts) {
		t.style.top = `${cursor}px`;
		cursor += t.offsetHeight + GAP;
	}
}

function showToast(message, type = "info", duration = 4000) {
	// While the "Resolving Action" overlay is visible, queue toasts so the
	// player can actually see them once the overlay disappears.
	if (_uiLocked) {
		_pendingToasts.push({ message, type, duration });
		return;
	}

	// Get or create container
	if (!_toastState.container || !_toastState.container.isConnected) {
		const container = document.createElement("div");
		container.id = "toastContainer";
		container.style.cssText = "position:fixed;top:0;left:0;width:100%;height:0;z-index:9999;pointer-events:none;";
		document.body.appendChild(container);
		_toastState.container = container;
	}
	const container = _toastState.container;

	// Create new toast
	const toast = document.createElement("div");
	toast.className = `toast ${type}`;
	toast.innerHTML = `<div class="toast-content"><p>${message}</p></div>`;
	container.appendChild(toast);

	// Track it and reflow so it lands below existing toasts
	_toastState.toasts.push(toast);
	_reflowToasts();

	// Animate in
	requestAnimationFrame(() => toast.classList.add("visible"));

	// Auto-remove after duration
	setTimeout(() => {
		toast.classList.remove("visible");
		setTimeout(() => {
			toast.remove();
			_toastState.toasts = _toastState.toasts.filter(t => t !== toast);
			_reflowToasts();
			if (!container.children.length) { container.remove(); _toastState.container = null; }
		}, 600);
	}, duration);
}


/** === DEV MODE: Quick Start === **/
async function handleQuickStart() {
	showLoading("⚡ Quick-starting test game...");

	// 1. Create lobby
	socket.emit("lobby:create", {});

	// 2. Wait for lobby creation, then set up character and start
	socket.once("lobby:created", async ({ lobbyId: id, code }) => {
		lobbyId = id;
		lobbyCode = code;
		iAmHost = true;
		show(els.lobby);
		enterLobbyMode(code);

		// 3. Randomize and save character
		await randomizeCharacter();
		me.name = (document.getElementById("name")?.value || "").trim() || "TestHero";
		const sheet = buildCurrentSheet();
		socket.emit("player:sheet", { lobbyId, name: me.name, sheet });

		// 4. Small delay to let server process the sheet
		await new Promise(r => setTimeout(r, 300));

		// 5. Emit quickstart — server sets LLM to test + marks ready
		socket.emit("game:quickstart", { lobbyId });

		// 6. Server signals ready — now start the game via normal flow
		socket.once("game:quickstart:ready", () => {
			socket.emit("game:start", { lobbyId });
		});
	});
}

/** === Quick Start (public — real LLM) === **/
async function handleQuickStartPublic() {
	const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

	// Load campaign flavors
	let flavors;
	try {
		const res = await fetch("/config/campaignFlavors.json");
		flavors = await res.json();
	} catch { showToast("Failed to load campaign options", "danger"); return; }

	const settings = [
		{ id: "standard",  label: "High Fantasy", emoji: "🏰" },
		{ id: "dark_ages", label: "Dark Ages",    emoji: "⚔️" },
		{ id: "steampunk", label: "Steampunk",    emoji: "⚙️" },
		{ id: "pirate",    label: "Pirate Age",   emoji: "🏴‍☠️" },
		{ id: "scifi",     label: "Sci-fi Fantasy",emoji: "🚀" },
	];
	const difficulties = [
		{ id: "casual",   label: "Casual" },
		{ id: "standard", label: "Standard" },
		{ id: "hardcore", label: "Hardcore" },
	];

	const tone    = pick(flavors.tones);
	const theme   = pick(flavors.themes);
	const setting = pick(settings);
	const diff    = pick(difficulties);
	const brutal  = Math.floor(Math.random() * 7) + 2; // 2-8 range, avoid extremes
	const brutalityLabels = ["Kid Safe","Kid Safe","Lighthearted","Lighthearted","Standard","Standard","Gritty","Gritty","Brutal","Brutal","Ultimate Brutality"];

	// Build summary modal
	const modal = document.createElement("div");
	modal.className = "modal";
	modal.innerHTML = `
		<div class="modal-content">
			<button class="modal-close">✕</button>
			<h2>🎲 Quick Start</h2>
			<p style="color:#aaa;font-size:0.9em;text-align:center;">Your randomized adventure awaits!</p>
			<hr/>
			<div style="display:grid;grid-template-columns:auto 1fr;gap:0.4em 1em;font-size:0.92em;align-items:center;">
				<span style="color:#888;">World</span>   <strong>${setting.emoji} ${setting.label}</strong>
				<span style="color:#888;">Tone</span>    <strong>${tone.emoji} ${tone.label}</strong>
				<span style="color:#888;">Theme</span>   <strong>${theme.emoji} ${theme.label}</strong>
				<span style="color:#888;">Difficulty</span> <strong>🎯 ${diff.label}</strong>
				<span style="color:#888;">Intensity</span>  <strong>⚡ ${brutalityLabels[brutal]}</strong>
			</div>
			<hr/>
			<p style="font-size:0.82em;color:#888;text-align:center;">A random character will be created for you.</p>
			<div class="row" style="justify-content:center;gap:0.75em;margin-top:0.75em;">
				<button id="qsReroll" class="secondary">🎲 Reroll</button>
				<button id="qsConfirm" class="primary">⚔️ Begin Adventure</button>
			</div>
		</div>`;
	document.body.appendChild(modal);

	// Reroll just reopens with new random picks
	modal.querySelector("#qsReroll").addEventListener("click", () => {
		modal.remove();
		handleQuickStartPublic();
	});

	// Confirm — create lobby, set options, randomize char, start
	modal.querySelector("#qsConfirm").addEventListener("click", async () => {
		modal.remove();
		showLoading("🎲 Preparing your adventure...");

		// 1. Create lobby
		socket.emit("lobby:create", {});

		socket.once("lobby:created", async ({ lobbyId: id, code }) => {
			lobbyId = id;
			lobbyCode = code;
			iAmHost = true;
			show(els.lobby);
			enterLobbyMode(code);

			// 2. Set game options
			socket.emit("lobby:settings", {
				lobbyId,
				campaignTone:    { id: tone.id,  label: tone.label,  emoji: tone.emoji,  prompt: tone.prompt },
				campaignTheme:   { id: theme.id, label: theme.label, emoji: theme.emoji, prompt: theme.prompt },
				campaignSetting: setting.id,
				difficulty:      diff.id,
				brutalityLevel:  brutal,
			});

			// 3. Randomize and save character
			await randomizeCharacter();
			me.name = (document.getElementById("name")?.value || "").trim() || "Adventurer";
			const sheet = buildCurrentSheet();
			socket.emit("player:sheet", { lobbyId, name: me.name, sheet });

			// 4. Wait for server to process
			await new Promise(r => setTimeout(r, 400));

			// 5. Ready up and start
			socket.emit("player:ready", { lobbyId, ready: true });
			await new Promise(r => setTimeout(r, 200));
			socket.emit("game:start", { lobbyId });
		});
	});
}

document.getElementById("quickStartPublicBtn")?.addEventListener("click", handleQuickStartPublic);

// Fetch voices from the server
async function loadVoices() {
	try {
		const res = await fetch("/api/voices");
		const data = await res.json();
		if (!data.ok) throw new Error("Failed to load voices");

		voiceSelect.innerHTML = data.voices.map((v) => `<option value="${v.id}">${v.name}${v.accent ? ` (${v.accent})` : ""}</option>`).join("");
	} catch (err) {
		console.error("Voice load failed:", err);
		voiceSelect.innerHTML = '<option value="">Error loading voices</option>';
	}
}

voiceSelect.addEventListener("change", (e) => {
	selectedVoiceId = e.target.value;
	console.log("🎤 Selected voice:", selectedVoiceId);
});





document.addEventListener("DOMContentLoaded", () => {
	window.overlay = document.getElementById("loadingOverlay");

	// Delegated click handler for party member names in the game screen.
	// drawPartyComponent rebuilds innerHTML on each update so we delegate
	// from the stable container element instead of attaching per-row.
	document.getElementById("partyContainer")?.addEventListener("click", (e) => {
		const cell = e.target.closest("[data-player]");
		if (!cell) return;
		const name = cell.dataset.player;
		const sheet = currentState?.players?.[name];
		showCharacterModal(name, sheet, null);
	});
});

function showLoading(message = "Starting Adventure...") {
	const o = window.overlay;
	if (!o) {
		console.warn("[showLoading] overlay not found yet");
		return;
	}
	o.querySelector("h2").textContent = "🌙 The Fates are Weaving Your Tale...";
	o.querySelector("p").textContent = message;
	o.classList.remove("hidden");
}

function hideLoading() {
	const o = window.overlay;
	if (!o) return;
	o.classList.add("hidden");
}

function show(section) {
	els.landing.classList.add("hidden");
	els.lobby.classList.add("hidden");
	els.game.classList.add("hidden");
	section.classList.remove("hidden");
}

function renderState(s) {
	currentState = s;
	window.currentState = s; // exposed for popup windows
	if (!s) return;

	// === Phase Badge & Lobby Code ===
	els.phaseBadge.textContent = s.phase?.toUpperCase() || "—";
	els.lobbyCode.textContent = s.code ? `#${s.code}` : "";

	// === Render Lobby Game Options Panel ===
	renderLobbyOptions(s);

	// === Render Players List ===
	renderPlayers(s);

	// === Render Our Own Sheet (stats, abilities, etc.) ===
	renderSheet(s);

	// === Render phase-specific UI ===
	renderPhaseUI(s);

	// === Auto-show game UI if running ===
	if (s.phase === "running") {
		show(els.game);
		const turnName = s.initiative?.[s.turnIndex] || null;
		els.turnBanner.textContent = `Turn: ${turnName || "—"}`;
		setActionInputForTurn(turnName);

		// Adventure title + lobby code in game header
		const titleEl = document.getElementById("adventureTitle");
		if (titleEl) titleEl.textContent = s.adventureName || "Adventure";
		const codeEl = document.getElementById("gameLobbyCode");
		if (codeEl) codeEl.textContent = s.code ? `Code: ${s.code}` : "";
	}
}

/**
 * Open the character info modal.
 * @param {string} name - Player name
 * @param {object} sheet - Full player sheet from state.players
 * @param {boolean|null} ready - Ready status (null to hide the status row, e.g. during gameplay)
 */
function showCharacterModal(name, sheet, ready) {
	if (!sheet) return alert("No character sheet available yet.");

	document.querySelectorAll(".modal").forEach((m) => m.remove());

	const modal = document.createElement("div");
	modal.className = "modal";
	modal.innerHTML = `
		<div class="modal-content">
			<button class="modal-close">✕</button>
			${sheet.imageUrl ? `<img src="${sheet.imageUrl}" alt="Portrait of ${name}" style="width:100%;border-radius:6px;margin-bottom:10px;display:block;" />` : ""}
			<h2>🧝 ${name}</h2>
			<h4>${sheet.race || "Unknown Race"} ${sheet.class || "Adventurer"}</h4>
			${sheet.alignment || sheet.background ? `<p class="smalltext"><strong>${sheet.alignment || ""}</strong> ${sheet.background ? "— " + sheet.background : ""}</p>` : ""}
			<hr/>
			<div class="grid two smalltext">
				<div>
					<p><strong>Level:</strong> ${sheet.level ?? 1}</p>
					<p><strong>HP:</strong> ${sheet.stats?.hp ?? 10}</p>
					${ready !== null ? `<p><strong>Status:</strong> ${ready ? "✅ Ready" : "⌛ Not Ready"}</p>` : ""}
				</div>
				<div>
					${sheet.deity ? `<p><strong>Deity:</strong> ${sheet.deity}</p>` : ""}
					${sheet.gender ? `<p><strong>Gender:</strong> ${sheet.gender}</p>` : ""}
					${sheet.age ? `<p><strong>Age:</strong> ${sheet.age}</p>` : ""}
				</div>
			</div>
			${sheet.height || sheet.weight ? `<p class="smalltext"><strong>Build:</strong> ${sheet.height || "?"}, ${sheet.weight || "?"}</p>` : ""}
			<hr/>
			<h4>Attributes</h4>
			<div class="grid three smalltext attrs">
				${Object.entries(sheet.stats || {}).map(([k, v]) => `<div><strong>${k.toUpperCase()}:</strong> ${v}</div>`).join("")}
			</div>
			<hr/>
			<div class="grid two smalltext" style="gap:0.5em;">
				<div>
					<p style="margin:0 0 0.25em;"><strong>⚔️ Weapon</strong></p>
					${sheet.weapon
						? `<p style="margin:0;">${sheet.weapon.name}</p>
						   <p style="margin:0;color:#aaa;">${sheet.weapon.damage} ${sheet.weapon.damageType} &bull; ${sheet.weapon.range || "melee"}</p>`
						: `<p style="margin:0;color:#777;">None selected</p>`}
				</div>
				<div>
					<p style="margin:0 0 0.25em;"><strong>🛡️ Armor</strong></p>
					${sheet.armor
						? `<p style="margin:0;">${sheet.armor.name}</p>
						   <p style="margin:0;color:#aaa;">AC ${sheet.armor.ac} &bull; ${sheet.armor.type}</p>
						   <p style="margin:0;color:#666;font-size:0.8em;">${sheet.armor.note || ""}</p>`
						: `<p style="margin:0;color:#777;">None selected</p>`}
				</div>
			</div>
			<hr/>
			<h4>Abilities & Spells</h4>
			<ul>${(sheet.abilities || []).map((a) =>
				typeof a === "string"
					? `<li>${a}</li>`
					: `<li><strong>${a.name}</strong>${a.description ? ` — ${a.description}` : ""}</li>`
			).join("") || "<li class='hint'>None</li>"}</ul>
			<hr/>
			<h4>Inventory</h4>
			<ul>${(sheet.inventory || []).map((i) =>
				typeof i === "string"
					? `<li>${i}</li>`
					: `<li>${i.name}${i.count > 1 ? ` ×${i.count}` : ""}${i.description ? ` <span class="smalltext">— ${i.description}</span>` : ""}</li>`
			).join("") || "<li class='hint'>Empty</li>"}</ul>
			<hr/>
			<h4>Backstory</h4>
			<p class="smalltext italic">${sheet.description || "<em>No backstory yet.</em>"}</p>
		</div>
	`;
	document.body.appendChild(modal);
}

function renderLobbyOptions(s) {
	const el = document.getElementById("lobbyGameOptions");
	if (!el) return;

	// Only show during waiting phase
	if (s.phase !== "waiting") {
		el.innerHTML = "";
		return;
	}

	const brutalityLabels = ["Kid Safe","Kid Safe","Lighthearted","Lighthearted","Standard","Standard","Gritty","Gritty","Brutal","Brutal","Ultimate Brutality"];
	const brutalityColors = (n) => n <= 2 ? "#4a9a4a" : n <= 4 ? "#8a8a20" : n <= 6 ? "#9a8050" : n <= 8 ? "#9a4a20" : "#9a2020";
	const bLevel = s.brutalityLevel ?? 5;

	const SETTING_LABELS  = { standard: "⚔️ Standard Fantasy", dark_ages: "🏚️ Dark Ages", steampunk: "⚙️ Steampunk", pirate: "🏴‍☠️ Pirate Age", scifi: "🚀 Sci-fi Fantasy" };
	const DIFF_LABELS     = { casual: "🌸 Casual", standard: "⚔️ Standard", hardcore: "💀 Hardcore", merciless: "☠️ Merciless" };
	const LOOT_LABELS     = { sparse: "💰 Sparse", fair: "💎 Fair", generous: "🎁 Generous" };

	const voiceName = s.narratorVoiceName || (s.narratorVoiceId ? "Custom Voice" : "Default");
	const rows = [
		s.campaignTone  ? `<div class="lgo-row"><span class="lgo-key">Tone</span><span class="lgo-val">${s.campaignTone.emoji} ${s.campaignTone.label}</span></div>` : "",
		s.campaignTheme ? `<div class="lgo-row"><span class="lgo-key">Theme</span><span class="lgo-val">${s.campaignTheme.emoji} ${s.campaignTheme.label}</span></div>` : "",
		`<div class="lgo-row"><span class="lgo-key">Setting</span><span class="lgo-val">${SETTING_LABELS[s.campaignSetting || "standard"]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Difficulty</span><span class="lgo-val">${DIFF_LABELS[s.difficulty || "standard"]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Loot</span><span class="lgo-val">${LOOT_LABELS[s.lootGenerosity || "fair"]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Intensity</span><span class="lgo-val" style="color:${brutalityColors(bLevel)};">⚡ ${brutalityLabels[bLevel]}</span></div>`,
		`<div class="lgo-row"><span class="lgo-key">Narrator</span><span class="lgo-val">🎙 ${voiceName}</span></div>`,
		s.timerEnabled
			? `<div class="lgo-row"><span class="lgo-key">Turn Timer</span><span class="lgo-val">⏱ ${s.timerMinutes} min &nbsp;·&nbsp; kick after ${s.maxMissedTurns} missed</span></div>`
			: `<div class="lgo-row"><span class="lgo-key">Turn Timer</span><span class="lgo-val lgo-muted">Off</span></div>`,
	].filter(Boolean).join("");

	el.innerHTML = `
		<div class="lgo-panel">
			<div class="lgo-title">Campaign Settings</div>
			${rows}
		</div>
	`;
}

function renderPlayers(s) {
	els.playersList.innerHTML = "";
	const wrap = document.createElement("div");

	(s.connected || []).forEach((p) => {
		const d = document.createElement("div");
		const icon = p.ready ? "✅" : "⌛";

		// Retrieve sheet data if available
		const sheet = s.players?.[p.name];
		const race = sheet?.race || "";
		const cls = sheet?.class || "";
		const raceClass = race || cls ? ` (${[race, cls].filter(Boolean).join(" ")})` : "";

		const canKick = iAmHost && me.name !== p.name;
		const hostBadge = p.name && p.name === s.hostPlayer ? ' <span title="Game Host">👑</span>' : "";
		d.innerHTML = `
			<span class="player-entry" data-player="${p.name}" style="flex:1;">
				${icon} <strong>${p.name || "(unnamed)"}</strong>${hostBadge}${raceClass}
			</span>
			${canKick ? `<button class="kick-btn" data-player="${p.name}" title="Kick player">✕</button>` : ""}
		`;
		d.style.cssText = "display:flex;align-items:center;gap:0.5em;";

		// Clicking opens modal with full sheet
		d.querySelector(".player-entry").addEventListener("click", () => {
			showCharacterModal(p.name, sheet, p.ready);
		});

		if (canKick) {
			d.querySelector(".kick-btn").addEventListener("click", (e) => {
				e.stopPropagation();
				if (confirm(`Kick ${p.name} from the lobby?`)) {
					socket.emit("player:kick", { lobbyId, playerName: p.name });
				}
			});
		}

		wrap.appendChild(d);
	});

	els.playersList.appendChild(wrap);
}

function renderSheet(s) {
	const p = me?.name ? s.players?.[me.name] : null;

	// If not in a game or player not found
	if (!p) {
		if (els.yourSheet) els.yourSheet.textContent = "Save your character to see your sheet.";
		return;
	}

	// Restore portrait from server state (e.g. after page reload)
	if (p.imageUrl && typeof showCharacterImage === "function") {
		const alreadyShown = els.charImagePreview && !els.charImagePreview.classList.contains("hidden");
		if (!alreadyShown) showCharacterImage(p.imageUrl);
	}

	// Try updating the new game UI if it exists
	const nameEl = document.getElementById("charName");
	if (nameEl) {
		// === BASIC INFO ===
		nameEl.textContent = p.name || "—";
		const raceClsEl = document.getElementById("charRaceCls");
		raceClsEl.textContent = `${p.race || ""} ${p.class || ""}`.trim() || "—";
		document.getElementById("charLevel").textContent = `Lv ${p.level || 1}`;
		document.getElementById("charHP").textContent = p.stats?.hp ?? 10;
		document.getElementById("charXP").textContent = p.xp ?? 0;
		const goldEl = document.getElementById("charGold");
		if (goldEl) goldEl.textContent = p.gold ?? 0;
		const maxSlots = Number(p.level) || 1;
		const slotsLeft = Math.max(0, maxSlots - (Number(p.spellSlotsUsed) || 0));
		document.getElementById("charSpellSlots").textContent = `${slotsLeft}/${maxSlots}`;

		// XP bar
		const thresholds = [0, 300, 900, 2700, 6500];
		const level = p.level || 1;
		const next = thresholds[level] || 99999;
		const prev = thresholds[level - 1] || 0;
		const percent = Math.min(100, ((p.xp - prev) / (next - prev)) * 100);
		const fill = document.getElementById("xpFillGame");
		const label = document.getElementById("xpLabelGame");
		if (fill) fill.style.width = `${percent}%`;
		if (label) label.textContent = `${p.xp || 0} / ${next} XP`;

		// === ATTRIBUTES ===
		const statMap = {
			STR: p.stats?.str ?? 10,
			DEX: p.stats?.dex ?? 10,
			CON: p.stats?.con ?? 10,
			INT: p.stats?.int ?? 10,
			WIS: p.stats?.wis ?? 10,
			CHA: p.stats?.cha ?? 10,
		};
		Object.entries(statMap).forEach(([k, v]) => {
			const el = document.getElementById(`attr${k}`);
			if (el) el.textContent = v;
		});

		// === WEAPON & ARMOR ===
		const weaponNameEl  = document.getElementById("charWeaponName");
		const weaponStatsEl = document.getElementById("charWeaponStats");
		const armorNameEl   = document.getElementById("charArmorName");
		const armorStatsEl  = document.getElementById("charArmorStats");
		if (weaponNameEl)  weaponNameEl.textContent  = p.weapon ? p.weapon.name : "None";
		if (weaponStatsEl) weaponStatsEl.textContent = p.weapon ? `${p.weapon.damage} ${p.weapon.damageType} · ${p.weapon.range || "melee"}` : "—";
		if (armorNameEl)   armorNameEl.textContent   = p.armor  ? p.armor.name  : "None";
		if (armorStatsEl)  armorStatsEl.textContent  = p.armor  ? `AC ${p.armor.ac} · ${p.armor.type}` : "—";

		// === ABILITIES & INVENTORY — use component renderers so display is always current ===
		drawAbilitiesComponent("gameAbilitiesContainer", p.abilities || [], false, true);
		drawInventoryComponent("gameInventoryContainer", p.inventory || [], false);
	} else {
		// Fallback: old lobby preview
		const stats = Object.entries(p.stats || {})
			.map(([k, v]) => `${k}: ${v}`)
			.join(", ");
		els.yourSheet.innerHTML = `
      <strong>${p.name}</strong> — ${p.class} (L${p.level})<br/>
      ${p.description ? p.description + "<br/>" : ""}
      <em>Stats</em>: ${stats || "—"}<br/>
      <em>Inventory</em>: ${(p.inventory || []).join(", ") || "—"}<br/>
      <em>Abilities</em>: ${(p.abilities || []).join(", ") || "—"}<br/>
    `;
	}
}

function renderPhaseUI(s) {
	const isPreGame = ["waiting", "characterCreation", "readyCheck"].includes(s.phase);
	const isRunning = s.phase === "running";

	// Host controls
	const hostOnly = (btn) => btn.classList.toggle("hidden", !iAmHost || isRunning);
	hostOnly(els.phaseReady);
	hostOnly(els.startGame);
	if (els.openOptionsBtn) els.openOptionsBtn.classList.toggle("hidden", !iAmHost || isRunning);
	if (els.endCampaignBtn) els.endCampaignBtn.classList.toggle("hidden", !iAmHost || !isRunning);
	const dmBtn = document.getElementById("dmOptionsBtn");
	if (dmBtn) dmBtn.classList.toggle("hidden", !iAmHost || !isRunning);

	// Disable Start Game until every named connected player is ready
	if (iAmHost && !isRunning) {
		const named = (s.connected || []).filter((p) => p.name);
		const readyCount = named.filter((p) => p.ready).length;
		const allReady = named.length > 0 && readyCount === named.length;
		els.startGame.disabled = !allReady;
		els.startGame.title = allReady
			? ""
			: `Waiting for players to ready up (${readyCount}/${named.length} ready)`;
	}

	if (isPreGame) {
		show(els.lobby);
	} else if (isRunning) {
		show(els.game);
	}

	els.phaseBadge.textContent = s.phase?.toUpperCase() || "—";
}

function renderLogs(state) {
	if (!state) return;

	const story = document.getElementById("storyLog");
	if (story) {
		// Only render NEW entries from state.history
		const history = state.history || [];
		console.log("Got history");
		console.log(state.history);

		const pinnedIndices = new Set((state.pinnedMoments || []).map(p => p.index));

		for (let i = renderedHistoryCount; i < history.length; i++) {

			const entry = history[i];
			if(!entry?.content || entry?.content.length === 0) continue;

			const div = document.createElement("div");
			div.dataset.historyIndex = i;

			if (entry.role === "assistant") {
				div.className = "dm-entry";
				let entryContent = entry.content || "";
				if (entryContent.trim().startsWith("{")) {
					try {
						const parsed = JSON.parse(entryContent);
						if (typeof parsed.text === "string") entryContent = parsed.text;
					} catch {}
				}
				div.innerHTML = `🧙‍♂️ <strong>DM:</strong> ${entryContent}`;
			} else if (entry.role === "user") {
				div.className = "player-entry";
				div.innerHTML = `<strong>${entry.name}:</strong> ${entry.content}`;
			} else {
				div.className = "story-entry";
				div.textContent = entry.content;
			}

			// Pin button
			if (pinnedIndices.has(i)) div.classList.add("pinned");
			const pinBtn = document.createElement("button");
			pinBtn.className = "pin-moment-btn";
			pinBtn.title = "Pin this moment";
			pinBtn.textContent = "📌";
			pinBtn.onclick = () => {
				const idx = Number(div.dataset.historyIndex);
				const isPinned = div.classList.toggle("pinned");
				if (isPinned) {
					socket.emit("story:pin", { lobbyId, historyIndex: idx });
				} else {
					socket.emit("story:unpin", { lobbyId, historyIndex: idx });
				}
			};
			div.appendChild(pinBtn);

			story.appendChild(div);
		}

		renderedHistoryCount = history.length;
		story.scrollTop = story.scrollHeight;
	}
}

function appendLog(text, historyIndex) {
	const logContainer = text.match(/^\[.*\]/) ? els.actionLog : els.storyLog;
	const div = document.createElement("div");
	let cls = "story-entry";

	// === Event classification ===
	if (text.startsWith("> ")) {
		cls += " player-action";
		text = text.replace(/^>\s*/, "");
	} else if (/🎖️|XP|XP_GAIN/.test(text)) {
		cls += " xp-event";
	} else if (/🎒|INVENTORY|item/i.test(text)) {
		cls += " inventory-event";
	} else if (/🎉|level ?up|LEVEL ?UP/i.test(text)) {
		cls += " levelup-event";
	} else if (/DM:|Dungeon Master/i.test(text)) {
		cls += " dm-narration";
	} else if (/^\[.*\]/.test(text)) {
		cls += " system";
	}

	div.className = cls;

	// Add pin button for story entries with a known history index
	if (historyIndex != null && logContainer === els.storyLog) {
		div.dataset.historyIndex = historyIndex;
		const pinBtn = document.createElement("button");
		pinBtn.className = "pin-moment-btn";
		pinBtn.title = "Pin this moment";
		pinBtn.textContent = "📌";
		pinBtn.onclick = () => {
			const idx = Number(div.dataset.historyIndex);
			const isPinned = div.classList.toggle("pinned");
			if (isPinned) {
				socket.emit("story:pin", { lobbyId, historyIndex: idx });
			} else {
				socket.emit("story:unpin", { lobbyId, historyIndex: idx });
			}
		};
		div.appendChild(pinBtn);
	}

	div.insertAdjacentHTML("afterbegin", text);
	logContainer.appendChild(div);
	logContainer.scrollTop = logContainer.scrollHeight;
}

// (showNarratorIndicator is defined near the top of this file)

/** === Renders player inventory (object-based) === */
function renderInventoryList(inv = []) {
	const listEl = document.getElementById("charInventory");
	listEl.innerHTML = "";

	if (!inv.length) {
		listEl.innerHTML = `<li class="hint">Empty</li>`;
		return;
	}

	for (const obj of inv) {
		const li = document.createElement("li");
		li.classList.add("inventory-item");
		let tooltip = "";
		if (obj.description) tooltip += `<div class='desc'>${obj.description}</div>`;
		if (obj.attributes && Object.keys(obj.attributes).length) {
			const attrLines = Object.entries(obj.attributes)
				.map(([k, v]) => `<div class='attr'>${k}: ${v}</div>`)
				.join("");
			tooltip += `<div class='attrs'>${attrLines}</div>`;
		}
		li.innerHTML = `<strong>${obj.name}</strong> ×${obj.count || 1}${tooltip}`;
		listEl.appendChild(li);
	}
}

function hideDeathModal() {
	const modal = document.getElementById("deathModal");
	modal.classList.remove("active");
	document.querySelectorAll("input, button, select, textarea").forEach((el) => {
		el.disabled = false;
		el.classList.remove("disabled");
	});
	// Re-apply turn gate — action input should only be enabled on the player's own turn
	setActionInputForTurn(currentTurnPlayer);
}

function showDeathModal() {
	// Show the modal
	document.getElementById("deathModal").classList.add("active");

	// Disable gameplay UI but keep chat functional
	const gameplayInputs = document.querySelectorAll(
		"#actionInput, #actionButton, #quickActionSelect, .dice-btn, #micBtn"
	);
	gameplayInputs.forEach((el) => {
		if (el) {
			el.disabled = true;
			el.classList.add("disabled");
		}
	});

	// Optionally: play a dramatic sound or fade out background music
	if (typeof playSound === "function") {
		playSound("death");
	}

	// Auto-dismiss the death overlay after 15 seconds
	setTimeout(() => {
		document.getElementById("deathModal").classList.remove("active");
	}, 15000);
}

// === Speech to Text (Web Speech API) ===
let recognition;
const micBtn = document.getElementById("micBtn");

if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	recognition = new SpeechRecognition();
	recognition.lang = "en-US";
	recognition.continuous = false;
	recognition.interimResults = true;

	recognition.onstart = () => {
		micBtn.textContent = "🛑";
		micBtn.classList.add("listening");
		appendLog("[🎤] Listening...");
	};

	recognition.onend = () => {
		micBtn.textContent = "🎤";
		micBtn.classList.remove("listening");
	};

	recognition.onerror = (event) => {
		console.error("[SpeechRecognition] Error:", event.error);
		appendLog(`[Speech Error] ${event.error}`);
		micBtn.textContent = "🎤";
		micBtn.classList.remove("listening");
	};

	recognition.onresult = (event) => {
		let transcript = "";
		for (let i = event.resultIndex; i < event.results.length; ++i) {
			transcript += event.results[i][0].transcript;
		}
		els.actionInput.value = transcript.trim();
	};

	micBtn.addEventListener("click", () => {
		try {
			if (micBtn.classList.contains("listening")) {
				recognition.stop();
			} else {
				recognition.start();
			}
		} catch (err) {
			console.error("Speech recognition failed to start:", err);
			alert("Speech recognition not available: " + err.message);
		}
	});
} else {
	micBtn.disabled = true;
	micBtn.title = "Speech recognition not supported in this browser";
	appendLog("[!] Speech recognition not supported in this browser.");
}



//ui lock
// === UI Lock / Wait Overlay ===
const uiLock = document.createElement("div");
uiLock.id = "uiLock";
uiLock.classList.add("hidden");
uiLock.innerHTML = `
  <div class="overlay-content">
    <h2>⏳ Resolving Action...</h2>
    <p id="uiLockMessage">Waiting for the Dungeon Master to respond.</p>
  </div>
`;
uiLock.style.cssText = `
  position: fixed; inset: 0;
  background: rgba(10,10,20,0.8);
  color: #fff; z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  text-align: center; font-family: 'Cinzel', serif;
`;
uiLock.querySelector(".overlay-content").style.cssText = `
  background: rgba(20,20,40,0.9);
  padding: 2em 3em;
  border-radius: 1em;
  box-shadow: 0 0 20px rgba(150,150,255,0.5);
`;
document.body.appendChild(uiLock);

let currentTurnPlayer = null;

function setActionInputForTurn(current) {
	currentTurnPlayer = current || null;
	const myTurn = current && me.name && current === me.name;
	if (els.actionInput) {
		els.actionInput.disabled = !myTurn;
		els.actionInput.title = myTurn || !current ? "" : `Waiting for ${current}'s turn`;
	}
	if (els.sendAction) els.sendAction.disabled = !myTurn;
}

let _restVoteInterval = null;

function clearRestVoteTimer() {
	if (_restVoteInterval) {
		clearInterval(_restVoteInterval);
		_restVoteInterval = null;
	}
	const timerEl = document.getElementById("restVoteTimerDisplay");
	if (timerEl) timerEl.textContent = "";
}

function updateRestVoteModal(state, open) {
	const { type, proposer, yesVotes, noVotes, pending } = state;
	const modal   = document.getElementById("restVoteModal");
	const title   = document.getElementById("restVoteTitle");
	const desc    = document.getElementById("restVoteDesc");
	const yesEl   = document.getElementById("voteYesCount");
	const noEl    = document.getElementById("voteNoCount");
	const waitEl  = document.getElementById("votePendingCount");
	const namesEl = document.getElementById("restVoteNames");
	const btnsEl  = document.getElementById("restVoteBtns");
	const timerEl = document.getElementById("restVoteTimerDisplay");

	if (title) title.textContent = type === "long" ? "🛏️ Long Rest Proposed" : "⛺ Short Rest Proposed";
	if (desc)  desc.textContent  = `${proposer} wants the party to take a ${type === "long" ? "long" : "short"} rest.`;
	if (yesEl) yesEl.textContent = yesVotes.length;
	if (noEl)  noEl.textContent  = noVotes.length;
	if (waitEl) waitEl.textContent = pending.length;
	if (namesEl) {
		const parts = [
			...yesVotes.map(n => `✅ ${n}`),
			...noVotes.map(n => `❌ ${n}`),
			...pending.map(n => `⏳ ${n}`),
		];
		namesEl.textContent = parts.join("  ·  ");
	}

	// Show/hide vote buttons based on whether I've already voted
	const iHaveVoted = [...yesVotes, ...noVotes].includes(me.name);
	const imProposer = proposer === me.name;
	if (btnsEl) btnsEl.style.display = (iHaveVoted || imProposer) ? "none" : "";

	if (open && modal) {
		modal.style.display = "flex";
		// Start countdown timer from 120s
		clearRestVoteTimer();
		let secondsLeft = 120;
		if (timerEl) timerEl.textContent = `⏱ Vote closes in ${secondsLeft}s`;
		_restVoteInterval = setInterval(() => {
			secondsLeft--;
			if (secondsLeft <= 0) {
				clearRestVoteTimer();
				if (timerEl) timerEl.textContent = "⏱ Vote closed — tallying results…";
			} else {
				if (timerEl) timerEl.textContent = `⏱ Vote closes in ${secondsLeft}s`;
			}
		}, 1000);
	}
}

// Wire rest vote buttons (called once DOM is ready)
(function wireRestButtons() {
	document.getElementById("voteYesBtn")?.addEventListener("click", () => {
		socket.emit("rest:vote", { lobbyId, vote: "yes" });
		document.getElementById("restVoteBtns").style.display = "none";
	});
	document.getElementById("voteNoBtn")?.addEventListener("click", () => {
		socket.emit("rest:vote", { lobbyId, vote: "no" });
		document.getElementById("restVoteBtns").style.display = "none";
	});
})();

function lockUI(actorName) {
	_uiLocked = true;
	document.getElementById("uiLockMessage").textContent = `Waiting to resolve ${actorName}'s action...`;
	uiLock.classList.remove("hidden");
	els.actionInput.disabled = true;
	els.sendAction.disabled = true;
	document.querySelectorAll(".die").forEach((btn) => (btn.disabled = true));
	const qa = document.getElementById("quickActionSelect");
	if (qa) qa.disabled = true;
}

function unlockUI() {
	uiLock.classList.add("hidden");
	_uiLocked = false;

	// Flush any toasts that arrived while the overlay was up
	while (_pendingToasts.length) {
		const { message, type, duration } = _pendingToasts.shift();
		showToast(message, type, duration);
	}

	// Restore turn-based lock rather than blindly enabling for everyone
	setActionInputForTurn(currentTurnPlayer);
	// Dice stay disabled — only enabled when the DM explicitly requests a roll
	document.querySelectorAll(".die").forEach((btn) => (btn.disabled = true));
	const qa = document.getElementById("quickActionSelect");
	if (qa) qa.disabled = false;
}

function openChat() {
	const chatUrl = `/chat.html?lobbyId=${encodeURIComponent(lobbyId)}&name=${encodeURIComponent(me.name)}&clientId=${clientId}`;
	chatPopup = window.open(chatUrl, "PartyChat", "width=550,height=500");
}

function rigUI() {
	const statTips = {
		str: "Strength — affects melee damage and athletics.",
		dex: "Dexterity — affects agility, initiative, and stealth.",
		con: "Constitution — determines hit points and toughness.",
		int: "Intelligence — influences investigation and spellcasting.",
		wis: "Wisdom — governs perception and insight.",
		cha: "Charisma — drives persuasion and leadership.",
	};

	attrs.forEach((id) => {
		const num = document.getElementById(id);
		if (!num) return;
		const parent = num.parentElement;
		parent.setAttribute("title", statTips[id]);

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = "8";
		slider.max = "15";
		slider.value = num.value;
		slider.id = id + "_slider";
		slider.className = "attr-slider";

		const valueSpan = document.createElement("span");
		valueSpan.textContent = num.value;
		valueSpan.className = "attr-value";

		let prevValue = Number(slider.value);

		slider.addEventListener("input", () => {
			const newVal = Number(slider.value);

			// Calculate cost difference
			const currentSpent = calcPoints(); // current total
			const oldCost = costTable[prevValue] || 0;
			const newCost = costTable[newVal] || 0;
			const diff = newCost - oldCost;
			const remaining = basePoints - currentSpent;

			// Prevent overspending
			if (diff > remaining) {
				slider.value = prevValue; // revert
				flashPoints("⚠ Too few points!");
				return;
			}

			// Accept new value
			prevValue = newVal;
			num.value = newVal;
			valueSpan.textContent = newVal;
			updatePointsDisplay();
		});

		num.style.display = "none";
		parent.appendChild(slider);
		parent.appendChild(valueSpan);
	});

	sheetInputs.forEach((id) => {
		const el = document.getElementById(id) || document.getElementById(id + "_slider");
		if (!el) return;
		el.addEventListener("input", () => {
			if (ready) {
				ready = false;
				socket.emit("player:ready", { lobbyId, ready: false });
				els.toggleReady.textContent = "I'm Ready";
			}
			hasSavedSheet = false;

			els.toggleReady.disabled = true;
			els.toggleReady.title = "💾 Save your character before readying up.";
			els.toggleReady.classList.add("disabled-btn");
		});
	});

	const flavorTips = {
		alignment: "Your moral and ethical outlook.",
		background: "Your origin and pre-adventure life.",
		deity: "Patron god, spirit, or philosophy.",
		gender: "How your character identifies.",
		age: "Character's age in years.",
		height: "Height (use feet and inches).",
		weight: "Weight in pounds or kg.",
	};

	Object.entries(flavorTips).forEach(([id, tip]) => {
		const el = document.getElementById(id);
		if (el) el.setAttribute("title", tip);
	});
}

function showRejoinModal(lobbyCode, availableChars, hibernating = false) {
	const modal = document.createElement("div");
	modal.className = "modal";
	modal.style.zIndex = "100000";

	const statusNote = hibernating
		? `<p style="color:#f0a;margin-top:-0.5em;font-size:0.85em;">⏸ This adventure is paused — all players have left. Be the first back in!</p>`
		: "";

	const charCards = availableChars.map((c, i) => {
		const subtitle = [c.race, c.class].filter(Boolean).join(" ") || "Adventurer";
		const needsFile = !!c.characterId;
		return `
		<div class="rejoin-card" id="rejoin-card-${i}" data-char="${encodeURIComponent(JSON.stringify(c))}">
			<div class="rejoin-card-info">
				<strong>${c.name}</strong>
				<span class="rejoin-card-sub">Lv ${c.level} ${subtitle}</span>
			</div>
			<div class="rejoin-card-action">
				${needsFile
					? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
							<label class="rejoin-upload-btn" title="Upload your .stchar file to reclaim this character">
								📂 Upload .stchar
								<input type="file" accept=".stchar" style="display:none;" data-idx="${i}">
							</label>
							<span class="rejoin-status" id="rejoin-status-${i}" style="font-size:0.78em;text-align:right;max-width:160px;"></span>
						</div>`
					: `<button class="primary rejoin-claim-btn" data-idx="${i}" data-name="${c.name}" data-charid="">⚔️ Rejoin</button>`
				}
			</div>
		</div>`;
	}).join("");

	modal.innerHTML = `
		<div class="modal-content">
			<button class="modal-close">✕</button>
			<h3>⚔️ Game In Progress</h3>
			<p style="color:#aaa;font-size:0.9em;">This adventure is already underway. Reclaim your character or create a new one.</p>
			${statusNote}
			${availableChars.length
				? `<div class="rejoin-card-list">${charCards}</div>`
				: `<p style="color:#888;font-style:italic;">No absent characters — all slots are active.</p>`
			}
			<div class="row" style="margin-top:1.25em;gap:0.75em;">
				<button id="rejoinCreateNew" class="secondary">✨ Create New Character</button>
				<button id="rejoinCancel" class="secondary">Cancel</button>
			</div>
		</div>`;

	document.body.appendChild(modal);

	function closeModal() { modal.remove(); }

	// File upload path (characters with a characterId)
	modal.querySelectorAll('input[type="file"]').forEach(input => {
		input.addEventListener("change", async (e) => {
			const idx  = Number(e.target.dataset.idx);
			const card = modal.querySelector(`#rejoin-card-${idx}`);
			const charData = JSON.parse(decodeURIComponent(card.dataset.char));
			const statusEl = modal.querySelector(`#rejoin-status-${idx}`);

			const file = e.target.files[0];
			if (!file) return;

			const uploadLabel = e.target.closest(".rejoin-upload-btn");
			if (uploadLabel) uploadLabel.style.opacity = "0.5";
			statusEl.style.color = "#aaa";
			statusEl.textContent = "⏳ Verifying...";

			try {
				const text = await file.text();
				const { v, data, sig } = JSON.parse(text);

				// Verify with server and extract characterId
				const res = await fetch("/api/character/import", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ data, sig }),
				});
				const json = await res.json();
				if (!res.ok) { statusEl.textContent = "❌ Invalid file"; statusEl.style.color = "#f66"; if (uploadLabel) uploadLabel.style.opacity = ""; return; }

				const fileCharId = json.character?.sheet?.characterId;
				if (!fileCharId) {
					// Old file (pre-ID system) — verify by name at minimum
					if (json.character?.name !== charData.name) {
						statusEl.textContent = "❌ Wrong character file";
						statusEl.style.color = "#f66";
						if (uploadLabel) uploadLabel.style.opacity = "";
						return;
					}
					// Matching name, allow — server accepts if stored char has no ID either
				} else if (fileCharId !== charData.characterId) {
					statusEl.textContent = "❌ Wrong character file";
					statusEl.style.color = "#f66";
					if (uploadLabel) uploadLabel.style.opacity = "";
					return;
				}

				statusEl.textContent = "✅ Verified";
				statusEl.style.color = "#6f6";

				me.name = charData.name;
				socket.emit("join:rejoin", { lobbyCode, charName: charData.name, clientId, characterId: fileCharId });
				closeModal();
			} catch (err) {
				statusEl.textContent = "❌ Read error";
				statusEl.style.color = "#f66";
				if (uploadLabel) uploadLabel.style.opacity = "";
				console.error("Rejoin file error:", err);
			}
		});
	});

	// Direct rejoin path (legacy characters with no characterId)
	modal.querySelectorAll(".rejoin-claim-btn").forEach(btn => {
		btn.addEventListener("click", () => {
			me.name = btn.dataset.name;
			socket.emit("join:rejoin", { lobbyCode, charName: btn.dataset.name, clientId, characterId: undefined });
			closeModal();
		});
	});

	document.getElementById("rejoinCreateNew").onclick = () => {
		closeModal();
		joiningInProgress = true;
		pendingJoinCode = lobbyCode;
		enterLobbyMode(lobbyCode, true);
	};
	document.getElementById("rejoinCancel").onclick = closeModal;
}

function timeAgo(ts) {
	const secs = Math.floor((Date.now() - ts) / 1000);
	if (secs < 60)  return "just now";
	const mins = Math.floor(secs / 60);
	if (mins < 60)  return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24)   return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}

// === Active lobbies list on landing page ===
let _lobbiesCache = null;
let _activeTab = "starting";

function renderLobbiesList(lobbies) {
	_lobbiesCache = lobbies;
	const tabsEl = document.getElementById("lobbyTabs");
	const listEl = document.getElementById("activeGamesList");
	if (!listEl) return;

	if (!lobbies || !lobbies.length) {
		if (tabsEl) tabsEl.innerHTML = "";
		listEl.innerHTML = `<p class="hint">No adventures right now. Create one!</p>`;
		return;
	}

	const tabGroups = {
		starting:    { label: "Starting",     phases: ["waiting"] },
		active:      { label: "Active",       phases: ["running"] },
		hibernating: { label: "Hibernating",  phases: ["hibernating"] },
		finished:    { label: "Finished",     phases: ["wiped", "completed"] },
	};

	// Count per tab
	const counts = {};
	for (const [key, g] of Object.entries(tabGroups)) {
		counts[key] = lobbies.filter((l) => g.phases.includes(l.phase)).length;
	}

	// Auto-select first non-empty tab if current is empty
	if (!counts[_activeTab]) {
		_activeTab = Object.keys(counts).find((k) => counts[k] > 0) || "active";
	}

	// Render tabs
	if (tabsEl) {
		tabsEl.innerHTML = Object.entries(tabGroups).map(([key, g]) => {
			const c = counts[key];
			const sel = key === _activeTab ? "lobby-tab--active" : "";
			return `<button class="lobby-tab ${sel}" data-tab="${key}" ${c === 0 ? "disabled" : ""}>${g.label}${c ? ` <span class="lobby-tab-count">${c}</span>` : ""}</button>`;
		}).join("");

		tabsEl.querySelectorAll(".lobby-tab").forEach((btn) => {
			btn.addEventListener("click", () => {
				_activeTab = btn.dataset.tab;
				renderLobbiesList(_lobbiesCache);
			});
		});
	}

	const searchTerm = (document.getElementById("adventureSearch")?.value || "").trim().toLowerCase();
	const filtered = lobbies.filter((l) => {
		if (!tabGroups[_activeTab].phases.includes(l.phase)) return false;
		if (searchTerm && !(l.adventureName || "").toLowerCase().includes(searchTerm)) return false;
		return true;
	});

	const settingLabel = { standard: "High Fantasy", dark_ages: "Dark Ages", steampunk: "Steampunk", pirate: "Pirate Age", scifi: "Sci-fi Fantasy" };
	const isJoinable = (phase) => ["waiting", "running", "hibernating"].includes(phase);
	const isOver = (phase) => ["wiped", "completed"].includes(phase);

	if (!filtered.length) {
		listEl.innerHTML = `<p class="hint">No adventures in this category.</p>`;
		return;
	}

	listEl.innerHTML = filtered.map((l) => {
		const lockIcon = l.hasPassword ? `<span title="Password protected" style="margin-left:0.3em;">🔒</span>` : "";
		const name = l.adventureName || "Unnamed Adventure";

		// Player count + names
		const playerCount = l.players?.length || 0;
		let playersHtml;
		if (playerCount) {
			playersHtml = `<div class="lobby-players">${l.players.map((p) => {
				const dot = `<span class="lobby-player-dot ${p.connected ? "lobby-player-dot--online" : "lobby-player-dot--offline"}"></span>`;
				const hostIcon = p.isHost ? ` 👑` : "";
				return `<span class="lobby-player-tag">${dot}${p.name}${hostIcon}</span>`;
			}).join("")}</div>`;
		} else {
			playersHtml = `<span class="hint" style="font-size:0.8em;">No players yet</span>`;
		}

		// Compact flavor — just setting + tone, skip the rest to reduce clutter
		const flavorParts = [
			settingLabel[l.campaignSetting] || "",
			l.campaignTone?.label || "",
		].filter(Boolean);
		const flavorStr = flavorParts.length ? `<span class="lobby-flavor-inline">${flavorParts.join(" · ")}</span>` : "";

		const lastSeen = l.lastActivity ? timeAgo(l.lastActivity) : "";

		// Actions — inline row
		const readBtn = !l.hasPassword ? `<button class="lobby-action-btn" onclick="showStoryModal('${l.code}')">📖 Read</button>` : "";
		const joinBtn = isJoinable(l.phase) ? `<button class="lobby-action-btn lobby-action-join" onclick="quickJoin('${l.code}')">⚔️ Join</button>` : "";
		const codeTag = !isOver(l.phase) ? `<code class="lobby-code-tag">${l.code}</code>` : "";

		return `
			<div class="active-game-row">
				<div class="lobby-card-left">
					<div class="lobby-card-title">${name}${lockIcon} ${flavorStr}</div>
					${playersHtml}
				</div>
				<div class="lobby-card-right">
					${codeTag}
					<div class="lobby-card-actions">${joinBtn}${readBtn}</div>
					${lastSeen ? `<span class="lobby-card-meta">${lastSeen}</span>` : ""}
				</div>
			</div>`;
	}).join("");
}

const _adventureSearchEl = document.getElementById("adventureSearch");
if (_adventureSearchEl) {
	_adventureSearchEl.addEventListener("input", () => {
		if (_lobbiesCache) renderLobbiesList(_lobbiesCache);
	});
}

async function fetchActiveLobbies() {
	try {
		const res = await fetch("/api/lobbies");
		const { lobbies } = await res.json();
		renderLobbiesList(lobbies);
	} catch (err) {
		console.warn("Failed to fetch active lobbies:", err);
		const listEl = document.getElementById("activeGamesList");
		if (listEl) listEl.innerHTML = `<p class="hint">Could not load adventures.</p>`;
	}
}

async function hashPassword(password) {
	const data = new TextEncoder().encode(password);
	const buf = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function quickJoin(code) {
	if (els.joinCode) els.joinCode.value = code;
	handleJoinLobby();
}

async function showStoryModal(code) {
	const modal = document.getElementById("storyModal");
	const logEl = document.getElementById("storyModalLog");
	const summaryEl = document.getElementById("storyModalSummary");
	const pinnedEl = document.getElementById("storyModalPinned");
	const titleEl = document.getElementById("storyModalTitle");
	const metaEl = document.getElementById("storyModalMeta");
	if (!modal) return;

	const panes = { log: logEl, summary: summaryEl, pinned: pinnedEl };

	titleEl.textContent = "Loading...";
	metaEl.innerHTML = "";
	logEl.innerHTML = `<div class="spinner" style="margin:2em auto;"></div>`;
	summaryEl.innerHTML = "";
	pinnedEl.innerHTML = "";
	Object.values(panes).forEach(p => p.style.display = "none");
	logEl.style.display = "";
	modal.style.display = "flex";

	// Wire tab switching
	modal.querySelectorAll(".story-tab").forEach(tab => {
		tab.onclick = () => {
			modal.querySelectorAll(".story-tab").forEach(t => t.classList.remove("story-tab--active"));
			tab.classList.add("story-tab--active");
			const target = tab.dataset.storyTab;
			Object.entries(panes).forEach(([k, el]) => el.style.display = k === target ? "" : "none");
		};
	});
	// Reset to Full Story tab
	modal.querySelectorAll(".story-tab").forEach(t => t.classList.remove("story-tab--active"));
	modal.querySelector('.story-tab[data-story-tab="log"]')?.classList.add("story-tab--active");

	try {
		const res = await fetch(`/api/lobby/${code}/story`);
		if (!res.ok) throw new Error("Not found");
		const data = await res.json();

		titleEl.textContent = data.adventureName || "Unnamed Adventure";
		const phaseBadge = { wiped: `<span class="badge" style="background:#550000;">☠️ Party Wiped</span>`, completed: `<span class="badge" style="background:#224400;">🏆 Completed</span>` };
		metaEl.innerHTML = `${phaseBadge[data.phase] || ""} <span class="hint" style="margin-left:0.5em;">Players: ${data.players.join(", ") || "none"}</span>`;

		// ── Full Story tab ──
		const pinnedIndices = new Set((data.pinnedMoments || []).map(p => p.index));
		if (!data.history.length) {
			logEl.innerHTML = `<p class="hint">No story entries recorded.</p>`;
		} else {
			logEl.innerHTML = data.history.map((entry, i) => {
				const pin = pinnedIndices.has(i) ? `<span title="Pinned moment" style="color:#f0c060;margin-right:0.4em;">📌</span>` : "";
				if (entry.role === "assistant") {
					return `<div class="story-entry-dm">${pin}${entry.content}</div>`;
				}
				const name = entry.name || "Player";
				const text = entry.content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
				return `<div class="story-entry-player">${pin}<strong>${name}:</strong> ${text}</div>`;
			}).join("");
		}

		// ── Summary tab ──
		// DM/summarizer content contains intentional HTML (bold, italic, line breaks) — render it directly.
		let summaryHtml = "";
		if (data.ancientHistory) {
			const ancientHtml = data.ancientHistory.replace(/\n/g, "<br>");
			summaryHtml += `<h4 style="color:#b0baff;margin:0 0 0.5em;">📜 Campaign Backstory</h4><div class="story-entry-dm" style="white-space:pre-wrap;opacity:0.85;border-left:3px solid #665599;">${ancientHtml}</div><hr style="border-color:rgba(255,255,255,0.1);margin:1em 0;"/>`;
		}
		if (data.storyContext && data.storyContext !== "—") {
			const ctxHtml = data.storyContext.replace(/\n/g, "<br>");
			summaryHtml += `<h4 style="color:#b0baff;margin:0 0 0.5em;">📋 Recent Arc</h4><div class="story-entry-dm" style="white-space:pre-wrap;">${ctxHtml}</div>`;
		}
		summaryEl.innerHTML = summaryHtml || `<p class="hint">No summary available yet — the story is still in its early stages.</p>`;

		// ── Pinned Moments tab ──
		const pins = data.pinnedMoments || [];
		if (!pins.length) {
			pinnedEl.innerHTML = `<p class="hint">No pinned moments yet. Players can pin important story beats during gameplay.</p>`;
		} else {
			pinnedEl.innerHTML = pins.map(p => {
				const entry = data.history[p.index];
				const content = entry
					? (entry.role === "assistant" ? entry.content : `<strong>${entry.name || "Player"}:</strong> ${(entry.content || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`)
					: `<em>${p.snippet}</em>`;
				return `<div class="story-entry-dm" style="border-left:3px solid #f0c060;">
					<div style="font-size:0.78em;color:#888;margin-bottom:0.3em;">📌 Pinned by ${p.pinnedBy}</div>
					${content}
				</div>`;
			}).join("");
		}
	} catch (err) {
		logEl.innerHTML = `<p class="hint">Could not load story log.</p>`;
	}
}

function enterLobbyMode(code, midGameJoin = false) {
	show(els.lobby);
	if (els.lobbyCode) els.lobbyCode.textContent = `#${code}`;
	if (midGameJoin) {
		// Hide host-only / pre-game controls that don't apply mid-join
		["startGame", "phaseReady"].forEach((id) => {
			const el = document.getElementById(id);
			if (el) el.classList.add("hidden");
		});
		if (els.toggleReady) {
			els.toggleReady.textContent = "Join Adventure";
			els.toggleReady.title = "Save your sheet first, then click to join the running game";
		}
	}
}

function enterGameMode() {
	show(els.game);
	document.querySelectorAll(".die").forEach(btn => (btn.disabled = true));
	// Always show the music widget once we're in-game
	window.musicManager?.showWidget();
}

function appendActionLog(text, className = "") {
	const actionLog = document.getElementById("actionLog");
	if (!actionLog) {
		console.warn("⚠️ actionLog element not found");
		return;
	}

	const div = document.createElement("div");
	div.className = `smalltext ${className}`.trim();
	div.innerHTML = text;
	actionLog.appendChild(div);
	actionLog.scrollTop = actionLog.scrollHeight;
}

function updateGameUI(state) {
	if (!state) return;

	// === Basic Info ===
	const meChar = me?.name ? state.players?.[me.name] : null;
	if (!meChar) {
		console.warn("[updateGameUI] No matching character for", me.name);
		return;
	}

	// Update visible info in the game panel
	const nameEl = document.getElementById("charName");
	if (nameEl) {
		nameEl.textContent = meChar.name || "—";
		const raceClsEl = document.getElementById("charRaceCls");
		if (raceClsEl) raceClsEl.textContent = `${meChar.race || ""} ${meChar.class || ""}`.trim() || "—";
	}

	const levelEl = document.getElementById("charLevel");
	if (levelEl) levelEl.textContent = `Lv ${meChar.level || 1}`;

	const hpEl = document.getElementById("charHP");
	if (hpEl) hpEl.textContent = meChar.stats?.hp ?? 10;

	const xpEl = document.getElementById("charXP");
	if (xpEl) xpEl.textContent = meChar.xp ?? 0;

	const goldEl2 = document.getElementById("charGold");
	if (goldEl2) goldEl2.textContent = meChar.gold ?? 0;

	// === XP Progress Bar ===
	const thresholds = [0, 300, 900, 2700, 6500];
	const level = meChar.level || 1;
	const next = thresholds[level] || 99999;
	const prev = thresholds[level - 1] || 0;
	const percent = Math.min(100, ((meChar.xp - prev) / (next - prev)) * 100);

	const xpFill = document.getElementById("xpFillGame");
	const xpLabel = document.getElementById("xpLabelGame");
	if (xpFill) xpFill.style.width = `${percent}%`;
	if (xpLabel) xpLabel.textContent = `${meChar.xp || 0} / ${next} XP`;

	// === Attributes ===
	const statMap = {
		STR: meChar.stats?.str ?? 10,
		DEX: meChar.stats?.dex ?? 10,
		CON: meChar.stats?.con ?? 10,
		INT: meChar.stats?.int ?? 10,
		WIS: meChar.stats?.wis ?? 10,
		CHA: meChar.stats?.cha ?? 10,
	};
	for (const [key, val] of Object.entries(statMap)) {
		const el = document.getElementById(`attr${key}`);
		if (el) el.textContent = val;
	}

	// === ABILITIES & INVENTORY — use component renderers so display is always current ===
	drawAbilitiesComponent("gameAbilitiesContainer", meChar.abilities || [], false, true);
	drawInventoryComponent("gameInventoryContainer", meChar.inventory || [], false);

	// === Turn Banner ===
	const turnName = state.initiative?.[state.turnIndex] || null;
	const turnBanner = document.getElementById("turnBanner");
	if (turnBanner) turnBanner.textContent = `Turn: ${turnName || "—"}`;
	setActionInputForTurn(turnName);

	console.log(`[updateGameUI] Game view updated for ${me.name}`);
}

// ── Turn Timer Display ────────────────────────────────────────────────────────
let _timerInterval = null;
let _timerEndsAt   = null;
let _timerDuration = null;

function startTimerDisplay(player, endsAt, durationMs) {
	stopTimerDisplay();
	_timerEndsAt   = endsAt;
	_timerDuration = durationMs;

	if (els.turnTimerBar) els.turnTimerBar.classList.remove("hidden");
	if (els.turnTimerLabel) els.turnTimerLabel.textContent = `⏱ ${player}'s turn`;

	_timerInterval = setInterval(() => {
		const remaining = Math.max(0, _timerEndsAt - Date.now());
		const pct = (_timerDuration > 0) ? (remaining / _timerDuration) * 100 : 0;
		const secs = Math.ceil(remaining / 1000);
		const mins = Math.floor(secs / 60);
		const s    = secs % 60;

		if (els.turnTimerCountdown) els.turnTimerCountdown.textContent = `${mins}:${String(s).padStart(2, "0")}`;
		if (els.turnTimerFill) {
			els.turnTimerFill.style.width = `${pct}%`;
			els.turnTimerFill.className = "turn-timer-fill" +
				(pct <= 20 ? " danger" : pct <= 50 ? " warning" : "");
		}

		if (remaining <= 0) stopTimerDisplay();
	}, 250);
}

function stopTimerDisplay() {
	if (_timerInterval) {
		clearInterval(_timerInterval);
		_timerInterval = null;
	}
	_timerEndsAt   = null;
	_timerDuration = null;
	if (els.turnTimerBar)      els.turnTimerBar.classList.add("hidden");
	if (els.turnTimerFill)     els.turnTimerFill.style.width = "100%";
	if (els.turnTimerCountdown) els.turnTimerCountdown.textContent = "—";
}

function showTimerPending(player, readingDelayMs, ttsActive) {
	stopTimerDisplay();
	if (els.turnTimerBar) els.turnTimerBar.classList.remove("hidden");
	if (els.turnTimerFill) {
		els.turnTimerFill.style.width = "100%";
		els.turnTimerFill.className = "turn-timer-fill";
	}

	if (ttsActive) {
		if (els.turnTimerLabel) els.turnTimerLabel.textContent = `🔮 The Dungeon Master's voice lingers... ${player}'s turn awaits`;
		if (els.turnTimerCountdown) els.turnTimerCountdown.textContent = "";
	} else {
		const startsAt = Date.now() + readingDelayMs;
		if (els.turnTimerLabel) els.turnTimerLabel.textContent = `⏱ ${player}'s turn — timer starts in`;
		_timerInterval = setInterval(() => {
			const remaining = Math.max(0, startsAt - Date.now());
			const secs = Math.ceil(remaining / 1000);
			if (els.turnTimerCountdown) els.turnTimerCountdown.textContent = `${secs}s`;
			if (remaining <= 0) {
				clearInterval(_timerInterval);
				_timerInterval = null;
			}
		}, 250);
	}
}


// Small helper to flash the points display red when over limit
function flashPoints(msg = "Too many points!") {
	const el = document.getElementById("pointsRemaining");
	el.textContent = msg;
	el.style.color = "orange";
	el.style.transform = "scale(1.1)";
	setTimeout(() => {
		updatePointsDisplay();
		el.style.transform = "scale(1)";
	}, 800);
}


