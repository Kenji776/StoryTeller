# Spell resolution

What a cast spell actually does. `services/spellAttacks.js` — the companion to
[spells.md](spells.md), which covers what a caster knows and how they come to know it.

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
| `heal` | Rolls `healing`, plus the casting modifier where `addCastingMod` says so, minimum 1. Applied through `broadcastHPUpdates`, which clamps to `max_hp`. |
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

**Who a heal lands on** is `chooseAlly`: a named companion, then an explicit "myself",
then the most wounded living member — the mirror of `chooseTarget`'s most-wounded rule.
The dead are excluded from the fallback, since healing does not raise them and spending
the spell on a corpse reads as the engine misfiring.

**Healing needs its own guard.** `stripResolvedDamage` filters only *negative* deltas, so
a model-invented heal sailed past it and a character was healed twice for one spell.
`stripResolvedHealing` drops a positive delta for the character the server just healed,
and leaves damage in the same reply alone — a trap is a different event.

**Both resolvers' targets are protected** from the model's `enemies` block via
`serverResolved`. The spell's was missing at first, so a narration could rewrite the hit
points a spell had just taken off.

**`describeSpell`'s grammar is load-bearing** and is asserted, because a model writes
prose from it. Two defects were invisible in code and obvious on the first render:
`"casts Magic Missile at Goblin 2 strikes unerringly HITS for 10 force damage"` — the
attack phrasing and the auto phrasing both applied — and `"DC 13 dex throw"`.

## Spending the slot

The activation is spent on the gate's verdict — not on whether the spell found a target,
and not on the model reporting `spellUsed`. It is then **broadcast**, which it was not
originally: the pipeline decremented the count, persisted it and logged it to the server
console while telling no client, so `spellslots:update` had exactly one publisher — the
admin console. The number on the sheet still looked right, because the `state:update` that
follows a turn carries it, and that is what hid the gap; but the action log, where a player
reads what a turn cost them, never mentioned a spent slot. `healer-probe.mjs` caught it by
watching the stored count climb from 0 to 2 while no frame reached a client.

## Known gaps

- **A utility spell still falls to the flat ladder.** Deliberate — there is no right
  answer to compute — but the ladder grades it 15/8 with no reference to anything.
- **Area spells hit one target.** `Burning Hands` and `Thunderwave` name a cone and a
  cube; the resolver rolls one save, for the chosen target only.
- **Concentration, duration and per-turn damage are not tracked.** Witch Bolt describes
  damage each turn; nothing continues it.
- **Class-table abilities are not resolved.** A level-2+ ability from
  `classProgression.json` still goes through `autoRollIfNeeded`'s flat ladder. Its
  damage-carrying entries begin at level 3 and no character has exceeded level 3, so this
  has no reach today.

_Last verified: 2026-07-29 against branch `Refactor` (50694e6)._
