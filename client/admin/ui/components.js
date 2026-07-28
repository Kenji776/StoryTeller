/**
 * components — the pieces every section is built from.
 *
 * Deliberately small and unopinionated: each returns an element and holds no
 * state beyond what it was given. Anything that needs to remember something is
 * the section's job, not a component's.
 *
 * No tests, for the same reason as `ui/dom.js` — these are construction, not
 * decisions. The decisions they render live in `core/`, which is covered.
 */

import { h } from "./dom.js";

/**
 * @description A titled panel, the standard container for a section's content.
 * @param {object} options - Panel options.
 * @param {string} [options.title] - The heading.
 * @param {string} [options.description] - A line under the heading.
 * @param {...*} children - The contents.
 * @returns {HTMLElement} The panel.
 */
export function panel({ title, description } = {}, ...children) {
	return h("section.panel",
		title && h("h2", title),
		description && h("p.muted.small.panel-desc", description),
		...children,
	);
}

/**
 * @description A labelled sub-heading inside a panel.
 * @param {string} title - The heading.
 * @param {...*} children - The contents.
 * @returns {HTMLElement} The group.
 */
export function group(title, ...children) {
	return h("div.group", h("h3", title), ...children);
}

/**
 * @description A grid of headline numbers.
 * @param {Array<{label: string, value: *, tone?: string}>} tiles - The tiles.
 * @returns {HTMLElement} The grid.
 */
export function tileGrid(tiles) {
	return h("div.tiles", (tiles ?? []).map((tile) => h("div.tile",
		h("div.tile-label", tile.label),
		h("div.tile-value", { class: tile.tone ? `is-${tile.tone}` : "" }, String(tile.value ?? "—")),
	)));
}

/**
 * @description A data table with optional row selection.
 * @param {object} options - Table options.
 * @param {Array<object>} options.columns - `{key, label, align, render}` per column.
 *   `render(row)` may return a node; otherwise `row[key]` is shown as text.
 * @param {Array<object>} options.rows - The rows.
 * @param {function(object): string} [options.rowKey] - Identifies a row for selection.
 * @param {string} [options.selectedKey] - The currently selected row's key.
 * @param {function(object): void} [options.onSelect] - Called with the row when clicked.
 * @param {string} [options.empty] - Shown instead of the table when there are no rows.
 * @returns {HTMLElement} The table, or the empty state.
 */
export function dataTable({ columns, rows, rowKey, selectedKey, onSelect, empty: emptyText }) {
	if (!rows?.length) return empty(emptyText ?? "Nothing to show.");

	return h("div.table-wrap", h("table.data-table",
		h("thead", h("tr", columns.map((col) =>
			h("th", { class: col.align === "right" ? "align-right" : "" }, col.label)))),
		h("tbody", rows.map((row) => {
			const key = rowKey?.(row);
			return h("tr", {
				class: [onSelect ? "is-clickable" : "", key && key === selectedKey ? "is-selected" : ""]
					.filter(Boolean).join(" "),
				onClick: onSelect
					? (event) => {
						// Buttons inside a row do their own thing; selecting as well would
						// fire two actions from one click.
						if (event.target.closest("button")) return;
						onSelect(row);
					}
					: null,
			}, columns.map((col) => h("td", { class: col.align === "right" ? "align-right" : "" },
				col.render ? col.render(row) : String(row[col.key] ?? ""))));
		})),
	));
}

/**
 * @description A labelled control.
 * @param {string} label - The label.
 * @param {*} control - The control element.
 * @param {string} [hint] - A line under the control.
 * @returns {HTMLElement} The field.
 */
export function field(label, control, hint) {
	return h("label.field",
		h("span.field-label", label),
		control,
		hint && h("span.field-hint", hint),
	);
}

/**
 * @description A horizontal run of controls.
 * @param {...*} children - The controls.
 * @returns {HTMLElement} The row.
 */
export function row(...children) {
	return h("div.control-row", ...children);
}

/**
 * @description A text input.
 * @param {object} [props] - Element properties.
 * @returns {HTMLElement} The input.
 */
export function textInput(props = {}) {
	return h("input.input", { type: "text", ...props });
}

/**
 * @description A number input.
 * @param {object} [props] - Element properties.
 * @returns {HTMLElement} The input.
 */
export function numberInput(props = {}) {
	return h("input.input.input-number", { type: "number", ...props });
}

/**
 * @description A multi-line text input.
 * @param {object} [props] - Element properties.
 * @returns {HTMLElement} The textarea.
 */
export function textArea(props = {}) {
	return h("textarea.input", props);
}

/**
 * @description A dropdown.
 * @param {object} options - Select options.
 * @param {Array<object|string|number>} options.options - `{value,label}`, or a bare value.
 * @param {*} [options.value] - The selected value.
 * @param {function(Event): void} [options.onChange] - Change handler.
 * @param {object} [options.props] - Further element properties.
 * @returns {HTMLElement} The select.
 */
export function select({ options, value, onChange, props = {} }) {
	const el = h("select.input", { onChange, ...props },
		(options ?? []).map((option) => {
			const entry = typeof option === "object" ? option : { value: option, label: String(option) };
			return h("option", { value: entry.value }, entry.label);
		}));
	if (value !== undefined && value !== null) el.value = value;
	return el;
}

/**
 * @description A multiple-selection list.
 * @param {object} options - List options.
 * @param {Array<object|string>} options.options - `{value,label}`, or a bare value.
 * @param {Array<string>} [options.values] - Values to pre-select.
 * @param {number} [options.size=6] - Visible rows.
 * @param {object} [options.props] - Further element properties.
 * @returns {HTMLElement} The list.
 */
export function multiSelect({ options, values = [], size = 6, props = {} }) {
	const chosen = new Set(values);
	return h("select.input.multi", { multiple: true, size, ...props },
		(options ?? []).map((option) => {
			const entry = typeof option === "object" ? option : { value: option, label: String(option) };
			return h("option", { value: entry.value, selected: chosen.has(entry.value) }, entry.label);
		}));
}

/**
 * @description Reads the chosen values out of a multiple-selection list.
 * @param {HTMLSelectElement} el - The list.
 * @returns {Array<string>} The selected values.
 */
export function selectedValues(el) {
	return [...el.selectedOptions].map((option) => option.value);
}

/**
 * @description A button.
 * @param {object} options - Button options.
 * @param {string} options.label - The text.
 * @param {function(): void} options.onClick - What it does.
 * @param {string} [options.variant] - `"primary"`, `"danger"`, or `"ghost"`.
 * @param {boolean} [options.disabled] - Whether it is unavailable.
 * @param {string} [options.confirm] - Asks this before acting. Use for anything a
 *   player would notice and an admin could not undo.
 * @param {string} [options.title] - Tooltip.
 * @param {boolean} [options.small] - Whether to render compactly.
 * @returns {HTMLElement} The button.
 */
export function button({ label, onClick, variant, disabled, confirm, title, small }) {
	return h("button.btn", {
		class: [variant ? `btn-${variant}` : "", small ? "btn-sm" : ""].filter(Boolean).join(" "),
		disabled: !!disabled,
		title: title ?? "",
		onClick: () => {
			if (confirm && !window.confirm(confirm)) return;
			onClick();
		},
	}, label);
}

/**
 * @description A small coloured label.
 * @param {string} text - The text.
 * @param {string} [tone] - `"ok"`, `"warn"`, `"danger"`, or `"info"`.
 * @returns {HTMLElement} The badge.
 */
export function chip(text, tone) {
	return h("span.chip", { class: tone ? `is-${tone}` : "" }, text);
}

/**
 * @description A hit-point bar, coloured by how much is left.
 * @param {number} hp - Current hit points.
 * @param {number} maxHp - Maximum hit points.
 * @returns {HTMLElement} The bar.
 */
export function hpBar(hp, maxHp) {
	const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
	const tone = ratio <= 0 ? "danger" : ratio < 0.34 ? "danger" : ratio < 0.67 ? "warn" : "ok";
	return h("div.hp",
		h("div.hp-track", h("div.hp-fill", { class: `is-${tone}`, style: { width: `${ratio * 100}%` } })),
		h("span.hp-text", `${hp}/${maxHp}`),
	);
}

/**
 * @description An empty state.
 * @param {string} message - What to say.
 * @returns {HTMLElement} The element.
 */
export function empty(message) {
	return h("p.empty", message);
}

/**
 * @description A line for reporting the result of an action in place.
 *
 *   Sections report success and refusal next to the control that caused it. The
 *   activity feed also records them, but an admin who just pressed a button should
 *   not have to change section to find out whether it worked.
 * @returns {{el: HTMLElement, show: Function, clear: Function}} The line and its controls.
 */
export function flash() {
	const el = h("span.flash");
	return {
		el,
		/**
		 * @description Shows a message.
		 * @param {string} message - What happened.
		 * @param {string} [tone="ok"] - `"ok"`, `"warn"`, or `"danger"`.
		 * @returns {void}
		 */
		show(message, tone = "ok") {
			el.textContent = message;
			el.className = `flash is-${tone}`;
		},
		/**
		 * @description Clears the message.
		 * @returns {void}
		 */
		clear() {
			el.textContent = "";
			el.className = "flash";
		},
	};
}
