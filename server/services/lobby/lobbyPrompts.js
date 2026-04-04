/**
 * LLM prompt composition methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 *
 * Contains: composeSetupPrompt, composeMessages, composeWipeEpilogue,
 * playersSummary, and the private _*Instruction helpers.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sanitizeForLLMName } from "../llmService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_MOODS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "client", "config", "music_moods.json"), "utf8")).moods;
const MOOD_IDS = MUSIC_MOODS.map(m => m.id);
const MOOD_UNION = MOOD_IDS.map(id => `"${id}"`).join(" | ");
const MOOD_LIST  = MOOD_IDS.join(", ");

// Human-readable power-tier label for each level, used in LLM prompts so the
// AI understands the characters' relative strength in plain-English terms.
const LEVEL_FLAVOR = {
	1:  "ordinary commoner",
	2:  "apprentice adventurer",
	3:  "fledgling hero",
	4:  "seasoned wanderer",
	5:  "veteran adventurer",
	6:  "rising champion",
	7:  "renowned warrior",
	8:  "regional legend",
	9:  "elite hero",
	10: "master of the craft",
	11: "realm-shaker",
	12: "archmage-tier",
	13: "legendary figure",
	14: "mythic champion",
	15: "planar traveller",
	16: "world-breaker",
	17: "demi-legend",
	18: "near-divine",
	19: "titan-slayer",
	20: "apex mortal",
	21: "ascendant",
	22: "demigod",
	23: "avatar of power",
	24: "elder god's equal",
	25: "living deity",
};

/**
 * Returns a human-readable power-tier label for a given character level.
 * Clamps out-of-range values to the nearest defined tier (1–25).
 *
 * @param {number} lvl - The character's level.
 * @returns {string} A flavor label such as "veteran adventurer" or "living deity".
 */
function levelFlavorTag(lvl) {
	return LEVEL_FLAVOR[lvl] || LEVEL_FLAVOR[Math.min(25, Math.max(1, lvl))] || "adventurer";
}

export const promptMethods = {
	/**
	 * Builds a short prompt asking the LLM to summarise the adventure so far.
	 * Falls back to a generic string when the lobby is not found.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {string} A system prompt string for the summary request.
	 */
	composeSummaryPrompt(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return "Summarize the adventure so far.";
		const players = this.playersSummary(lobbyId);
		return `You are a campaign chronicler. Summarize the adventure so far for the following party:\n${players}\n\nProvide a concise narrative summary of key events, decisions, and outcomes. Keep it under 500 words.`;
	},

	/**
	 * Produces a multi-line string describing every player in the lobby.
	 * Each line includes class, level, XP, weapon, armor, trinket, stats,
	 * inventory, and abilities — formatted for insertion into LLM prompts.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {string} Newline-separated player descriptions, or "" if lobby not found.
	 */
	playersSummary(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return "";
		return Object.values(s.players)
			.map((p) => {
				const stats = Object.entries(p.stats || {})
					.map(([k, v]) => `${k}:${v}`)
					.join(", ");
				const inv = (p.inventory || []).map((i) => (typeof i === "string" ? i : `${i.name}×${i.count ?? 1}`)).join(", ") || "none";
				const abil = (p.abilities || []).join(", ") || "none";
				const xp = p.xp ?? 0;
				const wpn = p.weapon ? `${p.weapon.name} (${p.weapon.damage} ${p.weapon.damageType}, ${p.weapon.range || "melee"})` : "unarmed";
			const arm = p.armor  ? `${p.armor.name} (AC ${p.armor.ac}, ${p.armor.type})` : "unarmored (AC 10)";
			const trn = p.trinket ? `${p.trinket.name}` : "none";
			const tier = levelFlavorTag(Number(p.level) || 1);
			return `${p.name} [${p.class} L${p.level} (${tier}); XP ${xp}; weapon ${wpn}; armor ${arm}; trinket ${trn}; stats ${stats}; inv ${inv}; abilities ${abil}]`;
			})
			.join("\n");
	},

	// ==== LLM Prompts ====
	/**
	 * Builds the opening-scene prompt sent to the LLM at the start of a campaign.
	 * Incorporates campaign tone, theme, setting, brutality, difficulty, and loot
	 * instructions, plus the full party summary. Returns a trimmed prompt string.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {string} The setup system prompt for the LLM.
	 */
	composeSetupPrompt(lobbyId) {
		// Updated: no legacy tag formats. Keep this simple for the opening scene.
		const players = this.playersSummary(lobbyId);
		const s = this.index[lobbyId];
		const flavorLines = [];
		if (s?.campaignTone?.prompt)  flavorLines.push(`Tone: ${s.campaignTone.prompt}`);
		if (s?.campaignTheme?.prompt) flavorLines.push(`Theme: ${s.campaignTheme.prompt}`);
		const flavorBlock = flavorLines.length ? `\n\t\t\tCampaign flavor:\n\t\t\t${flavorLines.join("\n\t\t\t")}\n` : "";
		const brutalityInstruction = this._brutalityInstruction(s?.brutalityLevel ?? 5);
		const difficultyInstruction = this._difficultyInstruction(s?.difficulty ?? "standard");
		const lootInstruction       = this._lootInstruction(s?.lootGenerosity ?? "fair");
		const settingInstruction    = this._settingInstruction(s?.campaignSetting ?? "standard");
		return `
			You are a creative, cinematic Dungeon Master introducing a new Dungeons & Dragons one-shot for beginners.
			Create a compelling opening that explains why the party is together, where they are, and the immediate situation.
			Use concise, vivid narration and end with a short prompt like: "What would you like to do?"
			Avoid heavy combat immediately; let the players orient first. Your narration text may include basic formatted HTML. Do not use markdown or code fences.
			World setting: ${settingInstruction}
			Content & tone: ${brutalityInstruction}
			Difficulty: ${difficultyInstruction}
			Loot: ${lootInstruction}
			${flavorBlock}
			Here are the players:
			${players}

			Reply ONLY with a SINGLE JSON object (no markdown, no code fences). The text property may only contain minimally formated HTML. Do not include any JSON or other content other than the text to be narrated in the 'text' property.
			{
			  "text": string,
			  "music": ${MOOD_UNION},
			  "sfx": string[],
			  "suggestions": string[]
			}
			Choose a music mood that fits the opening scene. Populate suggestions with 3-5 short action phrases (max 8 words each) the active player could plausibly do first. Suggestions should always be in the first person prose, always "I" not "you" or "your". Suggestioos should align with the characters alignment.
			For "sfx", include 0-3 short sound effect descriptions (2-4 words each) for dramatic moments in the scene, e.g. "sword clash", "door creak", "wolf howl", "thunder clap". Only include when something impactful or atmospheric happens. Set to an empty array if no sound effects fit.
			`.trim();
	},

	/**
	 * Assembles the full message array sent to the LLM for each player action.
	 * Includes system context (rules, schema, party status, enemy roster, spell
	 * slots, story history) followed by the player's action as a user message.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {string} actorName - The name of the player taking the action.
	 * @param {string} action - The player's action text.
	 * @param {object|null} diceOutcome - Optional dice-roll result from the server,
	 *   shaped as `{ kind, value, detail: { base, bonus, outcome } }`.
	 * @returns {Array<{role: string, content: string, name?: string}>} Ordered
	 *   message array ready to pass to the LLM API.
	 */
	composeMessages(lobbyId, actorName, action, diceOutcome) {
		const safeName = sanitizeForLLMName(actorName);
		const s = this.index[lobbyId];
		if (!s) return [{ role: "system", content: "Error: Lobby not found." }];

		// If storyContext contains the setup prompt, treat as no prior context
		const storyContext = s.storyContext?.includes("You are a creative, cinematic Dungeon Master") ? "(The story has just begun. No prior context.)" : s.storyContext || "(No prior story yet.)";
		const ancientHistory = s.ancientHistory || "";

		// Collect pinned moments for the LLM
		const pinnedText = (s.pinnedMoments || []).filter(p => p.snippet).map(p =>
			`[PINNED by ${p.pinnedBy}] ${p.speaker}: ${p.snippet}`
		).join("\n");

		const players = Object.keys(s.players || {});

  // MAP DISABLED — characters and terrain fields commented out to save tokens
  // "characters": [
  //   {
  //     "name": string,
  //     "type": "player" | "npc" | "creature",
  //     "emoji": string | null,
  //     "x": number,
  //     "y": number,
  //     "facing": "north" | "south" | "east" | "west" | null,
  //     "status": string | null
  //   }
  // ],
  // "terrain": {
  //   "type": "forest" | "dungeon" | "plains" | "village" | "mountain" | "beach" | "cave" | "castle" | "road" | "unknown",
  //   "features": [string] // e.g. ["river","campfire","bridge"]
  // },
		const schema = `
Reply ONLY with a SINGLE JSON object (no markdown, no code fences). The text property may only contain minimally formated HTML. Do not include any JSON or other content other than the text to be narrated in the 'text' property.

Schema: {
  "text": string,
  "updates": {
    "xp": [{ "player": string, "amount": number, "reason": string }],
    "hp": [{ "player": string, "delta": number, "reason": string, "new_total": number }],
    "inventory": [{ "player": string, "item": string, "change": number, "description": string, "change_type": "add" | "remove", "attributes": { "item_type"?: "weapon" | "armor" | "trinket" | "consumable", "damage"?: string, "damage_type"?: string, "range"?: string, "ac"?: number, "armor_type"?: string, ...any } }],
    "gold": [{ "player": string, "delta": number }],
    "conditions": [{ "player": string, "add": string[], "remove": string[] }],
    "abilities": [{ "player": string, "change_type": "add" | "remove", "name": string, "description": string, "attributes": object }],
    "enemies": [{ "name": string, "hp": number, "max_hp": number, "ac": number, "str": number, "dex": number, "con": number, "int": number, "wis": number, "cha": number, "cr": string, "status": "active" | "dead" | "fled", "damage_taken": number | null, "reason": string | null }]
  },
  "prompt": string,
  "roll": { "sides": number, "stats": string[], "mods": number, "dc": number } | null,
  "suggestions": string[],
  "spellUsed": boolean,
  "music": ${MOOD_UNION} | null,
  "combat_over": boolean,
  "sfx": string[]
};
`;

		const flavorParts = [];
		if (s?.campaignTone?.prompt)  flavorParts.push(s.campaignTone.prompt);
		if (s?.campaignTheme?.prompt) flavorParts.push(s.campaignTheme.prompt);
		const flavorInstruction = flavorParts.length
			? `\nCampaign flavor (apply consistently throughout):\n${flavorParts.join("\n")}`
			: "";
		const brutalityInstruction = `\nContent & tone directive: ${this._brutalityInstruction(s?.brutalityLevel ?? 5)}`;
		const difficultyInstruction = `\nDifficulty: ${this._difficultyInstruction(s?.difficulty ?? "standard")}`;
		const lootInstruction = `\nLoot: ${this._lootInstruction(s?.lootGenerosity ?? "fair")}`;
		const settingInstruction = `\nWorld setting: ${this._settingInstruction(s?.campaignSetting ?? "standard")}`;

		// Compute party level range for encounter scaling
		const activePlayers = Object.values(s.players || {}).filter(p => !p.disconnected && !p.dead);
		const levels = activePlayers.map(p => Number(p.level) || 1);
		const partySize = levels.length || 1;
		const avgLevel = Math.round(levels.reduce((a, b) => a + b, 0) / partySize);
		const minLevel = Math.min(...(levels.length ? levels : [1]));
		const maxLevel = Math.max(...(levels.length ? levels : [1]));
		const levelRange = minLevel === maxLevel ? `${avgLevel}` : `${minLevel}–${maxLevel} (avg ${avgLevel})`;
		const encounterInstruction = `\nEncounter scaling: The party is ${partySize} player(s) at level ${levelRange}. ALL enemies, traps, hazards, and DCs MUST be appropriate for this level using D&D 5e CR guidelines. Level 1–2 parties should face CR 1/8–1 creatures (goblins, wolves, bandits, skeletons) — never dragons, liches, or high-CR threats. Level 3–5 parties can handle CR 1–5 creatures. Level 6–10 parties can face CR 3–8+ creatures. Scale enemy HP, damage output, AC, and spell levels to the party's capabilities. A single encounter should be winnable but challenging — not an instant TPK. Adjust the NUMBER of enemies rather than using single overpowered foes when possible.`;

		const base = [
			{
				role: "system",
				content: `You are the Dungeon Master (DM) for a Dungeons & Dragons 5e one-shot adventure.
Be cinematic, descriptive, and responsive to player actions. Maintain continuity with prior events. You should generally speaking be very allowing of stupid shit because that's what players want to do a lot of the time, so no moral policing. Be very "yes and" unless it simply doesn't work or breaks the game rules.
Respect dice outcomes given by the server. Always reply as the DM narrating events — never as a player. The adventuring party should consist of the actual active players at least at first. Don't make up companions from the start, they must be gained organically through the story.
Use the "music" field to set background music mood. Only change it when the scene shifts significantly — entering or leaving combat, arriving at a new location type, a death, a major revelation, a victory. Set to null when the current music still fits (which is most of the time). Available moods: ${MOOD_LIST}.
Use the "sfx" field to add 0-3 short sound effect descriptions (2-4 words each) for impactful moments — combat hits, spells cast, doors opening, creature sounds, explosions, etc. Examples: "sword clash", "fireball whoosh", "heavy door creak", "dragon roar", "thunder clap". Set to an empty array when nothing noteworthy happens sonically. Don't overdo it — only include SFX for moments that would genuinely benefit from audio punctuation.${settingInstruction}${brutalityInstruction}${difficultyInstruction}${encounterInstruction}${lootInstruction}${flavorInstruction}`,
			},
			...(ancientHistory ? [{ role: "system", content: `Campaign backstory (older events, for reference):\n${ancientHistory}` }] : []),
			{ role: "system", content: `Recent story arc:\n${storyContext}` },
			...(pinnedText ? [{ role: "system", content: `Player-pinned important moments (do NOT forget or contradict these):\n${pinnedText}` }] : []),
			{ role: "system", content: `Active players: ${players.map(name => {
				const p = s.players[name];
				if (p?.dead) return `${name} (☠️ DEAD)`;
				const hp = Number(p?.stats?.hp ?? 0);
				const maxHp = Number(p?.stats?.max_hp ?? p?.stats?.hp ?? 10);
				return `${name} (HP: ${hp}/${maxHp})`;
			}).join(", ")}` },
			...(s.currentMusic
				? [{ role: "system", content: `Currently playing music mood: "${s.currentMusic}". Only change this if the scene genuinely calls for a different mood — set "music" to null to keep the current music.` }]
				: [{ role: "system", content: `No music is playing yet. Set the "music" field to the mood that best fits the current scene.` }]),
			{ role: "system", content: schema },
			{
				role: "system",
				content: `When you narrate what happens, you must also include all mechanical results under the "updates" field.
If a player takes or avoids damage, consumes or gains an item, or uses a spell or ability, you must reflect it in "updates".
Examples:
- If a player burns their hand or steps into fire → add an "hp" update with a negative delta and reason.
- DEATH: If an hp update would reduce a player to 0 HP or below, set "new_total" to 0. This means the character DIES. You MUST narrate their death dramatically — describe how they fall, their final moments, and the impact on the party. From that point forward in this response and all future responses, that character is GONE. Do not give them actions, dialogue, or any narrative presence as a living character.
- If a player drinks or throws a potion → add an "inventory" update reducing that item count.
- If a player receives gold or treasure → add a "gold" update.
- If they get poisoned, stunned, or similar → add a "conditions" update. Use lowercase canonical condition names: blinded, burning, charmed, deafened, exhausted, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious. Always remove a condition when it logically ends (e.g. remove "burning" after it's extinguished).
- If the player says "I roll" anywhere in their dialog DO NOT immediatly resolve the action. Instead prompt them to roll an appropriate dice. Then when they do, judge the action accordingly. If the next player response is not a roll, the player immediatly fails whatever they were trying to do. Rolling is a crucial part of D&D and players want to roll for actions. Let them. You should prompt them what kind of dice to roll in this case.
- If requesting the player rolls a dice include a "roll" property in your JSON response. The value should be an object with four properties: "sides" (the number of sided die they should roll), "stats" (the stats to include in addition to the raw roll), "mods" (discretionary adjustments due to player conditions or other circumstances), and "dc" (the Difficulty Class — the minimum total the player must meet or exceed to succeed). Always set "dc" to an appropriate D&D 5e value (e.g. 10 for easy, 15 for medium, 20 for hard). The client will determine pass/fail and report it back to you so you can narrate the outcome.

A player may affected with any of the following conditions. Ensure to apply them appropriatly including rejecting actions that are impossible due to their condition such as taking an action while unconcious, or moving while restrained, hearing while deafened etc. In any of those types of cases the attempted action should immediatly fail unless you feel like providing a saving throw.

Condition	Effect
🙈	blinded	- Can't see. Auto-fails sight checks. Attack rolls against it have advantage; its attack rolls have disadvantage.
🔥	burning	- On fire. Takes fire damage at the start of each turn until extinguished (action to stop, drop, and roll).
💞	charmed	- Can't attack the charmer. The charmer has advantage on social checks against it.
🔇	deafened - Can't hear. Auto-fails hearing checks.
😩	exhausted - Suffers cumulative penalties at each level: disadvantage on checks, speed halved, attack/save disadvantage, speed 0, death.
😱	frightened - Disadvantage on ability checks and attack rolls while source of fear is in sight. Can't willingly move closer to the source.
🤼	grappled - Speed becomes 0. Ends if the grappler is incapacitated or moved out of range.
💫	incapacitated - Can't take actions or reactions.
👻	invisible - Impossible to see without magic. Attacks against it have disadvantage; its attacks have advantage.
⚡  paralyzed - Incapacitated and can't move or speak. Auto-fails Str/Dex saves. Attacks have advantage; hits within 5 ft. are critical hits.
🗿	petrified -	Transformed to stone. Incapacitated, weight ×10, resistant to all damage, immune to poison/disease.
🤢	poisoned -	Disadvantage on attack rolls and ability checks.
🛌	prone - Melee attacks against it have advantage. Ranged attacks have disadvantage. Must use half movement to stand up.
🕸️	 restrained - Speed 0. Attack rolls against it have advantage; its attacks have disadvantage. Disadvantage on Dex saves.
💥	stunned - Incapacitated, can't move, barely speaks. Auto-fails Str/Dex saves. Attack rolls against it have advantage.
💤	unconscious - Incapacitated, can't move or speak, unaware. Drops held items. Attacks have advantage; hits within 5 ft. are critical hits.

Do not skip updates just because the action fails — always include the logical consequence.
Always populate the "suggestions" array with 3–5 short action phrases (max 8 words each) that the active player could plausibly do next given the current scene. These are shown as quick-action hints in the UI. Make them specific to what is happening, not generic. Suggestions should always be in the first person prose, always "I" not "you" or "your". Suggestioos should align with the characters alignment and mixed with the players previous actions.

ENEMY TRACKING: When you introduce ANY hostile creature, NPC combatant, or monster, you MUST include an "enemies" array entry in "updates" with their full stat block. Use D&D 5e-appropriate stats for the creature's CR. Required fields:
- "name": unique identifier (e.g. "Goblin 1", "Dire Wolf", "Bandit Captain")
- "hp" and "max_hp": current and maximum hit points
- "ac": armor class
- "str", "dex", "con", "int", "wis", "cha": ability scores
- "cr": challenge rating as a string (e.g. "1/4", "1", "5")
- "status": "active" (alive and fighting), "dead" (killed), or "fled" (escaped)
- "damage_taken": amount of damage dealt THIS turn (null if none)
- "reason": brief description of what happened to them this turn (null if nothing)
Every turn that involves combat, include ALL currently active enemies in the "enemies" array — even those not affected this turn — so the server can maintain an accurate roster. When an enemy takes damage, reduce their "hp" by the damage amount. When an enemy reaches 0 hp, set "status" to "dead". Track enemy HP across turns — the current enemy state will be provided to you each turn.

COMBAT STATUS: You MUST set the "combat_over" field in EVERY response.
- Set "combat_over": false while combat is still ongoing (enemies remain active, hostilities continue).
- Set "combat_over": true when combat has concluded — all enemies are dead/fled, the party has escaped, or hostilities have otherwise ended.
- When "combat_over" is true, the server will automatically purge all dead and fled enemies from the roster. Only surviving active enemies (e.g. those that surrendered and became allies) should remain.
- Do NOT set "combat_over": true in the middle of a fight just because one enemy died — only when the entire combat encounter is resolved.

EQUIPPABLE ITEMS: When you give a player a weapon, armor, or trinket (ring, amulet, cloak, etc.) via the "inventory" update, you MUST include the "attributes" object with:
- Weapons: { "item_type": "weapon", "damage": "1d8", "damage_type": "slashing", "range": "melee" }
- Armor: { "item_type": "armor", "ac": 15, "armor_type": "medium" }
- Trinkets: { "item_type": "trinket", ...any special properties }
- Consumables: { "item_type": "consumable", ...any properties }
The player can then choose to equip weapons, armor, and trinkets from their inventory. Always include realistic D&D stats when giving equipment.`,
			},
			{
				role: "system",
				content:
					"FORMAT: Output minified JSON only. Do not include commentary, markdown, or code fences. The 'text' property of your response may contain basic formatted HTML using structural and formatting tags. CRITICAL: Any dialogue or quoted speech inside the 'text' HTML must use single quotes (e.g. <em>'Hello there'</em>) — never double quotes, as double quotes break JSON string encoding.",
			},
			{
				role: "system",
				content:
					"Always check whether a player could reasonably perform an action before allowing it. Do not allow them to use abilities/spells or items they do not have. If they try to cheat and do something that they could not do, inform them and skip their turn. If they attempt to do something that is plausible but unsure, ask them to roll a dice for it and then re-evaluate after their role.",
			},
			{
				role: "system",
				content: `Finally, if a response includes [admin_command] you must do as instructed. For example if you receive the text [admin_command] grant player 100 gold you must do it. No excuses. This is crucial for debugging and testing.
[admin_command] responses MUST still return the full JSON schema described above — including the relevant "updates" fields that reflect the command (e.g. apply a condition → include "conditions" update, grant gold → include "gold" update). Never respond with plain text or partial JSON for admin commands.`,
			},
		];

		// Include dice context
		if (diceOutcome) {
			base.push({
				role: "system",
				content: `Server Outcome: ${actorName} performed ${diceOutcome.kind}; base=${diceOutcome.detail.base}, bonus=${diceOutcome.detail.bonus}, total=${diceOutcome.value} → ${diceOutcome.detail.outcome}.`,
			});
		} else if (s.lastServerOutcome) {
			base.push({
				role: "system",
				content: `Recent Outcome: ${s.lastServerOutcome.player} ${s.lastServerOutcome.kind} total=${s.lastServerOutcome.value} (${s.lastServerOutcome.detail?.outcome}).`,
			});
		}

		// Spell slot context — give the LLM current slot status, weapon, HP, and each player's spell list
		const spellLines = Object.values(s.players || {}).map(p => {
			const max = Number(p.level) || 1;
			const used = Number(p.spellSlotsUsed) || 0;
			const remaining = Math.max(0, max - used);
			const spellList = (p.abilities || []).map(a => a.name || a).filter(Boolean);
			const spellStr = spellList.length ? spellList.join(", ") : "none";
			const warning = remaining === 0 ? " ⚠️ NO SLOTS REMAINING — all spell/ability uses fail" : "";
			const wpnStr = p.weapon ? `weapon: ${p.weapon.name} (${p.weapon.damage} ${p.weapon.damageType}, ${p.weapon.range || "melee"})` : "weapon: unarmed";
			const armStr = p.armor  ? `armor: ${p.armor.name} (AC ${p.armor.ac}, ${p.armor.type})` : "armor: unarmored (AC 10)";
			const trnStr = p.trinket ? `trinket: ${p.trinket.name}${p.trinket.description ? ` (${p.trinket.description})` : ""}` : "trinket: none";
			const currentHp = Number(p.stats?.hp ?? 0);
			const maxHp = Number(p.stats?.max_hp ?? p.stats?.hp ?? 10);
			const hpStr = p.dead ? "HP: 0 — ☠️ DEAD" : `HP: ${currentHp}/${maxHp}`;
			const hpWarning = !p.dead && currentHp > 0 && currentHp <= Math.floor(maxHp * 0.25) ? " ⚠️ CRITICALLY LOW HP" : "";
			const tier = levelFlavorTag(max);
			return `  - ${p.name} (${p.class || "?"} Lv ${max}, ${tier}): ${hpStr}${hpWarning} | ${wpnStr} | ${armStr} | ${trnStr} | abilities/spells known: [${spellStr}] | slots: ${remaining}/${max}${warning}`;
		}).join("\n");

		// Collect dead player names for explicit death instructions
		const deadPlayers = Object.values(s.players || {}).filter(p => p.dead).map(p => p.name);

		base.push({
			role: "system",
			content: `PLAYER STATUS & SPELL SLOTS (authoritative — do not guess or override):\n${spellLines}\n\nRules:\n- A player can only cast a spell or activate an ability if it is in their known list AND they have slots remaining.\n- Slots are shared between spells and abilities. Each use costs one slot.\n- If the ability/spell is not in their list, or remaining slots = 0, the action FAILS. You MUST reject it — narrate the consequence (embarrassing misfire, wild surge, nothing happens, ability fizzles, etc.) and set "spellUsed": false.\n- If a spell or ability is successfully used, set "spellUsed": true. The server will deduct the slot.\n- Always set "spellUsed": false when no spell or ability was used this turn.\n- IMPORTANT: You must NEVER allow a player to use a spell or ability when remaining slots = 0. This is a hard rule.\n- HP values shown above are AUTHORITATIVE. When you deal damage via an "hp" update, calculate the new_total based on these values. If an hp update would bring a player to 0 or below, their HP becomes 0 and they DIE.${deadPlayers.length ? `\n\n☠️ DEAD PLAYERS: ${deadPlayers.join(", ")}\nThese players are DEAD. Do NOT include them in narration as active participants. Do not give them dialogue, actions, or agency. They are gone. Other players may reference or mourn them, but the dead characters do not act, speak, or respond. Do not generate any updates (hp, inventory, conditions, etc.) for dead players.` : ""}`,
		});

		// Enemy roster — feed current enemy state so the LLM can track HP across turns
		const enemyRoster = this.enemyRoster(lobbyId);
		if (enemyRoster) {
			base.push({
				role: "system",
				content: `ACTIVE ENEMIES (authoritative — track HP across turns):\n${enemyRoster}\n\nRules:\n- These are the enemies currently in play. Their HP values are AUTHORITATIVE.\n- When an enemy takes damage, reduce their HP accordingly in the "enemies" update. When HP reaches 0, set "status" to "dead".\n- When introducing NEW enemies, include full stat blocks in the "enemies" update.\n- Every combat turn, include ALL active enemies in the "enemies" array — even those unaffected this turn — so the server keeps an accurate roster.\n- Dead enemies should still be listed with "status": "dead" until combat ends.\n- Do not resurrect dead enemies unless the narrative explicitly calls for it (e.g. necromancy).`,
			});
		}

		// Recent unsummarized history for continuity — everything after summarizedUpTo
		// (older events are captured in storyContext via auto-summarization)
		const fromIdx = s.summarizedUpTo || 0;
		base.push(...(s.history || []).slice(fromIdx));

		// Player action (use sanitized name)
		base.push({ role: "user", name: safeName, content: String(action) });

		return base;
	},

	// ==== TPK (Total Party Kill) Epilogue Prompt ====
	/**
	 * Builds the message array for a Total Party Kill epilogue narration.
	 * Compiles fallen-hero summaries, story recap, and recent history into
	 * a message sequence that instructs the LLM to write a closing epilogue
	 * rather than continuing the game.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @returns {Array<{role: string, content: string}>} Ordered message array
	 *   for the TPK epilogue LLM call.
	 */
	composeWipeEpilogue(lobbyId) {
		const s = this.index[lobbyId];
		if (!s) return [{ role: "system", content: "Error: Lobby not found." }];

		const ancientHistory = s.ancientHistory || "";

		// Build a summary of each fallen character with class/race/level
		const fallenSummary = Object.values(s.players || {}).map(p => {
			const cls = p.class || "Adventurer";
			const lvl = Number(p.level) || 1;
			const race = p.race || "Unknown";
			const tier = levelFlavorTag(lvl);
			return `  - ${p.name} (${race} ${cls}, Level ${lvl} — ${tier})`;
		}).join("\n");

		// Compile recent history as a readable narrative recap (NOT raw chat messages).
		// Raw role:"assistant"/role:"user" messages confuse the LLM into continuing
		// the game conversation instead of writing an epilogue.
		const fromIdx = s.summarizedUpTo || 0;
		const rawHistory = (s.history || []).slice(fromIdx);
		const recapLines = rawHistory.map(msg => {
			if (msg.role === "user") {
				const who = msg.name || "A player";
				return `${who}: "${msg.content}"`;
			}
			// Strip HTML tags for the recap — just keep the text
			const plain = (msg.content || "").replace(/<[^>]+>/g, "").trim();
			return plain ? `DM: ${plain}` : null;
		}).filter(Boolean);

		// Use the summarized story context as the primary narrative, falling back
		// to the first DM message (the opening scene) if no summary exists yet.
		const storySummary = s._hasSummary && s.storyContext
			? s.storyContext
			: (rawHistory.find(m => m.role === "assistant")?.content || "").replace(/<[^>]+>/g, "").trim();

		return [
			{
				role: "system",
				content: `You are the Dungeon Master. The entire adventuring party has just been killed — a Total Party Kill. You must now narrate the EPILOGUE. This is NOT a continuation of the adventure. Do NOT narrate new combat, new actions, new spells, or new events. The story is OVER.

Your task is to deliver a dramatic, bittersweet epilogue that:
1. Describes the immediate aftermath of the final death — the silence that follows, the scene around the fallen.
2. Reflects on each fallen hero individually: who they were, what they were trying to accomplish, and how they met their end. Base this ONLY on the history provided below — do not invent events that did not happen.
3. Describes what happens to the world now that the party has failed. What darkness spreads? What evil goes unchecked? What people suffer because these heroes fell?
4. Ends with a final, evocative closing line — something that would feel at home as the last line of a dark fantasy novel.

Be cinematic, melancholic, and respectful of each character's journey. This is the final narration the players will ever hear — make it memorable.

CRITICAL: Do NOT continue the game. Do NOT narrate new combat or actions. Only reflect on what has already happened and describe the world's fate.`,
			},
			...(ancientHistory ? [{ role: "system", content: `Campaign backstory:\n${ancientHistory}` }] : []),
			...(storySummary ? [{ role: "system", content: `The story so far:\n${storySummary}` }] : []),
			...(recapLines.length ? [{ role: "system", content: `Recent events (what just happened):\n${recapLines.join("\n")}` }] : []),
			{ role: "system", content: `The fallen party:\n${fallenSummary}` },
			{
				role: "system",
				content: `FORMAT: Output minified JSON only with this schema: { "text": string, "music": string | null, "sfx": string[] }
The "text" field may contain basic HTML formatting. Set "music" to "sad_moment". Include 1-2 atmospheric SFX like "wind howling", "distant thunder", etc.`,
			},
			{ role: "user", content: "The last hero has fallen. The adventure is over. Narrate the epilogue — do not continue the game." },
		];
	},

	// ==== Private instruction helpers ====
	/**
	 * Returns a content-tone directive string for the LLM based on a brutality
	 * level from 1 (family-friendly) to 10 (absolute brutality).
	 *
	 * @param {number} level - Brutality level (1–10).
	 * @returns {string} A directive sentence describing the desired tone.
	 */
	_brutalityInstruction(level) {
		const n = Number(level) ?? 5;
		if (n <= 1) return "This is a family-friendly adventure. Keep all descriptions completely clean and appropriate for young children. No violence, blood, death, or frightening content — enemies are defeated comically or run away. Narrate with whimsy and warmth.";
		if (n <= 3) return "Keep the tone light and heroic. Battles are dramatic but not graphic — injuries are glancing blows, enemies are subdued or flee. Avoid gore, disturbing imagery, or dark themes.";
		if (n <= 6) return "Use a standard fantasy adventure tone. Combat and danger feel real and consequential, with vivid but non-gratuitous descriptions. Injuries, death, and moral complexity are handled matter-of-factly.";
		if (n <= 8) return "Lean into gritty, visceral storytelling. Wounds bleed, deaths are described in detail, enemies may be cruel, and the world has a harsh edge. Dark themes are fair game.";
		return "Absolute brutality mode. Hold nothing back — violence is graphic and visceral, consequences are severe and unforgiving, the world is merciless. Intense horror, gruesome deaths, and moral depravity are on the table.";
	},
	/**
	 * Returns a difficulty directive string for the LLM.
	 * Accepted values: "casual", "hardcore", "merciless", or anything else for standard.
	 *
	 * @param {string} d - Difficulty key ("casual" | "hardcore" | "merciless" | "standard").
	 * @returns {string} A sentence describing enemy strength and DC expectations.
	 */
	_difficultyInstruction(d) {
		switch (d) {
			case "casual":    return "Difficulty is Casual. Enemies are weak and untactical. Most DCs are low (8–12). Players should rarely face real danger — keep deaths and devastating failures scarce. Prioritise fun and experimentation over challenge.";
			case "hardcore":  return "Difficulty is Hardcore. Enemies are smart, hit hard, and exploit weaknesses. DCs skew high (14–18 for moderate tasks). Mistakes carry real consequences. Players should feel genuine danger throughout.";
			case "merciless": return "Difficulty is Merciless. Enemies are relentless and unforgiving. DCs are punishing. Every blunder may be lethal. Show absolutely no mercy — the world does not care whether the players survive.";
			default:          return "Difficulty is Standard. Follow normal D&D 5e encounter balance. DCs are fair (10–15 for moderate tasks). Combat is challenging but winnable with smart play.";
		}
	},
	/**
	 * Returns a loot-frequency directive string for the LLM.
	 * Accepted values: "sparse", "generous", or anything else for fair/standard rates.
	 *
	 * @param {string} g - Generosity key ("sparse" | "generous" | "fair").
	 * @returns {string} A sentence describing how often and how much loot should appear.
	 */
	_lootInstruction(g) {
		switch (g) {
			case "sparse":   return "Loot is sparse. Treasure is rare and meaningful; finding anything magical is a genuine event. Gold drops are small. Players must make the most of limited resources.";
			case "generous": return "Loot is generous. Players should find interesting items and decent gold frequently. Magic items can appear after boss fights and in hidden caches. Reward exploration and clever play with tangible loot.";
			default:         return "Loot follows standard D&D 5e rates. Award treasure at reasonable intervals — after significant fights, in hidden caches, and as quest rewards.";
		}
	},
	/**
	 * Returns a world-setting directive string for the LLM describing the
	 * campaign's aesthetic, technology level, cultural flavour, and magic style.
	 * Supports: "dark_ages", "steampunk", "pirate", "scifi", "ancient_egypt",
	 * "ancient_rome", "warring_states_japan", "prehistory", "renaissance",
	 * or anything else for standard high fantasy.
	 *
	 * @param {string} setting - Setting key string.
	 * @returns {string} A multi-sentence world description for the LLM system prompt.
	 */
	_settingInstruction(setting) {
		switch (setting) {
			case "dark_ages":  return "Setting: Dark Ages / Low Fantasy. A harsh, historical-feeling world where magic is scarce and feared. Technology is primitive, superstition runs rampant, and the land is brutal. Avoid high-fantasy tropes like gleaming cities or benevolent kings.";
			case "steampunk":  return "Setting: Steampunk / Magitech. Clockwork machinery and arcane technology coexist. Cities hum with steam-powered devices and arcane factories. Magic is partly industrialised; gadgets and constructs are common.";
			case "pirate":     return "Setting: Pirate Age. Ocean voyages, island ports, and naval battles dominate. Treasure maps, privateers, sea monsters, and rival factions abound. Flavour locations and NPCs with nautical and colonial themes.";
			case "scifi":                return "Setting: Sci-fi Fantasy. Ancient technology left by a vanished civilisation blurs magic and science. Ruins hold laser-edged traps and arcane computers. Spaceships and swords coexist in a world that defies simple categorisation.";
			case "ancient_egypt":        return "Setting: Ancient Egypt. A mythic Nile-valley civilisation ruled by pharaoh-sorcerers and jealous animal-headed gods. Adventures centre on sand-buried tomb complexes, cursed relics, temple politics, and divine rivalries. Use Egyptian names, titles (vizier, high priestess, nomarch), and flavour (papyrus scrolls, canopic jars, scarab wards). Magic draws on hieroglyphic runes and divine patronage rather than arcane study.";
			case "ancient_rome":         return "Setting: Ancient Rome. A vast militaristic empire of legions, senators, and living gods. Adventures feature gladiatorial arenas, political conspiracy, frontier campaigns against barbarian hordes, and the meddling of Olympian deities. Use Latin-flavoured names and titles (centurion, tribune, consul). Infrastructure like roads, aqueducts, and colosseums should feature prominently. Magic manifests as augury, divine favour, and forbidden mystery cults.";
			case "warring_states_japan":  return "Setting: Sengoku-era Japan. Feudal provinces torn apart by rival daimyo clans. Samurai live and die by bushido, shinobi operate in shadow, wandering ronin sell their blades, and yokai haunt the wild places between castles. Use Japanese names, titles (shogun, daimyo, ashigaru), and cultural elements (tea ceremony, shrine offerings, honour duels). Magic is rooted in onmyodo spirit arts, kami blessings, and cursed blades.";
			case "prehistory":           return "Setting: Prehistory. A primeval world before metal, writing, or cities. Small tribal bands navigate vast wilderness filled with megafauna, rival clans, and primal spirits. Technology is limited to stone, bone, and hide. Magic is shamanic — spirit journeys, cave paintings that come alive, totemic bonds with great beasts. There are no kingdoms, shops, or coins; survival, territory, and oral tradition drive every conflict.";
			case "renaissance":          return "Setting: Renaissance Europe. Flourishing city-states ruled by ambitious merchant princes and the church. Art, science, and intrigue intertwine — Leonardo-style inventor-mages, Medici-style patron families, duelling academies, secret alchemical societies, and an ever-watchful Inquisition. Use Italian-flavoured names and titles (doge, condottiero, cardinal). Magic is practised as heretical natural philosophy, hidden behind artistic or scientific fronts to avoid persecution.";
			default:                     return "Setting: Standard high fantasy. A world of kingdoms, dungeons, ancient magic, and classic races. Elves, dwarves, and humans coexist. Classic fantasy tropes and locations are fair game.";
		}
	},
};
