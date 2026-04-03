// ═══════════════════════════════════════════════════════════════
//  StoryTeller — Admin Panel
// ═══════════════════════════════════════════════════════════════
const socket = io();
let currentLobby = null;   // lobby code we're connected to
let currentState = null;    // last lobby state received
let authType = "admin";     // "admin" or "host"

// Wait briefly for the inline auth check to populate __adminAuth
setTimeout(() => {
	authType = window.__adminAuth?.type || "admin";
	// Char file tool is admin-only (not for host-as-admin)
	if (authType === "admin") {
		document.getElementById("charFileSection").classList.remove("hidden");
	}
}, 300);

// ── DOM refs ──
const $ = id => document.getElementById(id);
const els = {
	statusBadge:      $("statusBadge"),
	lobbyGrid:        $("lobbyGrid"),
	lobbySection:     $("lobbySection"),
	lobbyTitle:       $("lobbyTitle"),
	lobbyInfoGrid:    $("lobbyInfoGrid"),
	playersTable:     $("playersTable").querySelector("tbody"),
	playerSelect:     $("playerSelect"),
	eventFeed:        $("eventFeed"),
	feedFilter:       $("feedFilter"),
	feedAutoScroll:   $("feedAutoScroll"),
	currentMoodLabel: $("currentMoodLabel"),
	sfxResult:        $("sfxResult"),
	sfxResultBadge:   $("sfxResultBadge"),
	sfxResultName:    $("sfxResultName"),
	sfxResultFile:    $("sfxResultFile"),
	sfxResultAudio:   $("sfxResultAudio"),
};

// ═══ LOGOUT ═══
$("logoutBtn").addEventListener("click", async () => {
	await fetch("/api/admin/logout", { method: "POST" });
	window.location.href = "/admin/login.html";
});

// ═══ SOCKET LIFECYCLE ═══
socket.on("connect", () => {
	setBadge("Connected (idle)", "connected");
	feedEvent("sys", "Socket connected");
	// Re-join lobby room if we were connected
	if (currentLobby) socket.emit("admin:connect", { code: currentLobby });
});
socket.on("disconnect", (reason) => {
	setBadge("Disconnected", "");
	feedEvent("sys", `Disconnected: ${reason}`);
});
socket.on("connect_error", (err) => {
	setBadge("Connection Error", "error");
	feedEvent("sys", `Connection error: ${err?.message || err}`);
});

function setBadge(text, cls) {
	els.statusBadge.textContent = text;
	els.statusBadge.className = "status-badge" + (cls ? ` ${cls}` : "");
}

// ═══ LOBBY BROWSER ═══
async function loadLobbies() {
	try {
		const res = await fetch("/api/lobbies");
		const { lobbies = [] } = await res.json();
		if (!lobbies.length) {
			els.lobbyGrid.innerHTML = '<p style="color:#666;font-style:italic;">No active lobbies.</p>';
			return;
		}
		els.lobbyGrid.innerHTML = lobbies.map(l => {
			const isActive = currentLobby === l.code;
			return `
			<div class="lobby-card${isActive ? " active" : ""}" data-code="${l.code}">
				<div class="lobby-card-header">
					<span class="lobby-card-title">${esc(l.adventureName || "Untitled Adventure")}</span>
					<span class="lobby-card-code">${l.code}</span>
				</div>
				<div class="lobby-card-meta">
					<span>${l.playerCount || 0} player${l.playerCount !== 1 ? "s" : ""}</span>
					<span>${l.phase || "waiting"}</span>
				</div>
				<div class="lobby-card-actions">
					<button class="btn btn-primary btn-sm" onclick="connectToLobby('${l.code}')">${isActive ? "Connected" : "Connect"}</button>
					<button class="btn btn-danger btn-sm" onclick="deleteLobby('${l.code}')">Delete</button>
				</div>
			</div>`;
		}).join("");
	} catch {
		els.lobbyGrid.innerHTML = '<p style="color:#f88;">Failed to load lobbies.</p>';
	}
}
loadLobbies();

// ═══ CONNECT TO LOBBY ═══
window.connectToLobby = function(code) {
	code = code.trim().toUpperCase();
	if (!code) return;
	currentLobby = code;
	feedEvent("sys", `Connecting to ${code}...`);
	socket.emit("admin:connect", { code });
};

socket.on("admin:connected", (state) => {
	currentState = state;
	els.lobbySection.classList.remove("hidden");
	setBadge(`Connected: ${state.code}`, "connected");
	feedEvent("sys", `Connected to lobby ${state.code}`);
	renderLobbyInfo(state);
	renderPlayers(state);
	loadLobbies(); // refresh active highlight
	if (els.currentMoodLabel) {
		els.currentMoodLabel.textContent = state.currentMusic ? state.currentMusic.replace(/_/g, " ") : "--";
	}
	// Sync LLM selector to current lobby state
	if (state.llmProvider && $("llmProviderSelect")) {
		$("llmProviderSelect").value = state.llmProvider;
		updateLlmModelSelect();
		if (state.llmModel) $("llmModelSelect").value = state.llmModel;
	}
	updateCurrentLlmLabel();
	renderRawJson();
});

// ═══ DELETE LOBBY ═══
window.deleteLobby = function(code) {
	if (!confirm(`Delete lobby ${code}? This cannot be undone.`)) return;
	socket.emit("admin:deleteLobby", { code });
};
socket.on("admin:lobbyDeleted", ({ code }) => {
	feedEvent("sys", `Lobby ${code} deleted`);
	if (currentLobby === code) {
		currentLobby = null;
		currentState = null;
		els.lobbySection.classList.add("hidden");
		setBadge("Connected (idle)", "connected");
	}
	loadLobbies();
});

// ═══ RENDER LOBBY INFO ═══
function renderLobbyInfo(state) {
	els.lobbyTitle.textContent = state.adventureName || state.code || "Lobby Details";
	const players = Object.values(state.players || {});
	const alive = players.filter(p => !p.dead).length;
	const turn = state.initiative?.current || "--";
	const cards = [
		{ label: "Code",    value: state.code },
		{ label: "Phase",   value: state.phase || "waiting" },
		{ label: "Players", value: `${alive} alive / ${players.length} total` },
		{ label: "Turn",    value: turn },
		{ label: "Music",   value: state.currentMusic?.replace(/_/g, " ") || "none" },
		{ label: "Round",   value: state.initiative?.round || 1 },
	];
	els.lobbyInfoGrid.innerHTML = cards.map(c => `
		<div class="info-card">
			<div class="info-card-label">${c.label}</div>
			<div class="info-card-value">${esc(String(c.value))}</div>
		</div>
	`).join("");
}

// ═══ RENDER PLAYERS TABLE ═══
function renderPlayers(state) {
	const players = Object.values(state.players || {});
	els.playersTable.innerHTML = "";

	players.forEach(p => {
		const conds = (p.conditions || []).map(c => `<span class="condition-badge">${esc(c)}</span>`).join(" ");
		const hp = p.stats?.hp ?? p.hp ?? 0;
		const maxHp = p.stats?.max_hp ?? p.max_hp ?? "?";
		const dead = p.dead ? ' style="opacity:0.4;text-decoration:line-through;"' : '';
		const row = document.createElement("tr");
		row.innerHTML = `
			<td${dead}>${esc(p.name)}</td>
			<td>${esc(p.race || "--")}</td>
			<td>${esc(p.class || "--")}</td>
			<td>${p.level || 1}</td>
			<td>${p.xp || 0}</td>
			<td>${hp}/${maxHp}${p.dead ? " (dead)" : ""}</td>
			<td>${p.gold ?? 0}</td>
			<td>${conds || '<span style="color:#555;">none</span>'}</td>
			<td style="text-align:right;">
				<button class="btn btn-sm" onclick="forceLevelUp('${esc(p.name)}')">Level Up</button>
				<button class="btn btn-danger btn-sm" onclick="kickPlayer('${esc(p.name)}')">Kick</button>
			</td>
		`;
		// Click row to select player
		row.style.cursor = "pointer";
		row.addEventListener("click", (e) => {
			if (e.target.tagName === "BUTTON") return;
			els.playerSelect.value = p.name;
			// Switch to events tab
			switchTab("eventsPane");
		});
		els.playersTable.appendChild(row);
	});

	// Refresh dropdown
	const prev = els.playerSelect.value;
	els.playerSelect.innerHTML = '<option value="">-- Choose Player --</option>';
	players.forEach(p => {
		const opt = document.createElement("option");
		opt.value = p.name;
		opt.textContent = p.name;
		els.playerSelect.appendChild(opt);
	});
	if (prev) els.playerSelect.value = prev;
}

// ═══ TAB SWITCHING ═══
document.querySelectorAll(".tab-btn").forEach(btn => {
	btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tabId) {
	document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
	document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
	const pane = $(tabId);
	if (pane) pane.classList.add("active");
	const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
	if (btn) btn.classList.add("active");
}

// ═══ LIVE EVENT FEED ═══
function feedEvent(type, msg) {
	const feed = els.eventFeed;
	// Remove empty placeholder
	const empty = feed.querySelector(".event-feed-empty");
	if (empty) empty.remove();

	const filter = els.feedFilter.value;
	const now = new Date();
	const ts = now.toLocaleTimeString("en-US", { hour12: false });

	const entry = document.createElement("div");
	entry.className = `event-entry event-${type}`;
	entry.dataset.type = type;
	entry.innerHTML = `<span class="event-time">${ts}</span><span class="event-type">${type.toUpperCase()}</span><span class="event-msg">${esc(msg)}</span>`;

	if (filter !== "all" && filter !== type) entry.style.display = "none";
	feed.appendChild(entry);

	if (els.feedAutoScroll.checked) feed.scrollTop = feed.scrollHeight;
}

// Filter change
els.feedFilter.addEventListener("change", () => {
	const filter = els.feedFilter.value;
	els.eventFeed.querySelectorAll(".event-entry").forEach(e => {
		e.style.display = (filter === "all" || e.dataset.type === filter) ? "" : "none";
	});
});

$("clearFeed").addEventListener("click", () => {
	els.eventFeed.innerHTML = '<div class="event-feed-empty">Feed cleared.</div>';
});

// ═══ LISTEN TO GAME EVENTS (for the feed) ═══
socket.on("admin:update", (state) => {
	currentState = state;
	renderLobbyInfo(state);
	renderPlayers(state);
	renderStorySummary();
	updateCurrentLlmLabel();
	renderRawJson();
});

socket.on("xp:update", ({ player, amount, reason, xp }) => {
	feedEvent("xp", `${player} gained ${amount} XP (${reason}) — now ${xp} XP`);
	refreshPlayerCell(player, { xp });
});
socket.on("hp:update", ({ player, delta, reason, hp }) => {
	const sign = delta >= 0 ? "+" : "";
	feedEvent("hp", `${player} ${sign}${delta} HP (${reason}) — now ${hp} HP`);
	refreshPlayerCell(player, { hp });
});
socket.on("gold:update", ({ player, delta, reason, gold }) => {
	const sign = delta >= 0 ? "+" : "";
	feedEvent("gold", `${player} ${sign}${delta} gold (${reason}) — now ${gold}`);
	refreshPlayerCell(player, { gold });
});
socket.on("turn:update", ({ current, order }) => {
	feedEvent("turn", `Turn: ${current} | Order: ${(order || []).join(", ")}`);
});
socket.on("narration", ({ content }) => {
	const text = typeof content === "string" ? content : JSON.stringify(content);
	feedEvent("dm", text.substring(0, 300) + (text.length > 300 ? "..." : ""));
});
socket.on("player:death", ({ player, message }) => {
	feedEvent("death", message || `${player} has died!`);
});
socket.on("music:change", ({ mood }) => {
	feedEvent("music", mood ? `Music changed to: ${mood.replace(/_/g, " ")}` : "Music stopped");
	if (els.currentMoodLabel) els.currentMoodLabel.textContent = mood ? mood.replace(/_/g, " ") : "--";
});
socket.on("sfx:play", ({ effects }) => {
	if (effects?.length) feedEvent("sfx", `SFX: ${effects.map(e => e.name || e.file).join(", ")}`);
});
socket.on("roll:required", ({ player, sides, stats }) => {
	feedEvent("roll", `${player} must roll d${sides} (${(stats || []).join(", ")})`);
});
socket.on("dice:result", ({ player, roll, total, sides }) => {
	feedEvent("roll", `${player} rolled d${sides}: ${roll} (total: ${total})`);
});
socket.on("conditions:update", ({ player, conditions }) => {
	feedEvent("cond", `${player} conditions: ${(conditions || []).join(", ") || "none"}`);
});
socket.on("inventory:update", ({ player, item, change, newCount }) => {
	const sign = change >= 0 ? "+" : "";
	feedEvent("inv", `${player} ${sign}${change} ${item} (now: ${newCount})`);
});
socket.on("spellslots:update", ({ player, spellSlotsUsed, maxSlots }) => {
	feedEvent("sys", `${player} spell slots: ${spellSlotsUsed}/${maxSlots} used`);
});
socket.on("player:levelup", ({ newLevel }) => {
	feedEvent("xp", `Level up! Now level ${newLevel}`);
});
socket.on("player:kicked", ({ reason }) => {
	feedEvent("sys", `Player kicked: ${reason}`);
});
socket.on("rest:vote:start", ({ type, proposer }) => {
	feedEvent("sys", `${proposer} proposed a ${type} rest`);
});
socket.on("rest:vote:result", ({ type, passed }) => {
	feedEvent("sys", `${type} rest vote ${passed ? "passed" : "failed"}`);
});
socket.on("game:over", ({ reason }) => {
	feedEvent("sys", `Game over: ${reason}`);
});
socket.on("toast", ({ type, message }) => {
	feedEvent("sys", `[${(type || "info").toUpperCase()}] ${message}`);
});
socket.on("state:update", () => {
	// State updates come through admin:update for us; just note it
});

// ═══ PLAYER EVENTS ═══
function emitEvent(type, payload) {
	if (!currentLobby) return alert("Connect to a lobby first");
	socket.emit("admin:event", { code: currentLobby, type, payload });
}

$("addXP").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	emitEvent("xp:update", { player, amount: parseInt($("xpAmount").value) || 0, reason: $("xpReason").value || "Manual" });
});

$("addHP").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	emitEvent("hp:update", { player, delta: parseInt($("hpDelta").value) || 0, reason: $("hpReason").value || "Manual" });
});

$("addGold").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	emitEvent("gold:update", { player, delta: parseInt($("goldDelta").value) || 0, reason: $("goldReason").value || "Manual" });
});

$("applySlots").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	emitEvent("spellslots:update", { player, delta: parseInt($("slotDelta").value) || 0 });
});

$("invApply").addEventListener("click", () => {
	const player = els.playerSelect.value;
	const item = $("invItem").value.trim();
	if (!player || !item) return alert("Select a player and enter an item name");
	emitEvent("inventory:update", { player, item, change: parseInt($("invChange").value) || 0, description: $("invReason").value || "Manual" });
});

// ── Grant Equipment ──
// Toggle weapon/armor fields based on item type
$("grantItemType").addEventListener("change", () => {
	const type = $("grantItemType").value;
	$("grantWeaponFields").classList.toggle("hidden", type !== "weapon");
	$("grantArmorFields").classList.toggle("hidden", type !== "armor");
});

$("grantItemBtn").addEventListener("click", () => {
	const player = els.playerSelect.value;
	const name = $("grantItemName").value.trim();
	if (!player) return alert("Select a player");
	if (!name) return alert("Enter an item name");

	const type = $("grantItemType").value;
	const description = $("grantDescription").value.trim();
	const attributes = { item_type: type };

	if (type === "weapon") {
		attributes.damage      = $("grantDamage").value.trim() || "1d6";
		attributes.damage_type = $("grantDamageType").value;
		attributes.range       = $("grantRange").value;
	} else if (type === "armor") {
		attributes.ac         = parseInt($("grantAC").value) || 12;
		attributes.armor_type = $("grantArmorType").value;
	}

	emitEvent("inventory:update", {
		player,
		item: name,
		change: 1,
		description: description || name,
		attributes,
	});

	// Clear form
	$("grantItemName").value = "";
	$("grantDescription").value = "";
	$("grantDamage").value = "";
	$("grantAC").value = "";
	feedEvent("admin", `Granted "${name}" (${type}) to ${player}`);
});

$("sendRollRequired").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	emitEvent("roll:required", {
		player,
		sides: Number($("rollSides").value),
		mods: Number($("rollMods").value) || 0,
		stats: Array.from($("rollStats").selectedOptions).map(o => o.value),
	});
});

$("applyConditions").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	const add = Array.from($("condAddSelect").selectedOptions).map(o => o.value);
	const remove = Array.from($("condRemoveSelect").selectedOptions).map(o => o.value);
	if (!add.length && !remove.length) return alert("Select at least one condition");
	emitEvent("conditions:update", { player, add, remove });
	$("condAddSelect").selectedIndex = -1;
	$("condRemoveSelect").selectedIndex = -1;
});

$("killPlayer").addEventListener("click", () => {
	const player = els.playerSelect.value;
	if (!player) return alert("Select a player");
	if (!confirm(`Kill ${player}?`)) return;
	const reason = $("killReason").value.trim();
	emitEvent("player:death", { player, reason });
	$("killReason").value = "";
});

// ═══ DM TOOLS ═══
$("sendDM").addEventListener("click", () => {
	const text = $("dmMessage").value.trim();
	if (!text || !currentLobby) return;
	socket.emit("admin:dm", { code: currentLobby, content: text });
	$("dmMessage").value = "";
});

// Music
$("sendMusicChange").addEventListener("click", () => {
	if (!currentLobby) return alert("Connect to a lobby first");
	socket.emit("admin:music", { code: currentLobby, mood: $("musicMoodSelect").value });
});
$("sendMusicStop").addEventListener("click", () => {
	if (!currentLobby) return;
	socket.emit("admin:music", { code: currentLobby, mood: null });
});

// SFX
$("testSfx").addEventListener("click", () => {
	const desc = $("sfxDescription").value.trim();
	if (!desc || !currentLobby) return alert("Enter a description and connect to a lobby");
	$("testSfx").disabled = true;
	$("testSfx").textContent = "Resolving...";
	els.sfxResult.classList.add("hidden");
	socket.emit("admin:sfx", { code: currentLobby, description: desc });
});
socket.on("admin:sfx:result", ({ ok, effect, source, error }) => {
	$("testSfx").disabled = false;
	$("testSfx").textContent = "Test SFX";
	els.sfxResult.classList.remove("hidden");
	if (!ok) {
		els.sfxResultBadge.textContent = "Failed";
		els.sfxResultBadge.style.cssText = "background:#5a1a00;color:#ffaa66;";
		els.sfxResultName.textContent = error;
		els.sfxResultFile.textContent = "";
		els.sfxResultAudio.style.display = "none";
		return;
	}
	const gen = source === "generated";
	els.sfxResultBadge.textContent = gen ? "Generated" : "Library Match";
	els.sfxResultBadge.style.cssText = gen ? "background:#3a2a00;color:#ffd166;" : "background:#0a3a1a;color:#66ffaa;";
	els.sfxResultName.textContent = effect.name;
	els.sfxResultFile.textContent = effect.file;
	els.sfxResultAudio.style.display = "block";
	els.sfxResultAudio.src = `/sfx/game/${effect.file}`;
	els.sfxResultAudio.play().catch(() => {});
});

// LLM Model Switching
const LLM_MODELS = {
	openai: [
		{ value: "gpt-4o",              label: "GPT-4o" },
		{ value: "gpt-4o-mini",         label: "GPT-4o Mini" },
		{ value: "gpt-4-turbo",         label: "GPT-4 Turbo" },
		{ value: "gpt-5-chat-latest",   label: "GPT-5 (latest)" },
	],
	claude: [
		{ value: "claude-opus-4-6",           label: "Claude Opus 4.6" },
		{ value: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
		{ value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
	],
};

function updateLlmModelSelect() {
	const provider = $("llmProviderSelect").value;
	const models = LLM_MODELS[provider] || [];
	const sel = $("llmModelSelect");
	sel.innerHTML = models.map(m => `<option value="${m.value}">${m.label}</option>`).join("");
	// Restore current model if it matches this provider
	if (currentState?.llmProvider === provider && currentState?.llmModel) {
		sel.value = currentState.llmModel;
	}
}

function updateCurrentLlmLabel() {
	const label = $("currentLlmLabel");
	if (!label || !currentState) return;
	const p = currentState.llmProvider || "?";
	const m = currentState.llmModel || "?";
	const modelLabel = Object.values(LLM_MODELS).flat().find(x => x.value === m)?.label || m;
	label.textContent = `${p} / ${modelLabel}`;
}

$("llmProviderSelect").addEventListener("change", updateLlmModelSelect);
$("applyLlmBtn").addEventListener("click", () => {
	if (!currentLobby) return alert("Connect to a lobby first");
	const provider = $("llmProviderSelect").value;
	const model = $("llmModelSelect").value;
	socket.emit("admin:llm", { code: currentLobby, provider, model });
});

// Initialize model list and disable unavailable providers
updateLlmModelSelect();
fetch("/api/features").then(r => r.json()).then(f => {
	const provSel = $("llmProviderSelect");
	for (const opt of provSel.options) {
		if (opt.value === "openai" && !f.openai) { opt.disabled = true; opt.textContent += " (no key)"; }
		if (opt.value === "claude" && !f.claude)  { opt.disabled = true; opt.textContent += " (no key)"; }
	}
}).catch(() => {});

// Phase & Turn
$("phaseCharacter").addEventListener("click", () => {
	if (!currentLobby) return;
	socket.emit("admin:phase", { code: currentLobby, phase: "characterCreation" });
});
$("phaseReady").addEventListener("click", () => {
	if (!currentLobby) return;
	socket.emit("admin:phase", { code: currentLobby, phase: "readyCheck" });
});
$("phaseRunning").addEventListener("click", () => {
	if (!currentLobby) return;
	socket.emit("admin:phase", { code: currentLobby, phase: "running" });
});
$("nextTurn").addEventListener("click", () => {
	if (!currentLobby) return;
	socket.emit("admin:nextTurn", { code: currentLobby });
});

// ═══ STORY SUMMARY ═══
function renderStorySummary() {
	const el = $("storySummaryDisplay");
	if (!el) return;
	if (!currentState) { el.textContent = "No lobby connected."; return; }
	const ctx = currentState.storyContext;
	el.textContent = (ctx && ctx !== "—") ? ctx : "No story summary yet — one will be generated after a few turns.";
}
$("refreshSummary").addEventListener("click", () => {
	if (currentLobby) socket.emit("admin:connect", { code: currentLobby });
	renderStorySummary();
});
$("copySummary").addEventListener("click", () => {
	const text = $("storySummaryDisplay").textContent;
	navigator.clipboard.writeText(text).then(() => {
		const btn = $("copySummary");
		btn.textContent = "Copied!";
		setTimeout(() => btn.textContent = "Copy to Clipboard", 1500);
	});
});

// ═══ RAW LOBBY JSON ═══
function renderRawJson() {
	$("rawJsonDisplay").textContent = currentState ? JSON.stringify(currentState, null, 2) : "No lobby connected.";
}
$("refreshRawJson").addEventListener("click", () => {
	if (currentLobby) socket.emit("admin:connect", { code: currentLobby });
	renderRawJson();
});
$("copyRawJson").addEventListener("click", () => {
	const text = $("rawJsonDisplay").textContent;
	navigator.clipboard.writeText(text).then(() => {
		const btn = $("copyRawJson");
		btn.textContent = "Copied!";
		setTimeout(() => btn.textContent = "Copy to Clipboard", 1500);
	});
});

// ═══ KICK / LEVEL UP ═══
window.kickPlayer = function(name) {
	if (!currentLobby) return;
	if (!confirm(`Kick ${name}?`)) return;
	emitEvent("player:kick", { player: name });
};
window.forceLevelUp = function(name) {
	if (!currentLobby) return;
	emitEvent("player:forceLevelUp", { player: name });
};

// ═══ INLINE PLAYER REFRESH ═══
function refreshPlayerCell(name, updates) {
	const rows = Array.from(els.playersTable.querySelectorAll("tr"));
	for (const row of rows) {
		if (row.cells[0]?.textContent?.trim() === name) {
			if (updates.xp !== undefined)    row.cells[4].textContent = updates.xp;
			if (updates.level !== undefined)  row.cells[3].textContent = updates.level;
			if (updates.hp !== undefined)     row.cells[5].textContent = updates.hp;
			if (updates.gold !== undefined)   row.cells[6].textContent = updates.gold;
			break;
		}
	}
}

// ═══ HOST AUTO-CONNECT ═══
(function hostAutoConnect() {
	const params = new URLSearchParams(window.location.search);
	const isHost = params.get("host") === "1";
	const lobby = params.get("lobby");
	const charId = params.get("charId");
	if (!isHost || !lobby || !charId) return;

	// Hide lobby browser and char file tool for host view
	$("lobbyBrowserPanel")?.remove();
	$("charFileSection")?.classList.add("hidden");
	$("logoutBtn").style.display = "none";
	document.title = `DM Options — ${lobby}`;

	function doAuth() {
		socket.emit("host:auth", { lobbyCode: lobby, characterId: charId });
	}
	socket.on("host:auth:ok", ({ lobbyCode }) => {
		currentLobby = lobbyCode;
		socket.emit("admin:connect", { code: lobbyCode });
	});
	if (socket.connected) doAuth(); else socket.on("connect", doAuth);
})();

// ═══ CHARACTER FILE TOOL ═══
(function charFileTool() {
	const dropZone  = $("charDropZone");
	const fileInput = $("charFileInput");
	const statusEl  = $("charFileStatus");
	const editorEl  = $("charFileEditor");
	const nameEl    = $("charFileNameDisplay");
	const sigEl     = $("charFileSigStatus");
	const jsonEl    = $("charFileJson");
	const resignBtn = $("charFileResign");
	const prettyBtn = $("charFilePretty");
	const errorEl   = $("charFileError");
	if (!dropZone) return;

	let currentFileName = "character";

	dropZone.addEventListener("click", () => fileInput.click());
	dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.style.borderColor = "rgba(234,203,131,0.6)"; });
	dropZone.addEventListener("dragleave", () => { dropZone.style.borderColor = ""; });
	dropZone.addEventListener("drop", e => {
		e.preventDefault();
		dropZone.style.borderColor = "";
		const file = e.dataTransfer.files[0];
		if (file) loadCharFile(file);
	});
	fileInput.addEventListener("change", e => {
		if (e.target.files[0]) loadCharFile(e.target.files[0]);
		e.target.value = "";
	});

	async function loadCharFile(file) {
		currentFileName = file.name.replace(/\.stchar$/i, "");
		statusEl.textContent = `Loading ${file.name}...`;
		errorEl.textContent = "";

		let parsed;
		try { parsed = JSON.parse(await file.text()); }
		catch { statusEl.textContent = "Not valid JSON."; return; }

		try {
			const res = await fetch("/api/character/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: parsed.data, sig: parsed.sig }),
			});
			const json = await res.json();

			if (!res.ok) {
				sigEl.className = "sig-invalid";
				sigEl.textContent = "Signature invalid";
				try {
					const raw = JSON.parse(atob(parsed.data));
					nameEl.textContent = raw.name || "Unknown";
					jsonEl.value = JSON.stringify(raw, null, 2);
				} catch { jsonEl.value = "// Could not decode data"; }
			} else {
				sigEl.className = "sig-valid";
				sigEl.textContent = "Signature valid";
				nameEl.textContent = json.character.name || "Unknown";
				jsonEl.value = JSON.stringify({ name: json.character.name, sheet: json.character.sheet }, null, 2);
			}
			editorEl.classList.remove("hidden");
			statusEl.textContent = `Loaded: ${file.name}`;
		} catch (err) {
			statusEl.textContent = "Server error: " + err.message;
		}
	}

	prettyBtn.addEventListener("click", () => {
		errorEl.textContent = "";
		try { jsonEl.value = JSON.stringify(JSON.parse(jsonEl.value), null, 2); }
		catch (err) { errorEl.textContent = "Invalid JSON: " + err.message; }
	});

	resignBtn.addEventListener("click", async () => {
		errorEl.textContent = "";
		let payload;
		try { payload = JSON.parse(jsonEl.value); }
		catch { errorEl.textContent = "Fix JSON errors first."; return; }

		const { name, sheet } = payload;
		if (!name || !sheet) { errorEl.textContent = 'Need "name" and "sheet" keys.'; return; }

		try {
			const res = await fetch("/api/character/export", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, sheet }),
			});
			if (!res.ok) throw new Error((await res.json()).error || "Export failed");

			const exportData = await res.json();
			const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${(name || currentFileName).replace(/\s+/g, "_")}.stchar`;
			a.click();
			URL.revokeObjectURL(url);

			sigEl.className = "sig-valid";
			sigEl.textContent = "Re-signed & downloaded";
		} catch (err) {
			errorEl.textContent = "Re-sign failed: " + err.message;
		}
	});
})();

// ═══ UTIL ═══
function esc(str) {
	const d = document.createElement("div");
	d.textContent = str;
	return d.innerHTML;
}
