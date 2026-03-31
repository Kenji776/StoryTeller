const socket = io();
let currentLobby = null;

// Logout handler
document.getElementById("logoutBtn").addEventListener("click", async () => {
	await fetch("/api/admin/logout", { method: "POST" });
	window.location.href = "/admin/login.html";
});

const els = {
	connectLobby: document.getElementById("connectLobby"),
	adminJoinCode: document.getElementById("adminJoinCode"),
	adminControls: document.getElementById("adminControls"),
	playersTable: document.getElementById("playersTable").querySelector("tbody"),
	playerSelect: document.getElementById("playerSelect"),

	// XP / HP / Gold / Inventory controls
	xpAmount: document.getElementById("xpAmount"),
	xpReason: document.getElementById("xpReason"),
	addXP: document.getElementById("addXP"),

	hpDelta: document.getElementById("hpDelta"),
	hpReason: document.getElementById("hpReason"),
	addHP: document.getElementById("addHP"),

	goldDelta: document.getElementById("goldDelta"),
	goldReason: document.getElementById("goldReason"),
	addGold: document.getElementById("addGold"),

	killPlayerBtn: document.getElementById("killPlayer"),

	rollSides: document.getElementById("rollSides"),
	rollMods: document.getElementById("rollMods"),
	rollStats: document.getElementById("rollStats"),
	sendRollRequired: document.getElementById("sendRollRequired"),

	condAddSelect: document.getElementById("condAddSelect"),
	condRemoveSelect: document.getElementById("condRemoveSelect"),
	applyConditions: document.getElementById("applyConditions"),

	slotDelta: document.getElementById("slotDelta"),
	applySlots: document.getElementById("applySlots"),

	invItem: document.getElementById("invItem"),
	invChange: document.getElementById("invChange"),
	invReason: document.getElementById("invReason"),
	invApply: document.getElementById("invApply"),

	// Music
	musicMoodSelect: document.getElementById("musicMoodSelect"),
	sendMusicChange: document.getElementById("sendMusicChange"),
	sendMusicStop: document.getElementById("sendMusicStop"),
	currentMoodLabel: document.getElementById("currentMoodLabel"),

	// Game control + DM
	phaseCharacter: document.getElementById("phaseCharacter"),
	phaseReady: document.getElementById("phaseReady"),
	phaseRunning: document.getElementById("phaseRunning"),
	nextTurn: document.getElementById("nextTurn"),
	sendDM: document.getElementById("sendDM"),
	dmMessage: document.getElementById("dmMessage"),
	lobbyInfo: document.getElementById("lobbyInfo"),
	statusBadge: document.getElementById("statusBadge"),
};

// === Socket Lifecycle ===
function log(msg) {
	console.log("[ADMIN]", msg);
	els.lobbyInfo.textContent += (els.lobbyInfo.textContent ? "\n" : "") + msg;
	els.lobbyInfo.scrollTop = els.lobbyInfo.scrollHeight;
}

socket.on("connect", () => {
	log(`✅ Socket connected: ${socket.id}`);
	els.statusBadge.textContent = "Connected (idle)";
});
socket.on("disconnect", (reason) => {
	log(`❌ Socket disconnected: ${reason}`);
	els.statusBadge.textContent = "Disconnected";
});
socket.on("connect_error", (err) => {
	log(`💥 connect_error: ${err?.message || err}`);
	els.statusBadge.textContent = "Connection Error";
});

// === Connect to Lobby ===
els.connectLobby.addEventListener("click", () => {
	const code = els.adminJoinCode.value.trim().toUpperCase();
	if (!code) return alert("Enter a lobby code");
	currentLobby = code;
	log(`🔌 Emitting admin:connect for code ${code}`);
	socket.emit("admin:connect", { code });
	setTimeout(() => {
		if (els.statusBadge.textContent.startsWith("Connected")) return;
		log("⏳ No response to admin:connect yet...");
	}, 1000);
});

socket.on("admin:connected", (state) => {
	log(`✅ admin:connected received for lobby ${state.code}`);
	els.adminControls.classList.remove("hidden");
	els.statusBadge.textContent = `Connected to ${state.code}`;
	if (els.currentMoodLabel) {
		els.currentMoodLabel.textContent = state.currentMusic ? state.currentMusic.replace(/_/g, " ") : "—";
	}
	renderLobby(state);
});

// === PLAYER EVENTS ===

// XP
els.addXP.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	const amount = parseInt(els.xpAmount.value, 10) || 0;
	const reason = els.xpReason.value.trim() || "Manual adjustment";
	if (!player || !currentLobby) return alert("Missing player or lobby");
	log(`🧮 XP EVENT → ${player} +${amount} XP (${reason})`);
	socket.emit("admin:event", { code: currentLobby, type: "xp:update", payload: { player, amount, reason } });
});

// HP
els.addHP.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	const delta = parseInt(els.hpDelta.value, 10) || 0;
	const reason = els.hpReason.value.trim() || "Manual HP change";
	if (!player || !currentLobby) return alert("Missing player or lobby");
	log(`❤️ HP EVENT → ${player} ${delta >= 0 ? "+" : ""}${delta} (${reason})`);
	socket.emit("admin:event", { code: currentLobby, type: "hp:update", payload: { player, delta, reason } });
});

// Gold
els.addGold.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	const delta = parseInt(els.goldDelta.value, 10) || 0;
	const reason = els.goldReason.value.trim() || "Manual gold change";
	if (!player || !currentLobby) return alert("Missing player or lobby");
	log(`💰 GOLD EVENT → ${player} ${delta >= 0 ? "+" : ""}${delta} (${reason})`);
	socket.emit("admin:event", { code: currentLobby, type: "gold:update", payload: { player, delta, reason } });
});

// Spell Slots
els.applySlots.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	const delta = parseInt(els.slotDelta.value, 10) || 0;
	if (!player || !currentLobby) return alert("Missing player or lobby");
	const dir = delta >= 0 ? `+${delta} used (fewer remaining)` : `${delta} used (restored)`;
	log(`🔮 SPELL SLOTS → ${player} ${dir}`);
	socket.emit("admin:event", { code: currentLobby, type: "spellslots:update", payload: { player, delta } });
});

// Inventory
els.invApply.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	const item = els.invItem.value.trim();
	const change = parseInt(els.invChange.value, 10) || 0;
	const reason = els.invReason.value.trim() || "Manual inventory change";
	if (!player || !item || !currentLobby) return alert("Missing fields");
	log(`🎒 INV EVENT → ${player} ${change >= 0 ? "gains" : "loses"} ${Math.abs(change)} × ${item} (${reason})`);
	socket.emit("admin:event", { code: currentLobby, type: "inventory:update", payload: { player, item, change, description: reason } });
});

// Roll Required (test)
els.sendRollRequired.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	if (!player || !currentLobby) return alert("Select a player first");
	const sides = Number(els.rollSides.value);
	const mods = Number(els.rollMods.value) || 0;
	const stats = Array.from(els.rollStats.selectedOptions).map(o => o.value);
	log(`🎲 ROLL REQUIRED → ${player} must roll d${sides} | stats: [${stats.join(", ")}] | mod: ${mods}`);
	socket.emit("admin:event", { code: currentLobby, type: "roll:required", payload: { player, sides, stats, mods } });
});

// Conditions
els.applyConditions.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	if (!player || !currentLobby) return alert("Select a player first");
	const add = Array.from(els.condAddSelect.selectedOptions).map(o => o.value);
	const remove = Array.from(els.condRemoveSelect.selectedOptions).map(o => o.value);
	if (!add.length && !remove.length) return alert("Select at least one condition to add or remove");
	log(`🌀 CONDITIONS → ${player} | add: [${add.join(", ")}] | remove: [${remove.join(", ")}]`);
	socket.emit("admin:event", { code: currentLobby, type: "conditions:update", payload: { player, add, remove } });
	els.condAddSelect.selectedIndex = -1;
	els.condRemoveSelect.selectedIndex = -1;
});

// === Kill Player (Death Test) ===

els.killPlayerBtn.addEventListener("click", () => {
	const player = els.playerSelect.value.trim();
	if (!player || !currentLobby) return alert("Select a player first");

	if (!confirm(`💀 Are you sure you want to kill ${player}?`)) return;

	log(`☠️ FORCING DEATH → ${player}`);
	socket.emit("admin:event", {
		code: currentLobby,
		type: "player:death",
		payload: { player },
	});
});

// === RENDER LOBBY ===
function renderLobby(state) {
	els.lobbyInfo.textContent = JSON.stringify(state, null, 2);
	const players = Object.values(state.players || {});
	els.playersTable.innerHTML = "";

	players.forEach((p) => {
		const row = document.createElement("tr");
		row.innerHTML = `
			<td>${p.name}</td>
			<td>${p.class}</td>
			<td>${p.level}</td>
			<td>${p.xp || 0}</td>
			<td>${p.stats?.hp ?? 0}</td>
			<td>${p.gold ?? 0}</td>
			<td>
				<button class="small" onclick="forceLevelUp('${p.name}')">Level Up</button>
				<button class="small" onclick="kickPlayer('${p.name}')">Kick</button>
			</td>
		`;
		els.playersTable.appendChild(row);
	});

	// Refresh dropdown
	const select = els.playerSelect;
	select.innerHTML = '<option value="">— Choose Player —</option>';
	players.forEach((p) => {
		const opt = document.createElement("option");
		opt.value = p.name;
		opt.textContent = p.name;
		select.appendChild(opt);
	});
}

// === PHASES / TURN ===
els.phaseCharacter.addEventListener("click", () => {
	log("🔄 Phase → characterCreation");
	socket.emit("admin:phase", { code: currentLobby, phase: "characterCreation" });
});
els.phaseReady.addEventListener("click", () => {
	log("🔄 Phase → readyCheck");
	socket.emit("admin:phase", { code: currentLobby, phase: "readyCheck" });
});
els.phaseRunning.addEventListener("click", () => {
	log("🔄 Phase → running");
	socket.emit("admin:phase", { code: currentLobby, phase: "running" });
});
els.nextTurn.addEventListener("click", () => {
	log("⏭️ Next Turn");
	socket.emit("admin:nextTurn", { code: currentLobby });
});

// === MUSIC CONTROL ===
els.sendMusicChange.addEventListener("click", () => {
	const mood = els.musicMoodSelect.value;
	if (!mood || !currentLobby) return alert("Select a mood and connect to a lobby first");
	log(`🎵 MUSIC → ${mood}`);
	socket.emit("admin:music", { code: currentLobby, mood });
});

els.sendMusicStop.addEventListener("click", () => {
	if (!currentLobby) return alert("Not connected to a lobby");
	log(`⏹ MUSIC STOP`);
	socket.emit("admin:music", { code: currentLobby, mood: null });
});

socket.on("music:change", ({ mood }) => {
	if (els.currentMoodLabel) {
		els.currentMoodLabel.textContent = mood ? mood.replace(/_/g, " ") : "—";
	}
});

// === DM TOOLS ===
els.sendDM.addEventListener("click", () => {
	const text = els.dmMessage.value.trim();
	if (!text) return;
	log(`📜 DM MESSAGE (${text.length} chars)`);
	socket.emit("admin:dm", { code: currentLobby, content: text });
	els.dmMessage.value = "";
});

// === UPDATES FROM SERVER ===
socket.on("admin:update", (state) => {
	log("🔁 admin:update received");
	renderLobby(state);
});
socket.on("toast", ({ type, message }) => {
	log(`[${(type || "info").toUpperCase()}] ${message}`);
});

// === TAB SWITCHING ===
document.querySelectorAll(".tab-btn").forEach((btn) => {
	btn.addEventListener("click", () => {
		document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
		document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
		btn.classList.add("active");
		document.getElementById(btn.dataset.tab).classList.add("active");
	});
});

function kickPlayer(playerName) {
	if (!currentLobby) return alert("Not connected to a lobby");
	if (!confirm(`Kick ${playerName} from the lobby?`)) return;
	log(`👢 KICK → ${playerName}`);
	socket.emit("admin:event", { code: currentLobby, type: "player:kick", payload: { player: playerName } });
}

function forceLevelUp(playerName) {
	if (!currentLobby) return alert("Not connected to a lobby");
	if (!playerName) return alert("No player name specified");

	log(`⬆️ FORCE LEVEL UP → ${playerName}`);
	socket.emit("admin:event", {
		code: currentLobby,
		type: "player:forceLevelUp",
		payload: { player: playerName },
	});
}

// === LOBBY MANAGER ===
async function loadLobbyManager() {
	const list = document.getElementById("lobbyManagerList");
	if (!list) return;
	try {
		const res = await fetch("/api/lobbies");
		const lobbies = await res.json();
		if (!lobbies.length) {
			list.innerHTML = "<em style='color:#aaa;'>No lobbies found.</em>";
			return;
		}
		list.innerHTML = lobbies.map(l => `
			<div style="display:flex;align-items:center;justify-content:space-between;background:#1e1e2e;padding:0.5em 0.75em;border-radius:6px;">
				<span>
					<strong style="color:#ffd166;">${l.adventureName || "Untitled"}</strong>
					<span style="color:#aaa;font-size:0.85em;margin-left:0.5em;">[${l.code}]</span>
					<span style="color:#888;font-size:0.82em;margin-left:0.5em;">${l.phase} &bull; ${l.playerCount} player(s)</span>
				</span>
				<button onclick="deleteLobby('${l.code}')" style="background:#c0392b;color:#fff;border:none;padding:0.3em 0.8em;border-radius:4px;cursor:pointer;">Delete</button>
			</div>
		`).join("");
	} catch (e) {
		list.innerHTML = "<em style='color:#f88;'>Failed to load lobbies.</em>";
	}
}

function deleteLobby(code) {
	if (!confirm(`Delete lobby ${code}? This cannot be undone.`)) return;
	socket.emit("admin:deleteLobby", { code });
}

socket.on("admin:lobbyDeleted", ({ code }) => {
	log(`🗑️ Lobby ${code} deleted`);
	loadLobbyManager();
});

loadLobbyManager();

// === HOST AUTO-CONNECT ===
// When opened from the game screen via DM Options, URL has ?host=1&lobby=CODE&charId=ID
(function hostAutoConnect() {
	const params = new URLSearchParams(window.location.search);
	const isHost = params.get("host") === "1";
	const lobby = params.get("lobby");
	const charId = params.get("charId");
	if (!isHost || !lobby || !charId) return;

	// Hide lobby manager, connect controls, and logout — host is scoped to their game
	const sections = document.querySelectorAll("section.panel");
	sections.forEach(sec => {
		// Hide "Manage Lobbies" and "Connect to Lobby" sections
		const heading = sec.querySelector("h2");
		if (heading && (heading.textContent.includes("Manage Lobbies") || heading.textContent.includes("Connect to Lobby"))) {
			sec.style.display = "none";
		}
	});
	const logoutBtn = document.getElementById("logoutBtn");
	if (logoutBtn) logoutBtn.style.display = "none";

	document.title = `DM Options — ${lobby}`;

	// Wait for socket to connect, then authenticate and auto-connect
	function doAuth() {
		log(`🔑 Host auto-auth for lobby ${lobby}`);
		socket.emit("host:auth", { lobbyCode: lobby, characterId: charId });
	}

	socket.on("host:auth:ok", ({ lobbyCode }) => {
		log(`✅ Host auth successful, connecting to ${lobbyCode}`);
		currentLobby = lobbyCode;
		socket.emit("admin:connect", { code: lobbyCode });
	});

	if (socket.connected) {
		doAuth();
	} else {
		socket.on("connect", doAuth);
	}
})();

// === PLAYER REFRESH ===
function refreshPlayer(name, updates) {
	if (!els.playersTable) return;
	const rows = Array.from(els.playersTable.querySelectorAll("tr"));
	for (const row of rows) {
		if (row.cells[0]?.textContent?.trim() === name) {
			if (updates.xp !== undefined) row.cells[3].textContent = updates.xp;
			if (updates.level !== undefined) row.cells[2].textContent = updates.level;
			if (updates.hp !== undefined) row.cells[4].textContent = updates.hp;
			if (updates.gold !== undefined) row.cells[5].textContent = updates.gold;
			break;
		}
	}
}
