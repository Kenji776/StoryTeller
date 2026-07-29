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

`validateCatalogue` runs at boot alongside every other config file, so a malformed
catalogue names itself in the log rather than throwing a bare `SyntaxError` out of the
module's import:

```
✅ spells.json (52 spells)
```

The schema lives in `spellbook.js` rather than in `server.js`'s registry, so it can be
unit tested. Its load-bearing check is that every `damage` and `healing` figure is an
expression `rollExpression()` accepts — `"8d6 fire"` is refused by name. Nothing else
would notice the difference until a spell silently dealt nothing.

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

## The picker

The character builder renders it from `GET /api/spells?class=…&level=…`, which returns
the pool, the casting ability, the reachable spell level and the number of picks.

An endpoint rather than filtering `/config/spells.json` in the browser — which is how the
builder handles weapons and armour — because a spell carries a *rule* those do not: the
level ceiling. Computing it client-side too would be a second copy of something the save
path already enforces, and the picker could then offer something the save would silently
drop.

Two wiring details that are easy to get wrong:

- `charBuilder.js` is a deferred classic script that runs **before** `app.js`, so it
  cannot read `app.js`'s `lobbyId` — that binding is still in its temporal dead zone, and
  even `typeof` throws. It reads the builder's own `#level` field instead.
- `app.js` assigns `#level` programmatically when the lobby's starting level arrives, and
  a programmatic assignment fires no `change` event. It calls `refreshSpellPicker()`
  explicitly, beside the `recalcPointBudget()` and `recalcHP()` calls that exist for the
  same reason. This is the blind spot that once left the portrait prompt describing the
  wrong character.

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

## Probes

| Probe | What it answers | Cost |
|---|---|---|
| `test-integration/spell-picker-probe.mjs` | Do a caster's picks survive the round trip, and does the server refuse what a browser should not be able to save? Drives the real socket path. | free — no model |

## Known gaps

- **Nothing resolves a spell yet.** `resolution`, `damage` and `save` are carried and
  described but not rolled: an offensive spell still reaches `autoRollIfNeeded`'s flat
  ladder, which does not consult the target's armour class. This is the next phase and
  the whole point of the data being structured.
- **`autoRollIfNeeded` still hardcodes `statKey = "int"`.** `castingAbility` exists and
  the capability model reports the right stat, but the roll path has not been moved onto
  it.
- **No level-up pick.** `canLearn` and `spellChoicesFor` are written and tested, but
  `player:levelup:confirm` does not yet offer or apply a choice.
- **The catalogue is levels 0–2 only.** `maxSpellLevel` reaches 9; the data does not, so a
  caster above level 4 gains no new options.
- **No half-caster spells.** Paladin and Ranger are in `CASTING_ABILITY` and are treated
  as casters from level 2, but the catalogue has no entries for either, so their pool is
  empty at every level.
- **A caster may pick no cantrip at all.** The picker warns, but does not forbid it — three
  levelled spells against a one-activation pool means one cast per long rest and then
  nothing. The fallback loadout is all-cantrip precisely to avoid this.
- **Concentration, ritual casting, components and spell duration are not modelled.**

_Last verified: 2026-07-28 against branch `Refactor` (31a2c6d)._
