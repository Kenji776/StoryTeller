// === uiComponents.js ===

const DND_CONDITIONS = [
	{ name: "blinded",       emoji: "🙈", effect: "Can't see. Auto-fails sight checks. Attack rolls against it have advantage; its attack rolls have disadvantage." },
	{ name: "burning",       emoji: "🔥", effect: "On fire. Takes fire damage at the start of each turn until extinguished (action to stop, drop, and roll)." },
	{ name: "charmed",       emoji: "💞", effect: "Can't attack the charmer. The charmer has advantage on social checks against it." },
	{ name: "deafened",      emoji: "🔇", effect: "Can't hear. Auto-fails hearing checks." },
	{ name: "exhausted",     emoji: "😩", effect: "Suffers cumulative penalties at each level: disadvantage on checks, speed halved, attack/save disadvantage, speed 0, death." },
	{ name: "frightened",    emoji: "😱", effect: "Disadvantage on ability checks and attack rolls while source of fear is in sight. Can't willingly move closer to the source." },
	{ name: "grappled",      emoji: "🤼", effect: "Speed becomes 0. Ends if the grappler is incapacitated or moved out of range." },
	{ name: "incapacitated", emoji: "💫", effect: "Can't take actions or reactions." },
	{ name: "invisible",     emoji: "👻", effect: "Impossible to see without magic. Attacks against it have disadvantage; its attacks have advantage." },
	{ name: "paralyzed",     emoji: "⚡", effect: "Incapacitated and can't move or speak. Auto-fails Str/Dex saves. Attacks have advantage; hits within 5 ft. are critical hits." },
	{ name: "petrified",     emoji: "🗿", effect: "Transformed to stone. Incapacitated, weight ×10, resistant to all damage, immune to poison/disease." },
	{ name: "poisoned",      emoji: "🤢", effect: "Disadvantage on attack rolls and ability checks." },
	{ name: "prone",         emoji: "🛌", effect: "Melee attacks against it have advantage. Ranged attacks have disadvantage. Must use half movement to stand up." },
	{ name: "restrained",    emoji: "🕸️", effect: "Speed 0. Attack rolls against it have advantage; its attacks have disadvantage. Disadvantage on Dex saves." },
	{ name: "stunned",       emoji: "💥", effect: "Incapacitated, can't move, barely speaks. Auto-fails Str/Dex saves. Attack rolls against it have advantage." },
	{ name: "unconscious",   emoji: "💤", effect: "Incapacitated, can't move or speak, unaware. Drops held items. Attacks have advantage; hits within 5 ft. are critical hits." },
];

const CONDITION_MAP = Object.fromEntries(DND_CONDITIONS.map(c => [c.name.toLowerCase(), c]));

function formatConditions(conditionsStr) {
	if (!conditionsStr || conditionsStr === "None") return "None";
	return conditionsStr.split(",").map(c => {
		const key = c.trim().toLowerCase();
		const def = CONDITION_MAP[key];
		if (def) return `<span class="condition-tag" title="${def.effect}">${def.emoji} ${def.name}</span>`;
		return `<span class="condition-tag">${c.trim()}</span>`;
	}).join(" ");
}

function showConditionsInfoModal() {
	document.querySelectorAll(".conditions-modal").forEach(m => m.remove());
	const modal = document.createElement("div");
	modal.className = "modal conditions-modal";
	const rows = DND_CONDITIONS.map(c =>
		`<tr><td>${c.emoji}</td><td><strong>${c.name}</strong></td><td>${c.effect}</td></tr>`
	).join("");
	modal.innerHTML = `
		<div class="modal-content modal-wide">
			<button class="modal-close">✕</button>
			<h2>⚔️ Conditions Reference</h2>
			<p style="color:#aaa;font-size:0.85em;text-align:center;">Standard D&amp;D 5e conditions that can be applied during play.</p>
			<table style="width:100%;border-collapse:collapse;font-size:0.88em;">
				<thead><tr style="color:#ffd166;border-bottom:1px solid #555;">
					<th style="padding:4px 8px;text-align:left;"></th>
					<th style="padding:4px 8px;text-align:left;">Condition</th>
					<th style="padding:4px 8px;text-align:left;">Effect</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
	`;
	modal.querySelectorAll("tbody tr").forEach((row, i) => {
		row.style.cssText = `border-bottom:1px solid rgba(255,255,255,0.08);${i % 2 ? "background:rgba(255,255,255,0.03)" : ""}`;
		row.querySelectorAll("td").forEach(td => { td.style.padding = "5px 8px; vertical-align:top"; });
	});
	document.body.appendChild(modal);
	modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
}

/**
 * Fetch an HTML template (cached after first load).
 */
const templateCache = {};
async function getTemplate(path) {
	if (templateCache[path]) return templateCache[path];
	const res = await fetch(path);
	const html = await res.text();
	templateCache[path] = html;
	return html;
}

/**
 * Draws an inventory table into a container.
 * @param {string} containerId - ID of the target <div>
 * @param {Array} items - Array of { name, count, description }
 */
/**
 * Detect whether an inventory item is equippable, and which slot it fits.
 *
 * The decision lives in `/itemSlots.js`, a pure module the unit tier covers;
 * `index.html` attaches it to `window`. Kept as a wrapper so a render pass during
 * the brief window before the module script runs degrades to "not equippable"
 * rather than throwing.
 *
 * @param {object} item - An inventory item.
 * @returns {"weapon"|"armor"|"trinket"|null} The slot, or null.
 */
function _detectEquipSlot(item) {
	return window.equipSlotFor ? window.equipSlotFor(item) : null;
}

async function drawInventoryComponent(containerId, items = [], canAdd = false, equipped = {}) {
	const container = document.getElementById(containerId);
	if (!container) return console.warn(`drawInventoryComponent: #${containerId} not found`);

	// Equip and Use act on a running game — they emit socket events against a lobby —
	// so they belong to the in-play panel and not to the character builder, where
	// there is nothing to act on and the buttons only invite a click that does
	// nothing. Derived from the container rather than from `canAdd`, which means
	// "offer an Add button" and which two of the builder's own call sites omit
	// anyway. Anything that is not the game panel gets no action buttons, which is
	// the safe default for a container added later.
	const inPlay = containerId === "gameInventoryContainer";

	const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
	const template = await getTemplate("/components/inventory.html");

	container.innerHTML = `
		<div class="component-box">
			<div class="component-header">
				<span>🎒 Inventory</span>
				${canAdd ? '<button id="invAddBtn">+ Add</button>' : ""}
			</div>
			${template}
		</div>
	`;

	const tbody = container.querySelector("#inventoryRows");
	if (!sorted.length) {
		tbody.innerHTML = `<tr><td colspan="4" class="hint">Empty</td></tr>`;
		return;
	}

	for (const item of sorted) {
		const slot = _detectEquipSlot(item);
		const row = document.createElement("tr");

		let equipBtn = "";
		if (slot && inPlay) {
			const slotLabel = slot === "weapon" ? "⚔️" : slot === "armor" ? "🛡️" : "💍";
			const isEquipped = equipped[slot] && equipped[slot].toLowerCase() === item.name.toLowerCase();
			if (isEquipped) {
				equipBtn = `<button class="equip-btn chip equipped-indicator" data-item="${item.name.replace(/"/g, "&quot;")}" data-slot="${slot}" data-action="unequip" data-sound="Sword Unsheathe" data-sound-hover="Magical Shimmer" title="Unequip from ${slot}">${slotLabel} Unequip</button>`;
			} else {
				equipBtn = `<button class="equip-btn chip" data-item="${item.name.replace(/"/g, "&quot;")}" data-slot="${slot}" data-sound="Sword Unsheathe" data-sound-hover="Magical Shimmer" title="Equip as ${slot}">${slotLabel} Equip</button>`;
			}
		}

		// A consumable is spent, not worn, so it gets a Use button instead of an
		// Equip one.
		let useBtn = "";
		if (inPlay && window.isConsumable && window.isConsumable(item)) {
			useBtn = `<button class="equip-btn chip" data-item="${item.name.replace(/"/g, "&quot;")}" data-action="use" data-sound="Magical Shimmer" data-sound-hover="Magical Shimmer" title="Use ${item.name}">🧪 Use</button>`;
		}

		// Show attributes summary for equippable items
		const a = item.attributes || {};
		let statsHint = "";
		if (a.damage) statsHint += ` [${a.damage} ${a.damage_type || ""}]`;
		if (a.ac) statsHint += ` [AC ${a.ac}]`;
		if (a.healing) statsHint += ` [heals ${a.healing}]`;

		row.innerHTML = `
			<td><strong>${item.name}</strong>${statsHint ? `<span style="opacity:0.6;font-size:0.85em;">${statsHint}</span>` : ""}</td>
			<td>${item.count ?? 1}</td>
			<td>${item.description || ""}</td>
			<td>${equipBtn}${useBtn}</td>
		`;
		tbody.appendChild(row);

		console.log(`🎒 Inventory item: "${item.name}" | slot=${slot || "none"} | attributes=`, item.attributes);
	}

	// Wire up equip / unequip buttons
	container.querySelectorAll("button.equip-btn").forEach(btn => {
		btn.addEventListener("click", () => {
			const itemName = btn.dataset.item;
			const slot = btn.dataset.slot;
			const ACTIONS = { unequip: "item:unequip", use: "item:use" };
			const action = ACTIONS[btn.dataset.action] || "item:equip";
			console.log(`⚔️ ${action} clicked: "${itemName}"${slot ? ` → ${slot}` : ""}`);
			if (typeof socket !== "undefined" && socket) {
				socket.emit(action, { lobbyId, itemName, slot });
			}
		});
	});

	if (canAdd) {
		container.querySelector("#invAddBtn").onclick = () =>
			showAddModal("Item", (entry) => {
				sorted.push({ ...entry, count: 1 });
				drawInventoryComponent(containerId, sorted, true);
			});
	}
}

/**
 * Draws an attributes table into a container.
 * @param {string} containerId - ID of the target <div>
 * @param {Object} attributes - e.g. { str: 12, dex: 14, con: 10, ... }
 */
async function drawAbilitiesComponent(containerId, abilities = [], canAdd = false, canUse = false) {
	const container = document.getElementById(containerId);
	if (!container) return console.warn(`drawAbilitiesComponent: #${containerId} not found`);

	const sorted = [...abilities].sort((a, b) => (a.level || 1) - (b.level || 1) || a.name.localeCompare(b.name));
	const template = await getTemplate("/components/abilities.html");

	container.innerHTML = `
		<div class="component-box">
			<div class="component-header">
				<span>✨ Abilities</span>
				${canAdd ? '<button id="abilityAddBtn">+ Add</button>' : ""}
			</div>
			${template}
		</div>
	`;

	// Inject the "Action" column header when in-game
	if (canUse) {
		const headerRow = container.querySelector("thead tr");
		if (headerRow) {
			const th = document.createElement("th");
			th.textContent = "Action";
			th.className = "col-action";
			headerRow.appendChild(th);
		}
	}

	const totalCols = canUse ? 5 : 4;
	const tbody = container.querySelector("#abilityRows");
	if (!sorted.length) {
		tbody.innerHTML = `<tr><td colspan="${totalCols}" class="hint">No abilities</td></tr>`;
		return;
	}

	for (const ability of sorted) {
		const detailsHTML = ability.details
			? Object.entries(ability.details)
					.map(([k, v]) => `<strong>${k}:</strong> ${v}`)
					.join("<br>")
			: "—";

		// Determine if this ability reads as a spell (has damage/save/range in details)
		const isSpell = !!(ability.details?.damage || ability.details?.save);
		const verb = isSpell ? "cast" : "use";
		const noun = isSpell ? "spell" : "ability";

		const row = document.createElement("tr");
		row.innerHTML = `
			<td class="col-lvl">${ability.level || 1}</td>
			<td class="col-name"><strong>${ability.name}</strong></td>
			<td class="col-desc">${ability.description || ""}</td>
			<td class="col-details smalltext">${detailsHTML}</td>
			${canUse ? `<td class="col-action"><button class="use-ability-btn secondary" style="padding:2px 8px;font-size:0.8em;" data-verb="${verb}" data-noun="${noun}" data-name="${ability.name.replace(/"/g, '&quot;')}">${isSpell ? "Cast" : "Use"}</button></td>` : ""}
		`;
		tbody.appendChild(row);
	}

	// Wire up Use/Cast buttons
	if (canUse) {
		// Check remaining slots from global currentState
		const me = window.me;
		const playerData = me?.name ? window.currentState?.players?.[me.name] : null;
		const maxSlots = Number(playerData?.level) || 1;
		const slotsLeft = Math.max(0, maxSlots - (Number(playerData?.spellSlotsUsed) || 0));
		const outOfSlots = slotsLeft === 0;

		tbody.querySelectorAll(".use-ability-btn").forEach((btn) => {
			if (outOfSlots) {
				btn.disabled = true;
				btn.title = "No spell slots / uses remaining";
			}
			btn.addEventListener("click", () => {
				// Re-check at click time in case state changed
				const pd = me?.name ? window.currentState?.players?.[me.name] : null;
				const maxS = Number(pd?.level) || 1;
				const left = Math.max(0, maxS - (Number(pd?.spellSlotsUsed) || 0));
				if (left === 0) {
					showToast("No spell slots / uses remaining!", "danger");
					return;
				}
				const { verb, noun, name } = btn.dataset;
				const text = `I ${verb} my ${noun} ${name}`;
				const actionInput = document.getElementById("actionInput");
				if (actionInput) {
					actionInput.value = text;
					actionInput.focus();
					// Place cursor at end so the player can immediately append a target
					actionInput.setSelectionRange(text.length, text.length);
				}
			});
		});
	}

	if (canAdd) {
		container.querySelector("#abilityAddBtn").onclick = () =>
			showAddModal("Ability", (entry) => {
				sorted.push({ ...entry, details: {} });
				drawAbilitiesComponent(containerId, sorted, true, canUse);
			});
	}
}

/**
 * Draws the caster's known spells, with a button that writes the cast into the action box.
 *
 * @description Rows arrive already joined to the catalogue by `describeKnownSpells`, so
 *   this holds no rules — including which spells are free. That matters for the button:
 *   the abilities table disables everything at zero slots, which would be wrong here,
 *   because a caster out of slots can still throw cantrips all day and that is exactly
 *   when they most need to find them.
 * @param {string} containerId - ID of the target <div>.
 * @param {Array<object>} rows - Display rows from `describeKnownSpells`.
 * @param {boolean} [canCast=false] - Whether to offer the Cast button (in-game only).
 * @returns {void}
 */
function drawSpellsComponent(containerId, rows = [], canCast = false) {
	const container = document.getElementById(containerId);
	if (!container) return console.warn(`drawSpellsComponent: #${containerId} not found`);

	// A non-caster gets no box at all rather than an empty one promising something.
	if (!rows.length) {
		container.innerHTML = "";
		return;
	}

	const body = rows.map((row) => `
		<tr>
			<td class="col-lvl smalltext">${row.cost}</td>
			<td class="col-name"><strong>${row.name}</strong></td>
			<td class="col-desc smalltext">${row.effect}</td>
			${canCast ? `<td class="col-action"><button class="cast-spell-btn secondary" style="padding:2px 8px;font-size:0.8em;" data-name="${row.name.replace(/"/g, "&quot;")}" data-free="${row.free}">Cast</button></td>` : ""}
		</tr>`).join("");

	container.innerHTML = `
		<div class="component-box">
			<div class="component-header"><span>📖 Spells</span></div>
			<table class="component-table">
				<thead><tr><th>Cost</th><th>Name</th><th>Effect</th>${canCast ? '<th class="col-action">Action</th>' : ""}</tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>
	`;

	if (!canCast) return;

	container.querySelectorAll(".cast-spell-btn").forEach((btn) => {
		const free = btn.dataset.free === "true";
		/**
		 * @description Reads the slots left for the local player at click time, because
		 *   state moves between render and click.
		 * @returns {number} Slots remaining.
		 */
		const slotsLeft = () => {
			const me = window.me;
			const pd = me?.name ? window.currentState?.players?.[me.name] : null;
			return Math.max(0, (Number(pd?.level) || 1) - (Number(pd?.spellSlotsUsed) || 0));
		};

		if (!free && slotsLeft() === 0) {
			btn.disabled = true;
			btn.title = "No spell slots remaining";
		}
		btn.addEventListener("click", () => {
			if (!free && slotsLeft() === 0) {
				showToast("No spell slots remaining!", "danger");
				return;
			}
			// Phrased the way the server's resolver recognises a cast.
			const text = `I cast ${btn.dataset.name}`;
			const actionInput = document.getElementById("actionInput");
			if (!actionInput) return;
			actionInput.value = text;
			actionInput.focus();
			// Cursor at the end, so a target can be appended without repositioning.
			actionInput.setSelectionRange(text.length, text.length);
		});
	});
}

async function drawAttributesComponent(containerId, attributes = {}, canAdd = false) {
	const container = document.getElementById(containerId);
	if (!container) return console.warn(`drawAttributesComponent: #${containerId} not found`);

	const sortedKeys = Object.keys(attributes).sort();
	const template = await getTemplate("/components/attributes.html");

	container.innerHTML = `
		<div class="component-box">
			<div class="component-header">
				<span>📜 Attributes</span>
				${canAdd ? '<button id="attrAddBtn">+ Add</button>' : ""}
			</div>
			${template}
		</div>
	`;

	const tbody = container.querySelector("#attrRows");
	if (!sortedKeys.length) {
		tbody.innerHTML = `<tr><td colspan="2" class="hint">No attributes</td></tr>`;
		return;
	}

	for (const key of sortedKeys) {
		const row = document.createElement("tr");
		row.innerHTML = `
			<td><strong>${key.toUpperCase()}</strong></td>
			<td>${attributes[key]}</td>
		`;
		tbody.appendChild(row);
	}

	if (canAdd) {
		container.querySelector("#attrAddBtn").onclick = () =>
			showAddModal("Attribute", (entry) => {
				attributes[entry.name] = entry.description;
				drawAttributesComponent(containerId, attributes, true);
			});
	}
}

/**
 * Draws a party status table into a container.
 * @param {string} containerId - ID of the target <div>
 * @param {Array} members - Array of { name, hp, maxHp, status? }
 */
async function drawPartyComponent(containerId, members = [], canAdd = false, hostPlayer = null) {

    console.log("Drawing party component update");
	console.log(members);

	const container = document.getElementById(containerId);
	if (!container) return console.warn(`drawPartyComponent: #${containerId} not found`);

	const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
	const template = await getTemplate("/components/party.html");

	container.innerHTML = `
		<div class="component-box">
			<div class="component-header">
				<span>🧙 Party Members</span>
				${canAdd ? '<button id="partyAddBtn">+ Add</button>' : ""}
			</div>
			${template}
		</div>
	`;

	const tbody = container.querySelector("#partyRows");
	if (!sorted.length) {
		tbody.innerHTML = `<tr><td colspan="4" class="hint">No party members</td></tr>`;
		return;
	}

	for (const member of sorted) {
		const hp = Number(member.hp) || 0;
		const max_hp = Number(member.max_hp) || 1;
		const percent = Math.max(0, Math.min(100, (hp / max_hp) * 100));
		let barColor = "#4caf50";
		if (percent < 25) barColor = "#f44336";
		else if (percent < 50) barColor = "#ff9800";

		const status = member.status ?? (hp <= 0 ? "💀 Downed" : "Alive");

		const maxSlots = Number(member.level) || 1;
		const slotsUsed = Number(member.spellSlotsUsed) || 0;
		const slotsLeft = Math.max(0, maxSlots - slotsUsed);
		const slotPips = Array.from({ length: maxSlots }, (_, i) =>
			`<span class="slot-pip ${i < slotsLeft ? "slot-pip-full" : "slot-pip-empty"}" title="${slotsLeft}/${maxSlots} slots remaining"></span>`
		).join("");

		const row = document.createElement("tr");
		row.innerHTML = `
			<td data-player="${member.name}" style="cursor:pointer;" title="View character sheet"><strong>${member.name}</strong>${member.name === hostPlayer ? ' <span title="Game Host" style="cursor:default;">👑</span>' : ""}</td>
			<td>
				<div class="hp-bar">
					<div class="hp-fill" style="width:${percent}%; background:${barColor};"></div>
					<span class="hp-label">${hp} / ${max_hp}</span>
				</div>
			</td>
			<td><div class="slot-pips">${slotPips}</div></td>
			<td>${status}</td>
			<td>${formatConditions(member.conditions)}</td>
		`;
		tbody.appendChild(row);
	}

	const infoBtn = container.querySelector("#conditionsInfoBtn");
	if (infoBtn) infoBtn.addEventListener("click", showConditionsInfoModal);
}

/** Draw a compact enemy roster showing vague health status. */
function drawEnemyRoster(containerId, enemies = []) {
	const container = document.getElementById(containerId);
	if (!container) return;

	const active = enemies.filter(e => e.status === "active");
	const inactive = enemies.filter(e => e.status !== "active");

	if (!active.length && !inactive.length) {
		container.innerHTML = "";
		return;
	}

	const condColors = {
		"Healthy":    "#60c060",
		"Injured":    "#c0a040",
		"Wounded":    "#c06040",
		"Near Death": "#e04040",
		"Dead":       "#808080",
		"Fled":       "#8080c0",
	};

	let html = `<div style="margin:0.5rem 0;padding:0.5rem 0.6rem;background:#1a0d0d;border:1px solid #3a1e1e;border-radius:6px;">
		<div style="font-size:0.8em;color:#a05050;margin-bottom:0.3rem;font-weight:bold;">🩸 Enemies</div>`;

	for (const e of [...active, ...inactive]) {
		const color = condColors[e.condition] || "#aaa";
		const strikethrough = e.status === "dead" ? "text-decoration:line-through;opacity:0.5;" : "";
		const italic = e.status === "fled" ? "font-style:italic;opacity:0.6;" : "";
		html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.15rem 0;${strikethrough}${italic}">
			<span style="font-size:0.82em;color:#e0a0a0;">${e.name}</span>
			<span style="font-size:0.7em;color:${color};font-weight:bold;">${e.condition}</span>
		</div>`;
	}

	html += `</div>`;
	container.innerHTML = html;
}
/**
 * Draws the battle map, and lets a square be clicked.
 *
 * @description The client half of phase 4. The decisions live in `tacticalMap.js`; this only paints
 *   them, which is why the model is testable and this is not.
 *
 *   Reachable squares are tinted green — faintly, so the room still reads as a room. That tint *is*
 *   the legality conversation: an illegal move is never offered rather than refused with a message.
 *   Which squares those are comes from the server, so the page never works out reach for itself.
 * @param {object} view - A `createMapView()` instance.
 * @param {boolean} canAct - Whether this viewer may click. False for observers and off-turn players.
 * @param {Document} [doc] - Where to draw. Defaults to this page; the pop-out window passes its own,
 *   which is what makes the window a second mount point for this renderer rather than a second
 *   renderer. Two canvases drawing the same arena from two copies of this code is how they end up
 *   disagreeing about what a player clicked.
 * @returns {void}
 */
function drawTacticalMap(view, canAct, doc = document) {
	const section = doc.getElementById("tacticalMapSection");
	const canvas = doc.getElementById("tacticalMapCanvas");
	if (!section || !canvas) return;

	const map = view.current?.();
	if (!view.hasMap() || !map) {
		section.classList.add("hidden");
		return;
	}
	section.classList.remove("hidden");

	const offered = new Set(view.offered());
	const pending = view.pendingMove();
	const hint = doc.getElementById("tacticalMapHint");
	if (hint) {
		hint.textContent = !canAct ? ""
			: pending ? `— moving to ${pending}; click it again to cancel`
				: offered.size ? "— click a green square to move there" : "";
	}

	const cell = 30;
	const pad = 18;
	const width = map.width * cell + pad * 2;
	const height = map.height * cell + pad * 2;
	// The pop-out may be on a different screen from the page that opened it, so the ratio comes from
	// whichever window owns this canvas rather than from the one running the code.
	const ratio = (doc.defaultView ?? window).devicePixelRatio || 1;
	canvas.width = width * ratio;
	canvas.height = height * ratio;
	canvas.style.width = "100%";
	canvas.style.maxWidth = `${width}px`;
	canvas.style.height = "auto";

	const ctx = canvas.getContext("2d");
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, width, height);

	const label = (x, y) => `${String.fromCharCode(65 + x)}${y + 1}`;
	const scenery = new Map();
	for (const feature of map.features ?? []) {
		for (const at of feature.cells ?? []) scenery.set(label(at[0], at[1]), feature.kind);
	}
	const landmarks = new Set((map.landmarks ?? []).flatMap((m) => (m.cells ?? []).map((c) => label(c[0], c[1]))));

	for (let x = 0; x < map.width; x++) {
		for (let y = 0; y < map.height; y++) {
			const key = label(x, y);
			const left = pad + x * cell;
			const top = pad + y * cell;

			ctx.fillStyle = "#15131d";
			ctx.fillRect(left, top, cell, cell);

			if (canAct && offered.has(key)) {
				// Faint, and stronger for the square already chosen so the choice is visible at a
				// glance without a second colour.
				ctx.fillStyle = key === pending ? "rgba(96, 200, 120, 0.55)" : "rgba(96, 200, 120, 0.18)";
				ctx.fillRect(left, top, cell, cell);
			}

			const kind = scenery.get(key);
			if (kind === "rubble" || kind === "water") {
				ctx.fillStyle = "#3b3a48";
				for (let i = 4; i < cell; i += 7) for (let j = 4; j < cell; j += 7) ctx.fillRect(left + i, top + j, 2, 2);
			} else if (kind === "low_wall") {
				ctx.fillStyle = "#6b6478";
				ctx.fillRect(left + 2, top + cell * 0.55, cell - 4, cell * 0.4);
			} else if (kind) {
				ctx.fillStyle = "#6b6478";
				ctx.fillRect(left + 2, top + 2, cell - 4, cell - 4);
			}

			if (landmarks.has(key)) {
				ctx.strokeStyle = "#8d84a8";
				ctx.beginPath();
				ctx.arc(left + cell / 2, top + cell / 2, cell * 0.28, 0, Math.PI * 2);
				ctx.stroke();
			}

			ctx.strokeStyle = "#2a2735";
			ctx.strokeRect(left + 0.5, top + 0.5, cell - 1, cell - 1);
		}
	}

	ctx.font = "9px ui-monospace, monospace";
	ctx.fillStyle = "#7b7490";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	for (let x = 0; x < map.width; x++) ctx.fillText(String.fromCharCode(65 + x), pad + x * cell + cell / 2, pad / 2 + 2);
	ctx.textAlign = "right";
	for (let y = 0; y < map.height; y++) ctx.fillText(String(y + 1), pad - 5, pad + y * cell + cell / 2);

	ctx.textAlign = "center";
	ctx.font = "600 11px ui-monospace, monospace";
	for (const [name, token] of Object.entries(map.tokens ?? {})) {
		if (!Array.isArray(token?.cell)) continue;
		const cx = pad + token.cell[0] * cell + cell / 2;
		const cy = pad + token.cell[1] * cell + cell / 2;
		ctx.fillStyle = token.faction === "party" ? "#4a7fc8" : "#b4503c";
		ctx.beginPath();
		ctx.arc(cx, cy, cell * 0.36, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = "#f2f0f5";
		ctx.fillText(name.replace(/^(Sister|Brother)\s+/, "")[0] ?? "?", cx, cy + 0.5);
	}

	canvas.style.cursor = canAct && offered.size ? "pointer" : "default";
	canvas.onclick = !canAct ? null : (event) => {
		const box = canvas.getBoundingClientRect();
		// The canvas is scaled to its container, so a click has to be mapped back through that
		// scale before it means anything in cell terms.
		const scale = width / box.width;
		const x = Math.floor(((event.clientX - box.left) * scale - pad) / cell);
		const y = Math.floor(((event.clientY - box.top) * scale - pad) / cell);
		if (view.clickCell([x, y])) drawTacticalMap(view, canAct);
	};
}
