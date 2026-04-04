/**
 * XP, leveling, HP, gold, abilities, spell slots, conditions,
 * inventory, and equipment methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 */

const XP_THRESHOLDS = [
	0, 300, 900, 2700, 6500,           // 1-5
	14000, 23000, 34000, 48000, 64000,  // 6-10
	85000, 100000, 120000, 140000, 165000, // 11-15
	195000, 225000, 265000, 305000, 355000, // 16-20
	400000, 450000, 500000, 560000, 620000, // 21-25
];

export const progressionMethods = {
	// ==== XP / Leveling ====

	/**
	 * Increases a player's level by 1 and rolls HP gain based on CON modifier.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name key.
	 * @returns {{ level: number, hpGained: number }} The new level and HP gained this level-up.
	 */
	increaseLevel(lobbyId, playerName) {
		const l = this.index[lobbyId];
		if (!l || !l.players[playerName]) return { level: 1, hpGained: 0 };
		const p = l.players[playerName];
		p.level = (Number(p.level) || 1) + 1;

		// Roll HP: 1d6 + CON modifier (minimum 1)
		const con = Number(p.stats?.con) || 10;
		const conMod = Math.floor((con - 10) / 2);
		const hpRoll = Math.floor(Math.random() * 6) + 1;
		const hpGained = Math.max(1, hpRoll + conMod);
		p.stats = p.stats || {};
		p.stats.hp = (Number(p.stats.hp) || 0) + hpGained;
		p.stats.max_hp = (Number(p.stats.max_hp) || 0) + hpGained;

		this.persist(lobbyId);
		return { level: p.level, hpGained };
	},
	/**
	 * Applies client-distributed stat gains to a player after leveling up.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} sid - The socket ID used to look up the player.
	 * @param {Object.<string, number>} gains - Map of stat attribute names to values to add.
	 * @returns {Object|null} The updated player stats object, or null if player not found.
	 */
	applyLevelGains(lobbyId, sid, gains) {
		const l = this.index[lobbyId];
		if (!l) return null;

		const socketRec = l.sockets[sid];
		if (!socketRec || !socketRec.playerName) return null;

		const player = l.players[socketRec.playerName];
		if (!player) return null;

		// Apply gains (client controls distribution)
		for (const [attr, val] of Object.entries(gains)) {
			if (!player.stats[attr]) continue;
			player.stats[attr] += val;
		}

		this.persist(lobbyId);
		return player.stats;
	},
	/**
	 * Adds XP to a player's total.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {number} amount - The amount of XP to award.
	 * @returns {number} The player's new XP total, or 0 if the player was not found.
	 */
	addXP(lobbyId, playerName, amount) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		p.xp = (p.xp || 0) + Number(amount || 0);
		this.persist(lobbyId);
		return p.xp;
	},
	/**
	 * Checks whether a player has enough XP to advance to the next level.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @returns {boolean} True if the player meets or exceeds the XP threshold for the next level.
	 */
	checkLevelUp(lobbyId, playerName) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return false;
		const p = l.players[key];
		const nextLevel = (Number(p.level) || 1) + 1;
		const nextXP = XP_THRESHOLDS[nextLevel - 1];
		if (nextXP && p.xp >= nextXP) return true;
		return false;
	},

	// ==== HP / Gold ====

	/**
	 * Applies a positive or negative delta to a player's current HP (minimum 0).
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {number} delta - HP change amount; negative values deal damage, positive values heal.
	 * @returns {number} The player's HP after the change, or 0 if the player was not found.
	 */
	applyHPChange(lobbyId, playerName, delta) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		p.stats = p.stats || { hp: 10 };
		const before = Number(p.stats.hp || 0);
		const after = Math.max(0, before + Number(delta || 0));
		p.stats.hp = after;
		this.persist(lobbyId);
		return after;
	},
	/**
	 * Applies a positive or negative delta to a player's gold (minimum 0).
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {number} delta - Gold change amount; negative values spend gold.
	 * @returns {number} The player's gold after the change, or 0 if the player was not found.
	 */
	applyGoldChange(lobbyId, playerName, delta) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		p.gold = Number(p.gold || 0) + Number(delta || 0);
		if (p.gold < 0) p.gold = 0;
		this.persist(lobbyId);
		return p.gold;
	},

	// ==== Abilities / Spell Slots / Conditions ====

	/**
	 * Grants a new ability to a player, skipping duplicates by name.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {{ name: string, [key: string]: any }} ability - The ability object to add.
	 * @returns {void}
	 */
	addAbility(lobbyId, playerName, ability) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key || !ability) return;
		const p = l.players[key];
		p.abilities = Array.isArray(p.abilities) ? p.abilities : [];
		// Avoid granting the same ability twice (reconnects, double-fires, etc.)
		if (!p.abilities.some(a => a.name === ability.name)) {
			p.abilities.push(ability);
		}
		this.persist(lobbyId);
	},
	/**
	 * Adjusts the number of used spell slots, clamped between 0 and the player's level.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {number} delta - Change to apply; positive consumes slots, negative recovers them.
	 * @returns {number} The updated spellSlotsUsed count, or 0 if the player was not found.
	 */
	applySpellSlotChange(lobbyId, playerName, delta) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];
		const maxSlots = Number(p.level) || 1;
		const current = Number(p.spellSlotsUsed) || 0;
		p.spellSlotsUsed = Math.max(0, Math.min(maxSlots, current + Number(delta || 0)));
		this.persist(lobbyId);
		return p.spellSlotsUsed;
	},
	/**
	 * Adds and/or removes status conditions on a player in a single operation.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {string[]} [add=[]] - Condition strings to apply (duplicates are ignored).
	 * @param {string[]} [remove=[]] - Condition strings to remove.
	 * @returns {string[]} The player's full conditions array after changes, or [] if not found.
	 */
	applyConditions(lobbyId, playerName, add = [], remove = []) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return [];
		const p = l.players[key];
		p.conditions = Array.isArray(p.conditions) ? p.conditions : [];
		for (const c of add || []) {
			if (c && !p.conditions.includes(c)) p.conditions.push(c);
		}
		for (const c of remove || []) {
			const idx = p.conditions.indexOf(c);
			if (idx !== -1) p.conditions.splice(idx, 1);
		}
		this.persist(lobbyId);
		return p.conditions;
	},

	// ==== Inventory ====

	/**
	 * Adjusts the count of a named item in a player's inventory, creating or removing it as needed.
	 * Normalises legacy string entries to full item objects on every call.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {string} item - Case-insensitive item name to add or remove.
	 * @param {number} change - Quantity delta; positive adds, negative removes.
	 * @param {string} [description] - Optional description to set/update on the item.
	 * @param {Object} [attributes] - Optional attribute map to merge onto the item.
	 * @returns {number} The item's new count (0 if the item was removed or not found).
	 */
	applyInventoryChange(lobbyId, playerName, item, change, description, attributes) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return 0;
		const p = l.players[key];

		// Ensure inventory is an array
		if (!Array.isArray(p.inventory)) p.inventory = [];

		// Normalize strings into objects (but don't overwrite the array)
		for (let i = 0; i < p.inventory.length; i++) {
			const entry = p.inventory[i];
			if (typeof entry === "string") {
				p.inventory[i] = { name: entry, count: 1, description: "", attributes: {} };
			} else {
				p.inventory[i] = {
					name: entry.name || "Unknown",
					count: entry.count ?? 1,
					description: entry.description || "",
					attributes: entry.attributes || {},
				};
			}
		}

		// Find existing item
		let existing = p.inventory.find((i) => i.name.toLowerCase() === item.toLowerCase());

		// Add new item if not found and we're increasing
		if (!existing && change > 0) {
			existing = {
				name: item,
				count: 0,
				description: description || "",
				attributes: attributes || {},
			};
			p.inventory.push(existing);
		}

		// Apply changes if we found or created one
		if (existing) {
			existing.count = (existing.count || 0) + change;

			if (existing.count <= 0) {
				// Remove from array safely
				p.inventory = p.inventory.filter((i) => i.name.toLowerCase() !== item.toLowerCase());
			} else {
				// Update metadata only if given
				if (description) existing.description = description;
				if (attributes && Object.keys(attributes).length > 0) {
					existing.attributes = { ...existing.attributes, ...attributes };
				}
			}
		}

		this.persist(lobbyId);
		return existing?.count || 0;
	},

	/**
	 * Equips an item from the player's inventory into the specified slot.
	 * The previously equipped item (if any) is returned to inventory automatically.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {string} itemName - Case-insensitive name of the inventory item to equip.
	 * @param {"weapon"|"armor"|"trinket"} slot - The equipment slot to place the item in.
	 * @returns {{ equipped: Object, unequipped: Object|null }|null} The newly equipped and displaced items, or null on failure.
	 */
	equipItem(lobbyId, playerName, itemName, slot) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return null;
		const p = l.players[key];
		if (!p) return null;

		if (!Array.isArray(p.inventory)) p.inventory = [];

		// Find the item in inventory (case-insensitive)
		const idx = p.inventory.findIndex(i =>
			(typeof i === "string" ? i : i.name || "").toLowerCase() === itemName.toLowerCase()
		);
		if (idx === -1) return null;

		const invItem = typeof p.inventory[idx] === "string"
			? { name: p.inventory[idx], count: 1, description: "", attributes: {} }
			: p.inventory[idx];

		// Build the new equipped object based on slot
		let newEquip = null;
		let oldEquip = null;

		if (slot === "weapon") {
			const a = invItem.attributes || {};
			newEquip = {
				name: invItem.name,
				damage: a.damage || "1d4",
				damageType: a.damage_type || a.damageType || "bludgeoning",
				range: a.range || "melee",
			};
			oldEquip = p.weapon;
			p.weapon = newEquip;
		} else if (slot === "armor") {
			const a = invItem.attributes || {};
			newEquip = {
				name: invItem.name,
				ac: Number(a.ac) || 10,
				type: a.type || a.armor_type || "light",
				material: a.material || "",
				note: a.note || "",
			};
			oldEquip = p.armor;
			p.armor = newEquip;
		} else if (slot === "trinket") {
			newEquip = {
				name: invItem.name,
				description: invItem.description || "",
				attributes: invItem.attributes || {},
			};
			oldEquip = p.trinket || null;
			p.trinket = newEquip;
		} else {
			return null;
		}

		// Remove equipped item from inventory (decrement count or remove)
		if (invItem.count > 1) {
			invItem.count -= 1;
		} else {
			p.inventory.splice(idx, 1);
		}

		// Return old equipped item to inventory (if there was one)
		if (oldEquip && oldEquip.name) {
			const existing = p.inventory.find(i =>
				(typeof i === "string" ? i : i.name || "").toLowerCase() === oldEquip.name.toLowerCase()
			);
			if (existing && typeof existing === "object") {
				existing.count = (existing.count || 1) + 1;
			} else {
				// Build inventory entry from the old equipped item
				const attrs = {};
				if (slot === "weapon") {
					if (oldEquip.damage)     attrs.damage = oldEquip.damage;
					if (oldEquip.damageType) attrs.damage_type = oldEquip.damageType;
					if (oldEquip.range)      attrs.range = oldEquip.range;
					attrs.item_type = "weapon";
				} else if (slot === "armor") {
					if (oldEquip.ac)       attrs.ac = oldEquip.ac;
					if (oldEquip.type)     attrs.armor_type = oldEquip.type;
					if (oldEquip.material) attrs.material = oldEquip.material;
					attrs.item_type = "armor";
				} else if (slot === "trinket") {
					Object.assign(attrs, oldEquip.attributes || {});
					attrs.item_type = "trinket";
				}
				p.inventory.push({
					name: oldEquip.name,
					count: 1,
					description: oldEquip.description || oldEquip.note || "",
					attributes: attrs,
				});
			}
		}

		this.persist(lobbyId);
		return { equipped: newEquip, unequipped: oldEquip };
	},

	/**
	 * Removes the equipped item from a slot and returns it to the player's inventory.
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} playerName - The player's name (resolved via findPlayerKey).
	 * @param {"weapon"|"armor"|"trinket"} slot - The equipment slot to clear.
	 * @returns {{ unequipped: Object }|null} The item that was unequipped, or null if the slot was empty or invalid.
	 */
	unequipItem(lobbyId, playerName, slot) {
		const l = this.index[lobbyId];
		const key = this.findPlayerKey(lobbyId, playerName);
		if (!l || !key) return null;
		const p = l.players[key];
		if (!p) return null;

		if (!["weapon", "armor", "trinket"].includes(slot)) return null;

		const oldEquip = p[slot];
		if (!oldEquip || !oldEquip.name) return null;

		// Return equipped item to inventory
		if (!Array.isArray(p.inventory)) p.inventory = [];
		const existing = p.inventory.find(i =>
			(typeof i === "string" ? i : i.name || "").toLowerCase() === oldEquip.name.toLowerCase()
		);
		if (existing && typeof existing === "object") {
			existing.count = (existing.count || 1) + 1;
		} else {
			const attrs = {};
			if (slot === "weapon") {
				if (oldEquip.damage)     attrs.damage = oldEquip.damage;
				if (oldEquip.damageType) attrs.damage_type = oldEquip.damageType;
				if (oldEquip.range)      attrs.range = oldEquip.range;
				attrs.item_type = "weapon";
			} else if (slot === "armor") {
				if (oldEquip.ac)       attrs.ac = oldEquip.ac;
				if (oldEquip.type)     attrs.armor_type = oldEquip.type;
				if (oldEquip.material) attrs.material = oldEquip.material;
				attrs.item_type = "armor";
			} else if (slot === "trinket") {
				Object.assign(attrs, oldEquip.attributes || {});
				attrs.item_type = "trinket";
			}
			p.inventory.push({
				name: oldEquip.name,
				count: 1,
				description: oldEquip.description || oldEquip.note || "",
				attributes: attrs,
			});
		}

		// Clear the equipment slot
		p[slot] = null;

		this.persist(lobbyId);
		return { unequipped: oldEquip };
	},
};
