function registerSocketEvents() {
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

		if (state.party && state.party.length) {
			drawPartyComponent("partyContainer", state.party);
		}

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

	socket.on("player:left", ({ player }) => {
		console.log(`[socket] player:left received for: ${player}`);
		appendLog(`[System] ${player} has left the adventure.`);
		appendActionLog(`🚪 <strong>${player}</strong> disconnected.`, "system");
	});

	socket.on("player:death", ({ player, message }) => {
		appendLog(`💀 ${message}`);

		// If it's me, lock out action input
		if (me.name === player) {
			showDeathModal();

			document.getElementById("actionInput").disabled = true;
			document.getElementById("actionButton").disabled = true;
			appendLog("☠️ You are dead and can no longer act.");
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

	socket.on("action:rejected", ({ reason }) => {
		appendLog(`[REJECTED] ${reason}\n`);
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

	socket.on("narration", ({ content, status }) => {
		let narrationContent = (content || "").trim();
		if (narrationContent.startsWith('{')) {
			try {
				const parsed = JSON.parse(narrationContent);
				if (typeof parsed.text === "string") narrationContent = parsed.text;
			} catch {}
		}
		appendLog("DM: " + narrationContent + "\n\n");
		if (!(content && content.trim().length > 0) || status === 204) {
			showNarratorIndicator(false);
		}
	});

	socket.on("narration:start", ({ speaker, streamId, status }) => {
		// 🧩 Handle dev mode or no-audio condition gracefully
		if (status === 204 || localStorage.getItem("narrationEnabled") === "false") {
			showNarratorIndicator(false);
			// Signal done immediately so the server can start the turn timer
			document.dispatchEvent(new CustomEvent("narration:playback:ended"));
			return;
		}

		startNarration(speaker, streamId);
	});

	// === LEVEL UP EVENT HANDLING (client-side) ===
	socket.on("player:levelup", ({ newLevel, upcomingAbility }) => {
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

		// Create a modal overlay
		const modal = document.createElement("div");
		modal.classList.add("modal");
		modal.innerHTML = `
    <div class="modal-content">
      <button class="modal-close">✕</button>
      <h3>🎉 Level ${newLevel}!</h3>
      ${abilityPreviewHTML}
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

			socket.emit("player:levelup:confirm", { lobbyId, gains });
			modal.remove();
			appendLog(`✅ Level-up applied locally and sent to server.\n`);
		});
	});

	// Confirmation from server
	socket.on("player:levelup:confirm", ({ newStats, newLevel, hpGained, newAbility }) => {
		appendLog("✨ Level-up confirmed by server.\n");

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

		const thresholds = [0, 300, 900, 2700, 6500];
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
		drawInventoryComponent("gameInventoryContainer", p.inventory, false);
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
			showToast("The party has been wiped out. Game over.", "error");
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
	});

	socket.on("timer:cancel", () => {
		stopTimerDisplay();
	});

	// Listen for lock/unlock signals
	socket.on("ui:lock", ({ actor }) => lockUI(actor));
	socket.on("ui:unlock", () => unlockUI());

	// Subscribe to live lobby list updates (for landing page)
	socket.on("connect", () => {
		socket.emit("lobbies:watch");
	});
	socket.emit("lobbies:watch"); // also subscribe immediately if already connected

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
