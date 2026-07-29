# Tactical combat

How a lobby uses the map: when one exists, what it will allow, what each audience is told, and
what the monsters do about it.

Phases 4 and 5 of the tactical map ([ADR 0026](../decisions/0026-tactical-combat-happens-on-a-grid.md),
[ADR 0027](../decisions/0027-enemies-are-given-intent-not-coordinates.md)). The spatial rulebook
beneath it is [tactical-geometry.md](tactical-geometry.md); the feature as a whole is
[tactical-map.md](tactical-map.md).

| module | one sentence |
|---|---|
| `session.js` | a lobby’s map: when it exists, who is on it, what it allows |
| `briefing.js` | what each audience is told about it |
| `enemyTactics.js` | who the monsters go for, and how they get there |

## The session layer

`session.js` is the single door everything behind the toggle goes through, so the turn pipeline
gets one conditional rather than a dozen. **With `tacticalCombat` off it writes no field at all** —
not a map that is generated and then ignored, which is a different thing and not a safe one.

Its two mechanical promises both refuse rather than approximate:

- `applyMove` rejects an over-long move instead of trimming it, because a clamped move puts a
  character where nobody chose. The refusal says what the move *would* have cost.
- `reachCheck` makes reach, line of sight and cover into settled facts handed to the resolver,
  and returns cover as a number an attack roll can use directly.

Two translations live here and nowhere else. Speed comes from race — 25 feet for the
traditionally shorter races, 30 otherwise — because no sheet in any stored lobby has a speed
field. And `RANGE_FEET` turns the spell catalogue's range *words* into distances, since
`spells.json` says `touch` and `ranged` rather than numbers. An unrecognised word falls back to
reach rather than to something generous: a spell whose range nobody has heard of must not quietly
become a sniper rifle.

The arena is seeded from the lobby id plus the names of the opposition, which buys two properties
without storing a counter — a reload lays out the same room, and a new encounter against different
enemies lays out a different one.

## The two briefings

`briefing.js` produces the strings each audience reads, so they are behaviour rather than
presentation and their grammar is asserted. `narratorBlock` opens with the sentence the whole
feature rests on — *these positions are settled fact, do not move anyone* — and gives each creature
a cell plus something narratable. `moveMenu` gives a player answers rather than questions, and names
the cells it offers, which is what makes an agent's reply extractable: it repeats an option instead
of inventing a coordinate. A property test checks every cell the menu offers is genuinely reachable.

### What reading them changed

Rendering the briefings caught three things no assertion had:

- **The two disagreed about the same square.** The block called Dorn "under cover" while his own
  menu said "no cover". Both read `coverBetween`, which reports `full` for *no line of sight* as
  well as for real full cover — one answer, correct for the resolver since neither yields a shot,
  and wrong for prose. Both now ask `hasLineOfSight` first and separately.
- **A pillar denying sight made cover pointless.** Eight pillars in a nine-by-seven crypt meant
  almost nothing could see anything, so ranged attacks failed outright instead of getting harder,
  and the measured crypt had nineteen full-cover cells against three of half. `sight` gained a third
  value, `obstructs`: the shot exists and costs the attacker cover. That is the cheap approximation
  of 5e tracing lines to a target's corners, and it makes cover the common case it is meant to be.
- **"Under cover" on all six lines told the narrator nothing.** Once every long shot across a
  cluttered hall crosses a pillar, having cover *is* the ordinary condition, so only the exposed get
  a phrase — and each creature carries a distance to its nearest opponent instead, which varies.

### A refusal is a fact too

`refusalBlock` exists because of a live run. The server correctly denied a swing at a creature 40
feet away — and told the narrator nothing, so it saw the intent, found no resolution block beside
it, and wrote *"the blade cleaves clean through"*. `syncTokens` then removed the creature the DM
had just killed.

Omitting a refusal is not neutral. The narrator fills the gap, and a map whose refusals are
invisible is decorative. Saying only that the attempt failed is also not enough — a model given
that much narrates a graze — so the block forbids the outcome by name. With it in place the same
turn produced *"he realizes the hobgoblin never closed all the way in; he's still hanging back
near the far wall, a good forty feet distant"*, and the creature survived.

## Enemy tactics

`enemyTactics.js` is the phase that makes the rest worth having. Until it landed, the map
constrained players and not monsters: standing in cover earned armour class against a shot, but
nothing decided to shoot the exposed character instead. Positioning was enforced and never rewarded.

Two changes, both about who the enemies pick:

- **Targets go to the nearest reachable character**, replacing `enemyTurns.js`'s round-robin. Step
  between the ghoul and the cleric and the ghoul comes for *you*, because you are nearer — guarding
  as a consequence of geometry rather than a rule written for it.
- **An enemy out of reach does not attack.** It closes instead. Before this a creature forty feet
  away hit you anyway, so distance cost the monsters nothing.

The injection is a single `tactics` object handed to `resolveEnemyAttacks`. Omitting it *is* what
"off" means at that layer, so the round-robin path is byte-for-byte what it was for a lobby that
never opted in — `enemyTurns.js` still knows nothing about maps.

`beforeStrike` moves a creature **inside** the round rather than before it, because enemy actions are
shared out across the players' turns; moving everybody up front would have each enemy travel once per
player turn and strike once per round.

### Two things the tests caught

- **Movement needs a strict improvement to happen at all.** Distance is Chebyshev, so a whole column
  can be equally close to a target, and "get nearer" then picked whichever label sorted first — a
  ghoul stepped K3 → K1 without closing an inch. On a rendered map that reads as the monster being
  broken. Staying put is now the baseline and a move has to beat it.
- **Ties are broken by name**, so a creature between two equidistant characters does not oscillate
  between them on consecutive rounds.

Written implementation-first, against `TDD-1`; declared in the test file, with each behaviour
confirmed to fail against a stubbed function in place of an observed RED.

_Last verified: 2026-07-29 against branch `feature/tactical-map` — phases 4 and 5 wired into the
turn pipeline, 90 tests plus `tactical-probe.mjs` and `battle-sim.mjs`._
