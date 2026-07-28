/**
 * portraitPrompt — turns a character sheet into an image prompt the player can edit.
 *
 * @description Deliberately free of imports, because both sides need it: the browser
 *   populates the editable box from it as the player builds their character, and the
 *   server falls back to it when no edited prompt arrives. Two implementations would
 *   drift, and the text the player edits has to be the text that gets used.
 *
 *   Two failures shaped this. The old prompt read seven fields — race, class, gender,
 *   age, height, weight, description — and ignored everything the character is
 *   visibly wearing and holding, so a plate-armoured knight and a robed wizard of the
 *   same race produced the same picture. And images came back with words printed on
 *   them, lifted out of the prompt.
 *
 *   The defence against text is mostly subtraction: the character's name never goes
 *   in, because a proper noun is the most reliable way to get a name plate or
 *   signature painted into the picture, and the guard at the end stays abstract
 *   rather than listing things ("no scrolls with writing") that invite the model to
 *   draw the very object.
 */

/** Appended to every prompt, whatever the player wrote. */
export const NO_TEXT_GUARD = "Pure illustration with no writing of any kind anywhere in the image.";

/** Longest prompt sent. Well under the API limit; beyond this it is a paste. */
const MAX_PROMPT = 4000;

/** The house style, applied unless the player edits it away. */
const STYLE = "Painterly digital fantasy illustration, dramatic cinematic lighting, "
	+ "rich detail, full-body character portrait against a simple muted background.";

/**
 * @description Describes a physique from ability scores, so two characters with the
 *   same race and class do not come back looking identical.
 * @param {object} stats - The ability scores.
 * @returns {string} A build description, or "" when there is nothing to go on.
 */
function buildFromStats(stats) {
	const str = Number(stats?.str);
	const dex = Number(stats?.dex);
	if (!Number.isFinite(str) || !Number.isFinite(dex)) return "";

	if (str >= 15 && str > dex) return "powerfully built and heavy-set";
	if (dex >= 15 && dex > str) return "lean and wiry, light on their feet";
	if (str >= 13 && dex >= 13) return "athletic and well-proportioned";
	return "";
}

/**
 * @description Strips a character's own name out of free text. Players write their
 *   name into the description without thinking, and it reaches the canvas as a
 *   caption.
 * @param {string} text - The free description.
 * @param {string} name - The character's name.
 * @returns {string} The description with the name removed.
 */
function withoutName(text, name) {
	if (!text) return "";
	let cleaned = String(text);

	for (const part of String(name ?? "").split(/\s+/).filter((w) => w.length > 2)) {
		cleaned = cleaned.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "");
	}

	// Tidy the punctuation the removal leaves behind ("Brannor Ironfoot, a veteran").
	return cleaned.replace(/\s*,\s*,/g, ",").replace(/^[\s,;.]+/, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * @description Names a worn or carried item without its mechanical detail — the
 *   picture wants "Chain Mail", not "AC 16, heavy".
 * @param {*} item - A sheet item, object or string.
 * @returns {string} The item's name, or "".
 */
function itemName(item) {
	if (typeof item === "string") return item.trim();
	return typeof item?.name === "string" ? item.name.trim() : "";
}

/**
 * Builds the default portrait prompt for a character.
 *
 * @description Pure and stable: the editable box is populated from this, so a prompt
 *   that varied between renders would overwrite whatever the player had typed.
 * @param {object} sheet - The sheet, as `buildCurrentSheet` produces it.
 * @returns {string} A descriptive prompt, without the no-text guard. Never empty.
 */
export function buildPortraitPrompt(sheet) {
	const s = sheet ?? {};

	const race = String(s.race ?? "").trim();
	const cls = String(s.class ?? "").trim();
	const who = [race, cls].filter(Boolean).join(" ") || "adventurer";

	const physical = [
		String(s.gender ?? "").trim(),
		s.age ? `${String(s.age).trim()} years old` : "",
		String(s.height ?? "").trim(),
		String(s.weight ?? "").trim(),
		buildFromStats(s.stats),
	].filter(Boolean).join(", ");

	const worn = [itemName(s.armor), itemName(s.weapon), itemName(s.trinket)].filter(Boolean);

	const bearing = [
		String(s.background ?? "").trim() ? `a former ${String(s.background).trim().toLowerCase()}` : "",
		String(s.alignment ?? "").trim() ? `${String(s.alignment).trim().toLowerCase()} in bearing` : "",
	].filter(Boolean).join(", ");

	const level = Number(s.level);
	const seasoning = Number.isFinite(level) && level >= 5 ? "visibly experienced, well-worn gear" : "";

	const described = withoutName(s.description, s.name);

	return [
		`A ${who}.`,
		physical ? `${physical}.` : "",
		worn.length ? `Wearing and carrying: ${worn.join(", ")}.` : "",
		bearing ? `${bearing.charAt(0).toUpperCase()}${bearing.slice(1)}.` : "",
		seasoning ? `${seasoning}.` : "",
		described ? `${described}${/[.!?]$/.test(described) ? "" : "."}` : "",
		STYLE,
	].filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Prepares a prompt for sending, whoever wrote it.
 *
 * @description The player owns the prompt, but not the guard: they asked for
 *   pictures without writing on them, and a prompt they pasted over would otherwise
 *   silently lose that. Capping happens before the guard is appended so the guard
 *   always survives.
 * @param {*} text - The prompt, possibly edited by the player.
 * @returns {string} The prompt to send.
 */
export function finalisePrompt(text) {
	const body = (typeof text === "string" ? text : "").trim() || buildPortraitPrompt(null);
	if (body.includes(NO_TEXT_GUARD)) return body.slice(0, MAX_PROMPT);

	const room = MAX_PROMPT - NO_TEXT_GUARD.length - 1;
	return `${body.slice(0, room).trim()} ${NO_TEXT_GUARD}`;
}
