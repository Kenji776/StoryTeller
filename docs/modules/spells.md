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

The level-up pick is offered in the level-up window and applied by `store.learnSpell`,
which runs the same `canLearn` validation the builder's picks go through — the name comes
from a browser, and a client may not grant itself Meteor Swarm. A refusal is reported as a
toast and **the level still stands**: losing a whole level-up over a bad pick would be a
worse outcome than a missed spell.

Choices are computed for the level the character is *about to reach*, so a tier a
level-up unlocks is pickable on that same level-up. Unlike the creation picks this is
bounded by the character's own level rather than the lobby's starting level — that bounds
creation, and a caster who levels past it must keep gaining reach.

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

What a cast spell *does* — attack rolls, saving throws, healing, and the block handed to
the narrator — is [spell-resolution.md](spell-resolution.md).

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

- **The catalogue is levels 0-2 only.** `maxSpellLevel` reaches 9; the data does not, so a
  caster above level 4 gains no new options.
- **No half-caster spells.** Paladin and Ranger are in `CASTING_ABILITY` and are treated
  as casters from level 2, but the catalogue has no entries for either, so their pool is
  empty at every level. No character in 127 is either class.
- **A caster may pick no cantrip.** The picker warns but does not forbid it — three
  levelled spells against a one-activation pool is one cast per long rest, then nothing.
- **Ritual casting, components and preparation are not modelled.** A caster knows a list
  and can cast from it; there is no prepared-versus-known distinction.

See [spell-resolution.md](spell-resolution.md) for the gaps in what a spell *does*.

_Last verified: 2026-07-28 against branch `Refactor` (5b84773)._
