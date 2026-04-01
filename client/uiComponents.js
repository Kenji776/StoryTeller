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
/** Detect whether an inventory item is equippable, and which slot it fits. */
function _detectEquipSlot(item) {
	const a = item.attributes || {};
	const type = (a.item_type || "").toLowerCase();

	// 1. Explicit item_type from LLM or admin tool (authoritative)
	if (type === "weapon")  return "weapon";
	if (type === "armor")   return "armor";
	if (type === "trinket" || type === "ring" || type === "amulet" || type === "necklace" || type === "bracelet" || type === "cloak") return "trinket";

	// 2. Mechanical attributes imply slot
	if (a.damage || a.damage_type) return "weapon";
	if (a.ac || a.armor_type)      return "armor";

	// 3. Name keyword heuristics
	const n = (item.name || "").toLowerCase();
	const weaponWords = ["sword", "axe", "bow", "dagger", "mace", "staff", "spear", "hammer", "blade", "crossbow", "halberd", "flail", "rapier", "scimitar", "warhammer", "greataxe", "greatsword", "glaive", "trident", "whip", "javelin", "sling", "wand", "club", "morningstar", "pike", "lance", "scythe"];
	const armorWords  = ["armor", "shield", "mail", "plate", "leather armor", "chainmail", "breastplate", "splint", "studded", "half plate", "scale mail", "padded armor", "hide armor", "buckler"];
	const trinketWords = ["ring", "amulet", "necklace", "bracelet", "cloak", "pendant", "brooch", "circlet", "charm", "talisman", "torc", "cape", "mantle", "crown", "tiara", "belt", "sash", "orb", "gem", "jewel"];
	if (weaponWords.some(w => n.includes(w))) return "weapon";
	if (armorWords.some(w => n.includes(w)))  return "armor";
	if (trinketWords.some(w => n.includes(w))) return "trinket";

	// 4. If the item has a consumable type, it's not equippable
	if (type === "consumable") return null;

	return null;
}

async function drawInventoryComponent(containerId, items = [], canAdd = false) {
	const container = document.getElementById(containerId);
	if (!container) return console.warn(`drawInventoryComponent: #${containerId} not found`);

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
		if (slot) {
			const slotLabel = slot === "weapon" ? "⚔️" : slot === "armor" ? "🛡️" : "💍";
			equipBtn = `<button class="equip-btn chip" data-item="${item.name.replace(/"/g, "&quot;")}" data-slot="${slot}" title="Equip as ${slot}">${slotLabel} Equip</button>`;
		}

		// Show attributes summary for equippable items
		const a = item.attributes || {};
		let statsHint = "";
		if (a.damage) statsHint += ` [${a.damage} ${a.damage_type || ""}]`;
		if (a.ac) statsHint += ` [AC ${a.ac}]`;

		row.innerHTML = `
			<td><strong>${item.name}</strong>${statsHint ? `<span style="opacity:0.6;font-size:0.85em;">${statsHint}</span>` : ""}</td>
			<td>${item.count ?? 1}</td>
			<td>${item.description || ""}</td>
			<td>${equipBtn}</td>
		`;
		tbody.appendChild(row);

		console.log(`🎒 Inventory item: "${item.name}" | slot=${slot || "none"} | attributes=`, item.attributes);
	}

	// Wire up equip buttons
	container.querySelectorAll(".equip-btn").forEach(btn => {
		btn.addEventListener("click", () => {
			const itemName = btn.dataset.item;
			const slot = btn.dataset.slot;
			console.log(`⚔️ Equip clicked: "${itemName}" → ${slot}`);
			if (typeof socket !== "undefined" && socket) {
				socket.emit("item:equip", { lobbyId, itemName, slot });
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

	const sorted = [...abilities].sort((a, b) => a.name.localeCompare(b.name));
	const template = await getTemplate("/components/abilities.html");

	container.innerHTML = `
		<div class="component-box">
			<div class="component-header">
				<span>✨ Abilities & Spells</span>
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
			th.style.width = "60px";
			headerRow.appendChild(th);
		}
	}

	const totalCols = canUse ? 4 : 3;
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
			<td><strong>${ability.name}</strong></td>
			<td>${ability.description || ""}</td>
			<td class="smalltext">${detailsHTML}</td>
			${canUse ? `<td><button class="use-ability-btn secondary" style="padding:2px 8px;font-size:0.8em;" data-verb="${verb}" data-noun="${noun}" data-name="${ability.name.replace(/"/g, '&quot;')}">${isSpell ? "Cast" : "Use"}</button></td>` : ""}
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