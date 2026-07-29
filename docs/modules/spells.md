# Spells

What a caster knows, how they come to know it, and what casting costs.

## The defect this replaces

A level-1 caster could not cast a named spell.

`classProgression.json` has no level-1 entry for **any** class — the table begins at
level 2 — and there was no spell list anywhere in the project. So a level-1 caster's
`abilities` array was empty, and `hardChecks` took "I cast magic missile" as an ability
they did not know:

```
false unknown_ability    strike=true   "I cast magic missile at the goblin"
      → Your character does not know that. You know: none yet.
true  —                  strike=false  "I cast a spell at the goblin"
```

The rejection **cost a strike**, and three end the turn. Only the vague form got through,
and it fell to `autoRollIfNeeded`'s flat 15/8 ladder rolling `int` for every class. The
game was teaching casters not to name their spell.

Measured against the 61 stored lobbies: 102 of 115 characters are level 1, none above 3,
and 38 of them are casters.

## Where the mechanics live

`client/config/spells.json`, as **structured fields** — never prose.

```json
{ "name": "Fire Bolt", "level": 0, "classes": ["Wizard", "Sorcerer"],
  "resolution": "attack", "damage": "1d10", "damageType": "fire", "range": "ranged" }
```

The class table shows why prose was rejected. Its own `details.damage` includes
`"20d10 force on hit; 10d10 in 20-ft radius (DEX save half)"`, and two entries
(`Quivering Palm`, `Void Palm`) deal damage on a **successful** save — a reader that
guessed would get them backwards. `damage` here is a bare expression `rollExpression()`
accepts, and nothing else.

It sits under `client/config/` rather than `server/config/` because players must see
their own spell list; `loot-tables.json` is the opposite case and is deliberately
server-side.

| `resolution` | Meaning |
|---|---|
| `attack` | A spell attack roll against the target's armour class. |
| `save` | The target rolls a saving throw against the caster's spell save DC. |
| `auto` | No roll — it simply hits (Magic Missile). |
| `heal` | Restores hit points to an ally. |
| `utility` | No mechanical outcome the server can compute; the narrator owns it. |

## Which stat a caster casts with

`services/spellbook.js`, and nowhere else.

| Ability | Classes |
|---|---|
| `int` | Wizard |
| `wis` | Cleric, Druid, Ranger |
| `cha` | Sorcerer, Warlock, Bard, Paladin |

A class absent from that map does not cast at all, and `castingAbility` returns `null`
rather than a default — a Fighter has no casting stat, and reporting one would be the
fiction `characterCapability` refuses to invent elsewhere. It is also exactly what was
hardcoded: `statKey = "int"`, for every caster, so a Cleric with WIS 18 and INT 8 cast at
their worst stat.

Paladins and Rangers are casters from level 2, so they are in the map but get an empty
pool at level 1.

## Knowing a spell is a choice

A caster knows a **chosen** list, not their whole class list.

| When | What |
|---|---|
| Character creation | pick `STARTING_SPELL_PICKS` (3) from anything available to the class |
| Each level | one more pick, from that spell level **or lower** |

Spell level is half character level rounded up, capped at 9 — so a level-1 caster reaches
level-1 spells, and a level-3 caster reaches level-2 spells.

`knownSpells(player)` resolves `player.spells` against the catalogue rather than trusting
it. Player records are written by the DM and reloaded from disk, so an entry naming a
spell that does not exist, or one belonging to a class the character no longer is, is
**dropped rather than honoured**. The distinction that matters:

- `spells` **missing** → the fallback loadout. The 38 casters already in stored lobbies
  have no such field and must not be left mute by this landing.
- `spells: []` → a decision, and respected. The character knows nothing.

The fallback is the first three available in catalogue order, which is all cantrips: they
are at-will, so the character can always act, and it never quietly spends the levelled
picks that are the player's to make.

## What casting costs

Cantrips are free. A levelled spell spends one activation from the shared pool that
`characterCapability.remainingSlots` already owns — the same pool martial abilities use.

Charging a cantrip against it would give a level-1 caster, whose pool is one, a single
Fire Bolt per long rest. `costsSlot` therefore treats **only** an explicit level 0 as
free: an unreadable entry costs a slot, because the other default would turn every
malformed spell into an at-will one.

## The gate

`hardChecks` checks abilities first, then spells, so nothing that already worked changed.
A named spell the character knows returns `{ usesSpell, spendsSlot }`.

It did not become permissive. A spell off the character's list is still rejected with a
strike — what changed is that the gate now has something to say yes to. The refusal also
lists spells alongside abilities, because a level-1 caster holding a full list was being
told "You know: none yet."

Matching is on word boundaries over the normalised text, via `helpers/utils.js`'s
`normaliseForMatch`, shared with ability matching for the reason `armourClass.js` exists —
the same rule written twice drifts silently. "I delight in the chaos" must not cast Light,
and a bare "Touch" must not beat "Chill Touch".

## Known gaps

- **Nothing resolves a spell yet.** `resolution`, `damage` and `save` are carried and
  described but not rolled: an offensive spell still reaches `autoRollIfNeeded`'s flat
  ladder, which does not consult the target's armour class. This is the next phase and
  the whole point of the data being structured.
- **`autoRollIfNeeded` still hardcodes `statKey = "int"`.** `castingAbility` exists and
  the capability model reports the right stat, but the roll path has not been moved onto
  it.
- **No picker.** Creation picks and the level-up pick are validated
  (`validateStartingSpells`, `canLearn`) but no UI offers them, so every caster currently
  gets the fallback loadout.
- **The catalogue is levels 0–1 only.** `maxSpellLevel` reaches 9; the data does not.
- **Concentration, ritual casting, components and spell duration are not modelled.**

_Last verified: 2026-07-28 against branch `Refactor` (6a2adfb)._
