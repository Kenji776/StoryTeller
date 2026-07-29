# Spells

What a caster knows, how they come to know it, and what casting costs.

## The defect this replaces

A level-1 caster could not cast a named spell. `classProgression.json` begins at level 2,
so their `abilities` array was empty and `hardChecks` took "I cast magic missile" as an
ability they did not know — **costing a strike**, and three end a turn. Only the vague
"I cast a spell" got through, and that fell to a flat 15/8 ladder rolling `int` for every
class. 102 of the 115 characters in stored lobbies are level 1 and 38 are casters.

The full argument, and the alternatives rejected, are in
[ADR 0021](../decisions/0021-a-caster-knows-a-chosen-spell-list.md).

## Where the mechanics live

`client/config/spells.json`, as **structured fields** — never prose.

```json
{ "name": "Fire Bolt", "level": 0, "classes": ["Wizard", "Sorcerer"],
  "resolution": "attack", "damage": "1d10", "damageType": "fire", "range": "ranged" }
```

Prose was rejected because the class table shows where it leads: its own `details.damage`
carries `"20d10 force on hit; 10d10 in 20-ft radius (DEX save half)"`, and two entries
deal damage on a **successful** save, so a reader that guessed would invert them.

Under `client/config/` rather than `server/config/` because players must see their own
spell list — `loot-tables.json` is the opposite case.

`validateCatalogue` runs at boot beside every other config file (`✅ spells.json (52
spells)`), so a malformed catalogue names itself instead of throwing a bare `SyntaxError`
out of the module's import. The schema lives in `spellbook.js`, not `server.js`'s
registry, so it is unit testable. Its load-bearing check: every `damage` and `healing`
figure must be an expression `rollExpression()` accepts. `"8d6 fire"` is refused by name,
and nothing else would notice until a spell silently dealt nothing.

## Which stat a caster casts with

`services/spellbook.js`, and nowhere else.

| Ability | Classes |
|---|---|
| `int` | Wizard |
| `wis` | Cleric, Druid, Ranger |
| `cha` | Sorcerer, Warlock, Bard, Paladin |

A class absent from that map does not cast, and `castingAbility` returns `null` rather
than a default — reporting one for a Fighter would be the fiction `characterCapability`
refuses to invent elsewhere. Paladins and Rangers are casters from level 2, so they are
in the map but get an empty pool at level 1.

## Knowing a spell is a choice

A caster knows a **chosen** list, not their whole class list.

| When | What |
|---|---|
| Character creation | pick `STARTING_SPELL_PICKS` (3) from anything available to the class |
| Each level | one more pick, from that spell level **or lower** |

Spell level is half character level rounded up, capped at 9 — so a level-1 caster reaches
level-1 spells, and a level-3 caster reaches level-2 spells.

**The ceiling is the lobby's `startingLevel`, which the game master sets.** A campaign
begun at level 5 opens level-3 spells to every caster in it. `upsertPlayer` is the
boundary that enforces this: picks arrive from a browser, and a client may not raise its
own ceiling. Anything off the class list, above the ceiling, or simply invented is
dropped; submitting *more* than the allowance is refused outright, leaving the character's
previous list intact rather than replacing it with a truncation nobody chose.

Picks are stored as **names**. Persisting whole spell objects would freeze a copy of each
one's damage into every lobby file, and a catalogue correction would then never reach the
characters who had already picked it.

An omitted `spells` field is not a decision — a mid-game re-save for a name change must
not disarm a caster, the same guard `abilities` and `max_hp` already have.

`knownSpells(player)` resolves `player.spells` against the catalogue rather than trusting
it — records are written by the DM and reloaded from disk, so an entry naming a spell that
does not exist, or one the character's class cannot cast, is dropped. The distinction that
matters:

- `spells` **missing** → the fallback loadout. The 38 casters already in stored lobbies
  have no such field and must not be left mute by this landing.
- `spells: []` → a decision, and respected. The character knows nothing.

The fallback is the first three in catalogue order, which is all cantrips: at-will, so the
character can always act, and it never quietly spends the levelled picks that are the
player's to make.

## What casting costs

Cantrips are free. A levelled spell spends one activation from the shared pool that
`characterCapability.remainingSlots` already owns — the same pool martial abilities use.

Charging a cantrip against it would give a level-1 caster, whose pool is one, a single
Fire Bolt per long rest. `costsSlot` therefore treats **only** an explicit level 0 as
free: an unreadable entry costs a slot, because the other default would turn every
malformed spell into an at-will one.

## The picker

The character builder renders it from `GET /api/spells?class=…&level=…`, which returns
the pool, the casting ability, the reachable spell level and the number of picks.

An endpoint rather than filtering `/config/spells.json` in the browser — how the builder
handles weapons and armour — because a spell carries a *rule* those do not: the level
ceiling. A client-side copy could offer what the save then silently drops.

Two wiring traps:

- `charBuilder.js` is deferred **before** `app.js`, so it cannot read `app.js`'s
  `lobbyId` — that binding is in its temporal dead zone and even `typeof` throws. It reads
  its own `#level` field.
- `app.js` assigns `#level` programmatically, which fires no `change` event, so it calls
  `refreshSpellPicker()` explicitly beside `recalcPointBudget()` and `recalcHP()`. Same
  blind spot that once left the portrait prompt describing the wrong character.

## Resolution

`services/spellAttacks.js`, mirroring `playerAttacks.js` down to the injected dice so a
weapon swing and a spell can be read against each other.

Everything mechanical happens **before** the model is called, for the reason
[combat.md](combat.md) gives.

| `resolution` | How it resolves |
|---|---|
| `attack` | `d20 + proficiency + casting modifier` against the target's real `ac`. Natural 20 doubles the dice; natural 1 always misses. |
| `save` | The **target** rolls `d20 + a challenge-rating bonus` against the caster's DC. `onSave: "half"` takes half, rounded down; `"none"` takes nothing. |
| `auto` | Lands — Magic Missile has no roll to make. |
| `heal` | Rolls `healing`, plus the casting modifier where `addCastingMod` says so, minimum 1. |
| `utility` | Returns null — no right answer to compute, so the narrator owns it. |

**Save DC is `8 + proficiency + casting modifier`**, null for a non-caster.

A spell attack adds **no ability modifier to damage** — a cantrip deals its dice alone;
adding it would scale a caster's damage twice with one stat.

A save is the *target's* roll, so a natural 20 there is their win, not a critical hit, and
`critical` stays false. The `dice:result` frame inverts it too. The creature's save bonus
comes from its challenge rating through the same `crValue` `enemyTurns.js` uses —
exported rather than reimplemented, because a second parser of one field drifts silently.
Coarse on purpose: the model rarely gives its creatures the six ability scores a real
saving throw needs.

**Which spell was cast** comes from `gate.verdict.usesSpell`: `hardChecks` already had to
identify it to allow the action, so matching the name again in the handler would be a
second implementation of one question.

**The activation is spent on the gate's verdict**, not on whether the spell found a
target and not on the model reporting `spellUsed` — that flag now only covers class-table
abilities. Keying it on *resolution* instead let a cantrip cast with nobody to aim at fall
through to the narrator's flag, which knows nothing about spell levels and charged for it.

**A recognised spell outranks the attack regex.** `isAttackAction` matches "I cast fire
bolt" — "fire" + "bolt" reads as firing a crossbow bolt — so a wizard casting Fire Bolt
also took a quarterstaff swing, two damage rolls on one turn. Text alone cannot separate
those, and Flame Strike would collide with `strikes?` the same way; the gate having
matched a spell the character actually knows is stronger evidence.

**Both resolvers' targets are protected** from the model's `enemies` block via
`serverResolved`. The spell's was missing at first, so a narration could rewrite the hit
points a spell had just taken off.

**`describeSpell`'s grammar is load-bearing** and is asserted, because a model writes
prose from it. Two defects were invisible in code and obvious on the first render:
`"casts Magic Missile at Goblin 2 strikes unerringly HITS for 10 force damage"` — the
attack phrasing and the auto phrasing both applied — and `"DC 13 dex throw"`.

## The gate

`hardChecks` checks abilities first, then spells, so nothing that already worked changed.
A named spell the character knows returns `{ usesSpell, spendsSlot }`.

It did not become permissive: a spell off the character's list is still rejected with a
strike. What changed is that the gate has something to say yes to. The refusal lists
spells alongside abilities, because a level-1 caster holding a full list was being told
"You know: none yet."

Matching is on word boundaries over `normaliseForMatch` (`helpers/utils.js`), shared with
ability matching for the reason `armourClass.js` exists. "I delight in the chaos" must not
cast Light, and a bare "Touch" must not beat "Chill Touch".

## Probes

| Probe | What it answers | Cost |
|---|---|---|
| `test-integration/spell-picker-probe.mjs` | Do a caster's picks survive the round trip, and does the server refuse what a browser should not be able to save? | free — no model |
| `test-integration/caster-party-probe.mjs` | Do three casters of different classes actually get to cast, on their own stats, against real armour classes and save DCs, with cantrips free? Every defect listed under Resolution was found by this. | one DM call per turn |

## Known gaps

- **Healing is rolled but not applied.** `resolveSpell` returns `healed`, and the action
  handler does not yet route it through `broadcastHPUpdates` or choose an ally to receive
  it, so Cure Wounds still relies on the narrator.
- **A utility spell still falls to the flat ladder.** That is deliberate — there is no
  right answer to compute — but the ladder grades it 15/8 with no reference to anything.
- **Area spells hit one target.** `Burning Hands` and `Thunderwave` name a cone and a
  cube; the resolver rolls one save for the chosen target only.
- **Concentration, duration and per-turn damage are not tracked.** Witch Bolt describes
  damage each turn; nothing continues it.
- **No level-up pick.** `canLearn` and `spellChoicesFor` are written and tested, but
  `player:levelup:confirm` does not yet offer or apply a choice.
- **The catalogue is levels 0–2 only.** `maxSpellLevel` reaches 9; the data does not, so a
  caster above level 4 gains no new options.
- **No half-caster spells.** Paladin and Ranger are in `CASTING_ABILITY` and are treated
  as casters from level 2, but the catalogue has no entries for either, so their pool is
  empty at every level.
- **A caster may pick no cantrip.** The picker warns but does not forbid it — three
  levelled spells against a one-activation pool is one cast per long rest, then nothing.
- **Concentration, ritual casting, components and spell duration are not modelled.**

_Last verified: 2026-07-28 against branch `Refactor` (31a2c6d)._
