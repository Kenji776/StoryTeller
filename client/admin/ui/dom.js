/**
 * dom — element construction, and the two helpers that genuinely need a document.
 *
 * Everything else in the panel is pure and unit tested; this module is where the
 * DOM is allowed, and it is kept small on purpose. It has no tests because there
 * is no DOM harness in this project (see `docs/testing.md`) — which is the reason
 * it holds no decisions worth testing, only construction.
 */

/** Props handled by name rather than being set as attributes or properties. */
const SPECIAL = new Set(["class", "className", "text", "html", "dataset", "style", "ref"]);

/**
 * @description Parses `"button.btn.primary"` into a tag and its classes.
 * @param {string} selector - A tag name, optionally followed by `.class` segments.
 * @returns {{tag: string, classes: Array<string>}} The parsed parts.
 */
function parseSelector(selector) {
	const [tag, ...classes] = String(selector).split(".");
	return { tag: tag || "div", classes };
}

/**
 * @description Appends a child of any supported kind.
 *
 *   Nullish and boolean children are skipped rather than rendered, so
 *   `cond && h(...)` reads as a conditional rather than printing "false".
 * @param {Node} parent - The element being built.
 * @param {*} child - A node, string, number, array, or nothing.
 * @returns {void}
 */
function append(parent, child) {
	if (child === null || child === undefined || typeof child === "boolean") return;
	if (Array.isArray(child)) {
		for (const item of child) append(parent, item);
		return;
	}
	parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * @description Builds an element.
 *
 *   Props whose name matches an `on*` handler are bound as listeners; props that
 *   name a property of the element (`value`, `checked`, `disabled`) are set as
 *   properties, because setting those as attributes only works the first time.
 *   Everything else becomes an attribute.
 * @param {string} selector - A tag name with optional `.class` suffixes.
 * @param {object} [props] - Attributes, properties, and `on*` handlers.
 * @param {...*} children - Nodes, strings, numbers, arrays, or nothing.
 * @returns {HTMLElement} The element.
 */
export function h(selector, props = {}, ...children) {
	const { tag, classes } = parseSelector(selector);
	const el = document.createElement(tag);
	if (classes.length) el.classList.add(...classes);

	const options = props && typeof props === "object" && !(props instanceof Node) && !Array.isArray(props)
		? props
		: {};

	// A second positional argument that is clearly a child, not a props bag.
	if (options !== props) children.unshift(props);

	for (const [key, value] of Object.entries(options)) {
		if (value === null || value === undefined) continue;

		if (key.startsWith("on") && typeof value === "function") {
			el.addEventListener(key.slice(2).toLowerCase(), value);
		} else if (key === "class" || key === "className") {
			el.classList.add(...String(value).split(/\s+/).filter(Boolean));
		} else if (key === "text") {
			el.textContent = String(value);
		} else if (key === "html") {
			el.innerHTML = String(value);
		} else if (key === "dataset") {
			Object.assign(el.dataset, value);
		} else if (key === "style") {
			Object.assign(el.style, value);
		} else if (key === "ref" && typeof value === "function") {
			value(el);
		} else if (!SPECIAL.has(key) && key in el) {
			el[key] = value;
		} else if (value === false) {
			el.removeAttribute(key);
		} else {
			el.setAttribute(key, value === true ? "" : String(value));
		}
	}

	for (const child of children) append(el, child);
	return el;
}

/**
 * @description Replaces an element's contents.
 * @param {Element} parent - The element to fill.
 * @param {...*} children - The new contents.
 * @returns {Element} The parent, for chaining.
 */
export function fill(parent, ...children) {
	parent.replaceChildren();
	for (const child of children) append(parent, child);
	return parent;
}

/**
 * @description Renders DM narration as readable plain text.
 *
 *   The DM returns markup — `<p>` paragraphs, `<em>` for speech — which the game
 *   client renders with innerHTML. The activity feed escapes everything it prints,
 *   so the tags would otherwise appear literally in the transcript. Parsed rather
 *   than regex-stripped so entities like `&amp;` decode correctly, and read back
 *   via textContent so nothing from the model is ever interpreted as markup here.
 * @param {string} html - Narration markup from the DM.
 * @returns {string} Plain text, with paragraph boundaries kept legible.
 */
export function plainText(html) {
	const holder = document.createElement("div");
	holder.innerHTML = String(html);
	for (const el of holder.querySelectorAll("p, br, div")) el.append(" ");
	return holder.textContent || "";
}
