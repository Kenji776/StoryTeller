/**
 * party — the character table and the inspector beside it.
 *
 * This is where most admin work happens, and where the old panel cost the most:
 * you chose a player from a dropdown in one tab, then scrolled ten accordions to
 * find the action, and if you wanted to *set* a value rather than nudge it you had
 * to go to a different tab entirely and type the character's name again.
 *
 * Here a row selects, and everything for that character is in one column — with
 * Adjust and Set side by side, because they are two forms of the same repair.
 *
 * The table redraws whenever lobby state arrives. The inspector's forms do not:
 * they are built once per selected character, so a state update mid-sentence
 * cannot discard what is being typed. Only the vitals inside it redraw.
 */

import { h, fill } from "../ui/dom.js";
import {
	panel, group, dataTable, field, row, textInput, numberInput, textArea,
	select, multiSelect, selectedValues, button, chip, hpBar, empty, flash,
} from "../ui/components.js";
import { selectPlayers, selectEnemies } from "../core/selectors.js";
import { playerRepairs, fieldsExcludingPlayer } from "../core/repairs.js";
import { buildGrantPayload } from "../core/equipment.js";
import { coerceField } from "../core/coerce.js";
import { CONDITIONS, ITEM_TYPES, DAMAGE_TYPES, WEAPON_RANGES, ARMOR_TYPES, ABILITY_SCORES, DICE } from "../core/vocab.js";

/**
 * Repairs given a home of their own rather than a generic form. Anything else the
 * server offers still appears in the Set column, so a repair added server-side
 * shows up here without a matching change.
 */
const PLACED_REPAIRS = new Set(["player:revive", "turn:set"]);

/**
 * @description Renders the party section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function party(ctx) {
	const { store, bridge } = ctx;

	/** The character the inspector is showing, by name. */
	let selected = null;

	const tableHost = h("div");
	const inspectorHost = h("aside.inspector");
	const enemiesHost = h("div");

	/**
	 * @description The rows the table is currently showing.
	 * @returns {Array<object>} Player rows.
	 */
	const rows = () => selectPlayers(store.getState().lobbyState);

	/**
	 * @description Chooses a character, or clears the choice when re-clicked.
	 * @param {string|null} name - The character's name.
	 * @returns {void}
	 */
	function choose(name) {
		selected = selected === name ? null : name;
		drawTable();
		drawInspector();
	}

	// ── table ─────────────────────────────────────────────────────────────────

	/**
	 * @description Draws the character table.
	 * @returns {void}
	 */
	function drawTable() {
		fill(tableHost, dataTable({
			rowKey: (r) => r.name,
			selectedKey: selected,
			onSelect: (r) => choose(r.name),
			empty: "No characters in this lobby yet.",
			rows: rows(),
			columns: [
				{
					label: "Name",
					render: (r) => h("span", { class: r.dead ? "muted" : "" },
						r.isCurrent ? h("span", { title: "Their turn" }, "▸ ") : "",
						r.name,
					),
				},
				{ label: "Race", render: (r) => r.race ?? "—" },
				{ label: "Class", render: (r) => r.charClass ?? "—" },
				{ label: "Lvl", key: "level", align: "right" },
				{ label: "XP", key: "xp", align: "right" },
				{ label: "Gold", key: "gold", align: "right" },
				{ label: "HP", render: (r) => hpBar(r.hp, r.maxHp) },
				{
					label: "State",
					render: (r) => h("span",
						r.dead && chip("dead", "danger"),
						!r.connected && chip("away", "warn"),
						r.conditions.map((c) => chip(c, "info")),
						!r.dead && r.connected && !r.conditions.length ? h("span.muted", "—") : "",
					),
				},
			],
		}));
	}

	// ── inspector ─────────────────────────────────────────────────────────────

	/**
	 * @description Draws the inspector for the selected character.
	 * @returns {void}
	 */
	function drawInspector() {
		if (!selected) {
			fill(inspectorHost, panel({ title: "Inspector" },
				empty("Select a character to act on them.")));
			return;
		}
		fill(inspectorHost, buildInspector(selected));
	}

	/**
	 * @description Builds the inspector's stable form tree for one character.
	 * @param {string} name - The character's name.
	 * @returns {HTMLElement} The inspector panel.
	 */
	function buildInspector(name) {
		const vitalsHost = h("div.inspector-vitals");
		const note = flash();

		/**
		 * @description Redraws only the live values, leaving every form untouched.
		 * @returns {void}
		 */
		function drawVitals() {
			const player = rows().find((r) => r.name === name);
			if (!player) {
				fill(vitalsHost, h("p.muted.small", "This character is no longer in the lobby."));
				return;
			}
			fill(vitalsHost,
				h("div.inspector-head",
					h("span.inspector-name", player.name),
					h("span.muted.small", [player.race, player.charClass].filter(Boolean).join(" ") || "—"),
					h("span.muted.small", `Level ${player.level}`),
				),
				h("div", { style: { margin: "0.4rem 0 0.5rem" } }, hpBar(player.hp, player.maxHp)),
				h("div.control-row", { style: { gap: "1rem", marginBottom: "0.4rem" } },
					h("span.muted.small", `XP ${player.xp}`),
					h("span.muted.small", `Gold ${player.gold}`),
					h("span.muted.small", `Uses spent ${player.spellSlotsUsed}`),
				),
				h("div",
					player.dead && chip("dead", "danger"),
					player.isCurrent && chip("their turn", "ok"),
					!player.connected && chip("disconnected", "warn"),
					player.conditions.map((c) => chip(c, "info")),
				),
			);
		}

		ctx.onCleanup(store.watch((s) => s.lobbyState, drawVitals));
		drawVitals();

		/**
		 * @description Sends a game-state change and reports what happened in place.
		 * @param {string} type - An `admin:event` sub-type.
		 * @param {object} payload - The change.
		 * @param {string} said - What to show on success.
		 * @returns {void}
		 */
		const send = (type, payload, said) => {
			if (bridge.sendEvent(type, { player: name, ...payload })) note.show(said);
			else note.show("Not connected to a lobby.", "danger");
		};

		return panel({},
			vitalsHost,
			turnControl(name),
			adjustAndSet(name, send, note),
			grantEquipment(name, note),
			requestRoll(name, send),
			conditionControls(name, send),
			dangerZone(name, send, note),
			h("div.control-row", { style: { marginTop: "0.6rem" } }, note.el),
		);
	}

	/**
	 * @description The one-click "hand them the turn" control, when the server offers it.
	 * @param {string} name - The character's name.
	 * @returns {HTMLElement|null} The control, or nothing.
	 */
	function turnControl(name) {
		const repair = playerRepairs(store.getState().repairs).find((r) => r.type === "turn:set");
		if (!repair) return null;
		return h("div.control-row", { style: { marginTop: "0.6rem" } },
			button({
				label: "Give them the turn",
				small: true,
				onClick: () => bridge.sendRepair("turn:set", { player: name }),
				title: repair.note ?? "",
			}),
		);
	}

	/**
	 * @description The delta forms and the absolute forms, side by side.
	 *
	 *   The whole reason this section exists in this shape: `hp:update` takes a
	 *   difference and `hp:set` takes a value, they fix the same thing, and the old
	 *   panel put them in separate tabs.
	 * @param {string} name - The character's name.
	 * @param {Function} send - Sends a game-state change.
	 * @param {object} note - The inline feedback line.
	 * @returns {HTMLElement} The two columns.
	 */
	function adjustAndSet(name, send, note) {
		const xp = numberInput({ placeholder: "±XP", "aria-label": "XP change" });
		const xpWhy = textInput({ placeholder: "Reason", "aria-label": "Reason for the XP change" });
		const hp = numberInput({ placeholder: "±HP", "aria-label": "HP change" });
		const hpWhy = textInput({ placeholder: "Reason", "aria-label": "Reason for the HP change" });
		const gold = numberInput({ placeholder: "±Gold", "aria-label": "Gold change" });
		const goldWhy = textInput({ placeholder: "Reason", "aria-label": "Reason for the gold change" });
		const slots = numberInput({ placeholder: "±Used", "aria-label": "Change in ability uses spent" });
		const item = textInput({ placeholder: "Item", "aria-label": "Item name" });
		const qty = numberInput({ placeholder: "±Qty", "aria-label": "Quantity change" });

		/**
		 * @description Reads a number from an input, treating blank as zero.
		 * @param {HTMLInputElement} el - The input.
		 * @returns {number} The value.
		 */
		const n = (el) => Number.parseInt(el.value, 10) || 0;

		// One action per line, labelled by placeholder and `aria-label` rather than a
		// visible caption. Stacked captions pushed each action onto three rows, which
		// made the column tall enough that Adjust and Set could not be seen together
		// — and being seen together is the entire point of this layout.
		const adjust = h("div",
			h("h4", "Adjust — by an amount"),
			row(xp, xpWhy,
				button({ label: "Add", small: true, onClick: () => {
					send("xp:update", { amount: n(xp), reason: xpWhy.value || "Manual adjustment" },
						`${n(xp) >= 0 ? "+" : ""}${n(xp)} XP sent`);
					xp.value = "";
				} })),
			row(hp, hpWhy,
				button({ label: "Apply", small: true, onClick: () => {
					send("hp:update", { delta: n(hp), reason: hpWhy.value || "Manual change" },
						`${n(hp) >= 0 ? "+" : ""}${n(hp)} HP sent`);
					hp.value = "";
				} })),
			row(gold, goldWhy,
				button({ label: "Apply", small: true, onClick: () => {
					send("gold:update", { delta: n(gold), reason: goldWhy.value || "Manual change" },
						`${n(gold) >= 0 ? "+" : ""}${n(gold)} gold sent`);
					gold.value = "";
				} })),
			row(slots, h("span.field-hint", "Negative restores"),
				button({ label: "Apply", small: true, onClick: () => {
					send("spellslots:update", { delta: n(slots) }, "Ability uses adjusted");
					slots.value = "";
				} })),
			row(item, qty,
				button({ label: "Apply", small: true, onClick: () => {
					if (!item.value.trim()) return note.show("Enter an item name.", "warn");
					send("inventory:update", { item: item.value.trim(), change: n(qty), description: "Manual" },
						`${item.value.trim()} adjusted`);
					item.value = "";
					qty.value = "";
				} })),
		);

		const catalogue = playerRepairs(store.getState().repairs)
			.filter((repair) => !PLACED_REPAIRS.has(repair.type));

		const set = h("div",
			h("h4", "Set — to a value"),
			catalogue.length
				? catalogue.map((repair) => repairForm(repair, name, note))
				: h("p.muted.small", "The server offered no repairs for a character."),
		);

		return group("Values", h("div.adjust-set", adjust, set));
	}

	/**
	 * @description One absolute-value repair, with the character already chosen.
	 * @param {object} repair - A catalogue entry.
	 * @param {string} name - The character's name.
	 * @param {object} note - The inline feedback line.
	 * @returns {HTMLElement} The form.
	 */
	function repairForm(repair, name, note) {
		const fields = fieldsExcludingPlayer(repair);
		const inputs = new Map();

		for (const fieldName of fields) {
			inputs.set(fieldName, fieldName === "conditions"
				? multiSelect({ options: CONDITIONS, size: 4, props: { "aria-label": "Conditions to set" } })
				: numberInput({ placeholder: fieldName, "aria-label": `${repair.label}: ${fieldName}` }));
		}

		return h("div.repair-form",
			row(
				...fields.map((fieldName) => inputs.get(fieldName)),
				button({
					label: repair.label,
					small: true,
					title: repair.note ?? "",
					onClick: () => {
						const payload = { player: name };
						for (const [fieldName, el] of inputs) {
							// A conditions list is read from the selection, where blank
							// legitimately means "clear them"; everything else goes through
							// the same coercion the Health section uses.
							const raw = fieldName === "conditions"
								? selectedValues(el).join(",")
								: el.value;
							const { present, value } = coerceField(fieldName, raw);
							if (present) payload[fieldName] = value;
						}
						if (bridge.sendRepair(repair.type, payload)) note.show(`${repair.label} sent`);
					},
				}),
			),
		);
	}

	/**
	 * @description The equipment grant form.
	 * @param {string} name - The character's name.
	 * @param {object} note - The inline feedback line.
	 * @returns {HTMLElement} The form.
	 */
	function grantEquipment(name, note) {
		const itemName = textInput({ placeholder: "e.g. Flamebrand Longsword" });
		const type = select({ options: ITEM_TYPES.map((t) => ({ value: t.id, label: t.label })) });
		const damage = textInput({ placeholder: "2d6" });
		const damageType = select({ options: DAMAGE_TYPES });
		const range = select({ options: WEAPON_RANGES });
		const ac = numberInput({ placeholder: "AC" });
		const armorType = select({ options: ARMOR_TYPES });
		const description = textArea({
			rows: 2,
			placeholder: "Description and special effects — the model reads this when the item is used.",
		});

		const weaponFields = row(field("Damage", damage), field("Type", damageType), field("Range", range));
		const armorFields = row(field("AC", ac), field("Kind", armorType));
		armorFields.hidden = true;

		type.addEventListener("change", () => {
			weaponFields.hidden = type.value !== "weapon";
			armorFields.hidden = type.value !== "armor";
		});

		return group("Grant equipment",
			row(field("Item", itemName), field("Kind", type)),
			weaponFields,
			armorFields,
			field("Description", description),
			h("div.control-row",
				button({
					label: "Grant",
					variant: "primary",
					small: true,
					onClick: () => {
						try {
							const payload = buildGrantPayload({
								player: name,
								name: itemName.value,
								type: type.value,
								description: description.value,
								damage: damage.value,
								damageType: damageType.value,
								range: range.value,
								ac: ac.value,
								armorType: armorType.value,
							});
							if (!bridge.sendEvent("inventory:update", payload)) {
								return note.show("Not connected to a lobby.", "danger");
							}
							note.show(`Granted ${payload.item}`);
							itemName.value = "";
							description.value = "";
						} catch (err) {
							// buildGrantPayload refuses malformed input with a message that
							// names the field; showing it beats silently granting a d6.
							note.show(err.message, "danger");
						}
					},
				}),
			),
		);
	}

	/**
	 * @description The roll-request form.
	 * @param {string} name - The character's name.
	 * @param {Function} send - Sends a game-state change.
	 * @returns {HTMLElement} The form.
	 */
	function requestRoll(name, send) {
		const sides = select({ options: DICE.map((d) => ({ value: d, label: `d${d}` })), value: 20 });
		const mods = numberInput({ value: 0 });
		const stats = multiSelect({
			options: ABILITY_SCORES.map((s) => ({ value: s.id, label: s.label })),
			size: 3,
		});

		return group("Request a roll",
			row(field("Die", sides), field("Modifier", mods), field("Ability", stats)),
			h("div.control-row",
				button({
					label: "Ask for the roll",
					small: true,
					onClick: () => send("roll:required", {
						sides: Number(sides.value),
						mods: Number(mods.value) || 0,
						stats: selectedValues(stats),
					}, "Roll requested"),
				}),
			),
		);
	}

	/**
	 * @description The add/remove conditions form.
	 * @param {string} name - The character's name.
	 * @param {Function} send - Sends a game-state change.
	 * @returns {HTMLElement} The form.
	 */
	function conditionControls(name, send) {
		const add = multiSelect({ options: CONDITIONS, size: 5 });
		const remove = multiSelect({ options: CONDITIONS, size: 5 });

		return group("Conditions",
			row(field("Add", add), field("Remove", remove)),
			h("div.control-row",
				button({
					label: "Apply",
					small: true,
					onClick: () => {
						const added = selectedValues(add);
						const removed = selectedValues(remove);
						if (!added.length && !removed.length) return;
						send("conditions:update", { add: added, remove: removed }, "Conditions applied");
						add.selectedIndex = -1;
						remove.selectedIndex = -1;
					},
				}),
			),
		);
	}

	/**
	 * @description The actions a player will notice and an admin cannot take back.
	 * @param {string} name - The character's name.
	 * @param {Function} send - Sends a game-state change.
	 * @param {object} note - The inline feedback line.
	 * @returns {HTMLElement} The group.
	 */
	function dangerZone(name, send, note) {
		const why = textArea({
			rows: 2,
			placeholder: "What killed them? The model narrates this.",
		});
		const revive = playerRepairs(store.getState().repairs).find((r) => r.type === "player:revive");
		const reviveHp = numberInput({ placeholder: "HP", value: 1 });

		return group("Life and death",
			field("Cause of death", why),
			h("div.control-row",
				button({
					label: "Kill",
					variant: "danger",
					small: true,
					confirm: `Kill ${name}? This triggers the death sequence.`,
					onClick: () => {
						send("player:death", { reason: why.value.trim() }, `${name} killed`);
						why.value = "";
					},
				}),
				// Revive sits beside Kill rather than in the Set column: they are each
				// other's undo, and having to look for one from the other is the exact
				// problem this rebuild is fixing.
				revive && field("Revive at", reviveHp),
				revive && button({
					label: "Revive",
					small: true,
					title: revive.note ?? "",
					onClick: () => {
						if (bridge.sendRepair("player:revive", { player: name, hp: Number(reviveHp.value) || 1 })) {
							note.show(`${name} revived`);
						}
					},
				}),
			),
			h("div.control-row", { style: { marginTop: "0.5rem" } },
				button({
					label: "Force level up",
					small: true,
					onClick: () => send("player:forceLevelUp", {}, "Level-up offered"),
				}),
				button({
					label: "Kick",
					variant: "danger",
					small: true,
					confirm: `Remove ${name} from the lobby?`,
					onClick: () => send("player:kick", {}, `${name} kicked`),
				}),
			),
		);
	}

	// ── enemies ───────────────────────────────────────────────────────────────

	/**
	 * @description Draws what the party is fighting.
	 *
	 *   The old panel showed nothing about enemies at all, so a DM running combat
	 *   could not see what was still standing without reading the raw lobby JSON.
	 * @returns {void}
	 */
	function drawEnemies() {
		const enemies = selectEnemies(store.getState().lobbyState);
		if (!enemies.length) {
			fill(enemiesHost);
			return;
		}
		fill(enemiesHost, panel({ title: "Enemies" }, dataTable({
			rows: enemies,
			columns: [
				{ label: "Name", render: (e) => h("span", { class: e.defeated ? "muted" : "" }, e.name) },
				{ label: "CR", render: (e) => (e.cr ?? "—") },
				{ label: "Condition", render: (e) => chip(e.condition ?? "unknown", e.defeated ? "danger" : "warn") },
			],
		})));
	}

	// ── mount ─────────────────────────────────────────────────────────────────

	ctx.onCleanup(store.watch((s) => s.lobbyState, () => {
		// A character who left takes the inspector with them, otherwise its forms
		// would keep sending events naming somebody who is no longer there.
		if (selected && !rows().some((r) => r.name === selected)) {
			selected = null;
			drawInspector();
		}
		drawTable();
		drawEnemies();
	}));

	drawTable();
	drawInspector();
	drawEnemies();

	return h("div",
		h("div.party-layout",
			h("div", panel({ title: "Party", description: "Select a character to act on them." }, tableHost), enemiesHost),
			inspectorHost,
		),
	);
}
