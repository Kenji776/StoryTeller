# Character capability — what the data model does NOT have

_Survey of the existing codebase, 2026-07-27._

## abilities (20 facts)

WHAT DOES NOT EXIST TODAY (verified by reading, not inferred):

1. No machine-readable resource cost. `details.cost` exists on 29/288 abilities as English prose ("3 ki points", "One Wild Shape use", "Sorcery points equal to spell level"), and the resources it names — ki, sorcery points, Wild Shape uses, rage — have NO corresponding runtime fields on the player object (full default set is at server/services/lobby/lobbyPlayers.js:16-29). The single resource the engine tracks is `spellSlotsUsed`, a flat pool of size = character level, shared by every spell and ability alike, with no notion of slot level or per-ability cost.

2. No per-ability usage tracking. `details.uses` (83/288, mixed number|string) and `details.recharge` (96/288, 12 distinct strings) are display/prompt text only. Grep for usesRemaining|abilityUses|usesLeft|cooldown across server/ and client/ returns zero hits. Nothing decrements a per-ability counter and nothing resets one on short rest (only the shared slot pool resets, and only on LONG rest — lobbySettings.js:139; short rest restores HP only).

3. No usable/unusable determination anywhere. Both the UI gate (client/uiComponents.js:250-284) and the DM prompt (lobbyPrompts.js:375) reduce "can I do this" to `slotsLeft > 0` plus "is the name in the known list". Nothing consults HP<=0, `dead`, conditions, action economy (`details.usage`), range, or the environment. There is no server-side "is this action possible" call site at all — the closest thing is prose instructing the LLM to police itself (lobbyPrompts.js:329) and the LLM's own self-reported `spellUsed` boolean, which is what actually drives the ledger (server.js:852).

4. Two disjoint sources of truth for what a character knows. Level-1 abilities live in a hardcoded client-side table (client/charBuilder.js:117-360) the server helper cannot see; levels 2-25 live in client/config/classProgression.json read server-side. They use overlapping-but-different `details` vocabularies (the builder adds healing/bonus/bonusDamage/attacks/bolts/limitation/condition; the config adds pool/options/learned/area). `details` has no schema and the startup validator (server.js:1255) checks only that the first ability of the first class has name+description.

5. No provenance or identity on an ability. No id, no source class, no "granted at level" that can be trusted (0 of 21 abilities in 18 real persisted lobbies carried a `level` field). Dedupe and all lookups are by exact case-sensitive `name` string match.

6. A declared-but-unimplemented contract. `updates.abilities` with change_type add/remove is advertised to the LLM (lobbyPrompts.js:204, parseDMJson.js:10) and silently dropped — neither dispatch site (server.js:835-864, turnTimer.js:335-363) reads it, and no broadcastAbilityUpdates exists. Any DM-granted ability is lost. That schema also says `attributes` where all real data says `details`.

7. No validated class. `player.class` is never checked against the 12 classProgression keys; the default is "Adventurer" (lobbyPlayers.js:18), which has no progression entry, so getAbilityForLevel returns null forever without any warning.

8. Player-authored abilities cannot persist. The add-ability modal mutates a display-only copy (uiComponents.js:196 + :286-291) and buildCurrentSheet regenerates the array from defaultBuilds on every save (charBuilder.js:423-428).

9. Unvalidated import boundary. /api/character/import (server.js:1188-1203) checks the RSA signature only; the sheet's abilities/inventory arrays are parsed and handed straight to upsertPlayer. That is the live route by which bare-string abilities (already defensively handled at lobbyPrompts.js:92 and app.js:443, though absent from all current saved data) can re-enter, and the two display paths disagree on how to render them.

10. Level-up is client-driven and single-step. increaseLevel (+1 per call) plus one ability per confirm event; a multi-threshold XP award requires successive client round trips (server.js:609-634), and a client that never confirms leaves the character permanently under-levelled and missing abilities. So `player.abilities` cannot be assumed to equal "everything this class should have by level N" — the only place that invariant is enforced is the start-level backfill loop (lobbyPlayers.js:322-338), which is skipped entirely when startingLevel <= 1.

---

## resources (17 facts)

WHAT DOES NOT EXIST TODAY (a capability model would have to invent all of it):

1. NO STAMINA. Asked directly by the operator, so stated bluntly: there is no stamina, fatigue, exhaustion-level, or encumbrance model anywhere in the codebase. The word appears only in flavor text and as one entry in a 16-item free-text condition vocabulary that has zero mechanical effect. The Barbarian ability that declares `"cost": "1 exhaustion level on rage end"` (client/config/classProgression.json:1573) is inert data no code reads.

2. NO PER-ABILITY RESOURCE. Every ability in the game — martial, magical, level-1, level-20 — draws from one flat counter whose maximum equals character level. The per-ability `details.uses` / `details.recharge` / `details.cost` fields that exist in the class config are read by nothing (grep confirms zero call sites). A level-1 Fighter has exactly one ability activation before the DM is told to reject everything.

3. NO MACHINE-READABLE CAPABILITY SURFACE. There is no function anywhere that answers "what can this character do right now". The only aggregation is `lobbyPrompts.js:352-376`, which produces an English string for the LLM and deliberately omits inventory, conditions, and gold. Both new features would need this from scratch; today five separate files each recompute `max(0, level - spellSlotsUsed)` inline.

4. NO ENFORCEMENT, ONLY PROSE. Nothing in the server rejects an action. Slot legality, ability ownership, and item possession are enforced only by system-prompt paragraphs (lobbyPrompts.js:326-330, 375). Resource consumption is retroactive and LLM-self-reported via `spellUsed: true` — and that field is honored on exactly one of three code paths that process DM responses (server.js:852; the turn-timer path at turnTimer.js:336 and the rest path at turnTimer.js:451 ignore it entirely).

5. NO CONDITION SEMANTICS. Conditions are bare lowercase strings with no duration, source, stack count, or severity, and they are matched by exact case-sensitive string equality on both add and remove (lobbyProgression.js:194,197). A casing mismatch between the add and remove call makes a condition permanent. They also expire only on long rest. Zero non-empty condition arrays exist in 35 persisted player records, so this path is essentially untested in production.

6. NO ITEM TAXONOMY. Nothing distinguishes a consumable from a quest item from a container. `attributes` is a free-form bag whose keys are inconsistently cased (`damage_type` vs `damageType`, `type` vs `armor_type`) and normalized only at equip time. A Healing Potion is identified as consumable only by its `description` prose and an optional `attributes.healing` string. Item lookup is case-insensitive but has no plural/fuzzy handling, so "Healing Potions" creates a duplicate item rather than matching "Healing Potion".

7. NO ENVIRONMENT MODEL IN THIS AREA. Nothing in the progression/players/settings/conditions paths carries location, terrain, lighting, or proximity. Map/terrain data flows straight from the LLM to `updateMap` (server.js:865) and is never joined to character state.

8. RELIABILITY LANDMINES the model must defend against: `applyHPChange` has no upper clamp so healing can exceed max_hp permanently (lobbyProgression.js:117); `max_hp` has four different fallback values across four consumers (1, 1, 10, 10); `conditions` arrives as an array on `conditions:update` but as a comma-joined string with 'None'/'Dead' sentinels on `party:update` and `state:update`; `dead` is absent rather than false on living characters; three separate notions of aliveness (`dead`, `status`, `hp<=0`) disagree; and `level` — which solely determines max spell slots — is incremented on a client-emitted socket event with no server-side XP verification (server.js:609-617).

---

## inventory-gear (22 facts)

A shared "what can this character do right now" model does not exist today, and the inventory/equipment half of it is missing the following. Everything below is a verified absence, not a guess.

1. NO SERVER-SIDE ITEM CLASSIFIER. `item_type` is written by the server (lobbyProgression.js:361,366,369,416,421,424) and read by nobody on the server — grep confirms zero server reads. The only classifier, `_detectEquipSlot`, lives in the browser at client/uiComponents.js:82-108 and is unreachable from Node (plain script, not a module, no export). Both new features need this logic server-side; it must be extracted, and extracted carefully because it is currently wrong (see 2).

2. THE CLASSIFIER IS WRONG ON THE DEFAULT LOADOUT. 108 of 134 real persisted items have no `item_type`, so classification falls through to name-substring keywords (uiComponents.js:97-99). Verified misclassifications on stock starting gear: "Wand"/"Staff" → weapon, "Shield" → ARMOR SLOT (a Fighter equipping their Shield displaces Chain Mail and lands at AC 10), "Robes" → unequippable. The `type === "consumable" → null` guard at :105 is dead code — it sits after the keyword pass, so any consumable whose name contains a keyword ("Potion of the Blade" → "blade") is classified as a weapon first.

3. NO WAY TO ANSWER "IS THIS USABLE, AND HOW MANY USES LEFT". There are no `charges`, no `uses`, no durability, no cooldown fields anywhere (grep for `charges` hits only prose inside classProgression.json:2747). There is no `item:use` event — only `item:equip`/`item:unequip` at server/server.js:551,576. Consumption happens only if the LLM emits a negative `change`. The stock Healing Potion carries `{healing:"2d4+2"}` and no item_type, so it is neither classifiable as a consumable nor invocable as an action.

4. NO CATALOG ON THE SERVER. weapons.json and armor.json are browser-only assets (fetched at charBuilder.js:39,64); server.js:1250-1251 merely sanity-checks that the files parse. equipItem therefore cannot look up real stats and falls back to `"1d4"` / `"bludgeoning"` / `ac 10` (lobbyProgression.js:311-312, :321). Confirmed damage in gt346s.json: Leather Armor persisted at AC 10 instead of 11. An advisor reading `p.armor.ac` today reads a fabricated number.

5. INVENTORY IS INVISIBLE TO THE DM IN ANY USABLE FORM. lobbyPrompts.js:91 flattens inventory to `name×count`, stripping attributes and descriptions; the authoritative per-turn status block (:352-368) includes HP, level, slots, abilities and equipped gear but omits inventory entirely. Nothing currently tells the model that a player is carrying a Brass Key or an Evidence Scroll in a form it can act on.

6. NO ITEM IDENTITY. The display name is the primary key, matched case-insensitively with no trim and no normalization (lobbyProgression.js:242, :294-296, :350, :406). "Healing Potion " and "Healing Potion" are two different items. Player names get `.trim()` (lobbyPlayers.js:238); item names do not. There is no id, no slug, no catalog reference.

7. NO VALIDATION BOUNDARY. upsertPlayer (lobbyPlayers.js:115-180) writes the client's `inventory` verbatim with no array check and no entry normalization. `change_type` is documented to the LLM (lobbyPrompts.js:201) and read by no one. `attributes` is a free-form bag — the LLM has already invented `item_type:"currency"` (w5nfb0.json) and tagged "Gold Coins" as a consumable (kgbh24.json). Any gate that trusts these fields is trusting unvalidated model output.

8. STATE INVARIANTS ARE ALREADY BROKEN IN LIVE DATA. Equipped items can simultaneously exist in inventory (gt346s.json: weapon Dagger + Dagger inventory entry), because character creation picks equipment from the JSON dropdowns (charBuilder.js:441-453) independently of the class default inventory (:425). Import silently drops inventory and equipped gear (eventHandlers.js:696-782). `defaults.inventory`/`conditions`/`abilities` in lobbyPlayers.js:16-29 are shared module-level array references that in-place mutation could leak across all players in the process.

9. NORMALIZATION IS DUPLICATED, NOT CENTRALIZED. The identical normalize loop exists at lobbyProgression.js:227-239 and client/sockets.js:671-679; a third partial version at lobbyProgression.js:299-301. equipItem/unequipItem normalize only the matched index, so a legacy string elsewhere in the array survives and can produce a duplicate entry via the `typeof existing === "object"` fallthrough at :352/:408. There is no single function that returns a clean, typed inventory.

What DOES exist and can be built on: publicState (lobbyStore.js:156-216) already ships the full raw player map — inventory objects with attributes, equipped weapon/armor/trinket, hp, level, spellSlotsUsed, conditions, abilities — to every client, so both features can read a complete snapshot without new plumbing. The per-turn "PLAYER STATUS & SPELL SLOTS (authoritative)" block at lobbyPrompts.js:352-375 is the existing precedent for an authoritative capability payload; it is the natural place to attach an inventory/equipment section.

---

## environment-context (18 facts)

A capability model needs an accurate answer to "where am I, who is near me, and what is happening right now". Here is what does not exist today.

1. NO MACHINE-READABLE ENVIRONMENT. The only true record of terrain/location/time-of-day is the free-prose `SETTING:` paragraph inside `lobby.storyContext`, produced by an LLM to a format prescribed at server/services/lobby/lobbyHistory.js:236-261 and never parsed or validated by any code. The structured field that ought to hold it — `lobby.terrain` — is permanently `{"type":"plains","features":[]}` in all 18 persisted lobbies because the DM schema stopped asking for it (server/services/lobby/lobbyPrompts.js:189-192, "MAP DISABLED — … to save tokens") while the write path at server/server.js:865 still passes `dmObj.terrain || null` and mapService.js:38-40 falls back to the old value. Any consumer that reads `lobby.terrain` will be confidently wrong. There is no notion of indoors/outdoors, light level, time of day, cover, hazards, or reachable exits anywhere in server state.

2. NO SPATIAL MODEL. `lobby.characters` positions are frozen at the spawn grid written once at server/server.js:733-741; `mergeChars` (mapService.js:77-84) never removes an entity and no later call ever supplies new coordinates. Enemies live in a completely separate namespace (`lobby.enemies`, keyed by name, no x/y at all) with zero linkage to `lobby.characters`. So there is no way to answer "is that goblin in melee range", "can I reach the door", or "who is adjacent to me". `lobby.mapHistory` is 20 identical snapshots.

3. NO COMBAT/EXPLORATION MODE FLAG. `combat_over` is required from the DM every turn (lobbyPrompts.js:212, 308-312) and immediately discarded — read once at server/server.js:850 and server/routes/turnTimer.js:348,458 to trigger a purge, never persisted. `s.phase` only distinguishes waiting/running/paused/completed/wiped. The only proxy is "some enemy has status active", which is wrong for surrendered enemies (a case the prompt explicitly contemplates) and stale between the last kill and the DM's declaration.

4. PLAYER CONDITIONS NEVER REACH THE MODEL. `player.conditions` is stored (server/services/lobby/lobbyPlayers.js:168-169) and shown to clients (lobbyStore.js:168) but appears in NO prompt. Meanwhile ~1,600 chars of composeMessages (lobbyPrompts.js:274-292) instruct the DM to reject actions on the basis of conditions it is never shown. A feasibility gate that wants to reject "I run" while restrained must read `player.conditions` directly — nothing upstream will hand it over.

5. NO TURN/ROUND CONTEXT IN ANY PROMPT. `s.initiative`, `s.turnIndex`, `s.round` exist and are enforced server-side in validateAction (lobbyCombat.js:165-168) but are absent from composeMessages and composeDMChat. An advisor cannot currently be told whether it is even the asker's turn.

6. TWO DIVERGENT CHARACTER SERIALIZERS, NEITHER COMPLETE. `playersSummary` (lobbyPrompts.js:83-101) has stats/inventory/XP/equipment/abilities but is used only by the setup and summary prompts; `spellLines` inside composeMessages (:352-368) has HP/equipment/abilities/slots but no inventory, no stats, no conditions. composeDMChat (:419-423) has neither — just name/class/level/HP/dead. There is no single function that answers "what can this character do right now", and the shared-source-of-truth both new features need does not exist in any form today. Whichever one is built must handle the confirmed degenerate runtime shapes that playersSummary already defends against: inventory entries that are bare strings rather than `{name,count}` objects (:91), and abilities that are bare strings rather than `{name,...}` objects (:92).

7. STORYCONTEXT IS NOT SAFE TO CONSUME BLIND. It has four observed runtime forms: the structured summary, a raw DM JSON blob (`{"text":"<p>…","updates":{}…}`, 0byfmn.json / qr676e.json — written by lobbyHistory.js:61 from the raw replyText at server.js:887), the createLobby default `"—"`, and the literal `"[Error: LLM unavailable or failed to respond]"` (lxzga6.json). `_hasSummary` is the discriminator but is undefined in 12 of 18 lobbies and is checked only by composeWipeEpilogue (:493). composeMessages' guard (:167) tests for setup-prompt text no current write path produces, and composeDMChat (:412) has no guard at all. It is also asynchronously stale: autoSummarize is fire-and-forget with a swallowed catch (server.js:916, turnTimer.js:385) and a `_summarizing` re-entrancy skip (lobbyHistory.js:159-163).

8. TIER-2 HISTORY IS DEAD IN PRACTICE. `ancientHistory` is empty in every lobby; promotion needs storyContext > MAX_SUMMARY_LENGTH = 60,000 chars (server/server.js:90) while the summarizer prompt caps it at ~800 words. Treat it as always absent.

9. TOKEN RISK IF THE ADVISOR/GATE REUSES composeMessages' CONTEXT. Static system text alone is ~15k chars (~3.7k tokens), of which the 7,469-char updates/conditions mega-block and the 1,560-char JSON schema are pure DM-output-format instruction that neither a gate nor an advisor needs. On top of that the verbatim history tail measured 9,324-23,152 chars (2.3k-5.8k tokens) and is only bounded by keep=10 while summarization keeps succeeding — 0byfmn.json shows summarizedUpTo stuck at 0 with 13 entries, i.e. the whole log. Full histories reach 59,834 chars. A per-turn feasibility gate that reuses this would roughly double DM-turn cost and latency; composeDMChat's ~2k-token envelope is the realistic budget to model against, and even that is missing everything in items 1-6.

10. NO CHARACTER-CAPABILITY DATA BEYOND NAMES. Abilities are stored as names (plus an optional description/attributes object the DM invented); nothing records an ability's cost, range, targets, or prerequisites. `spellSlotsUsed` is a single counter compared against `Number(p.level)` (lobbyPrompts.js:353-355, enforced server-side at server/server.js:855-857) — there is no per-level slot table, no cantrip/at-will distinction, and no per-ability usage tracking. A gate can therefore verify "does this player know an ability by this name and have >0 slots" and nothing more.