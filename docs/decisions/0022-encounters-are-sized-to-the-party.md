# 0022 — Encounters are sized to the party, and enemy count is not a difficulty knob

Status: accepted
Supersedes: [0020](0020-combat-balance-measured-not-guessed.md)

## Context

[ADR 0020](0020-combat-balance-measured-not-guessed.md) left two things open. Solo play
was "much harder than party play … not compensated for today", and Hardcore and
Merciless landed easier than the 50%/25% they were aimed at, with the remedy named as
"tougher *encounters*, which is the DM's job and `encounterPacing`'s".

Both mattered more than they looked. Of 54 stored games that were actually played, **21
are solo** and **15 are Merciless**; 48 involve combat.

Re-measuring `balance-sim.mjs` produced the numbers 0020 recorded, and then a sweep of
party size against enemy count — 2000 fights per cell, three archetypes — showed that
neither conclusion survived contact with the grid.

**The solo penalty was an artifact of the scenario table, not of the engine.** The sim's
only solo row fielded two goblins against one character while every party row sat at
roughly one enemy per character. Held at the *same* enemies-per-character, solo and
party track each other closely, and on the harder archetypes solo is ahead:

| Hardcore, 1 enemy per character | solo | party of 2 | of 3 | of 4 |
|---|---|---|---|---|
| CR ¼ goblins, AC 15 | 84% | 88% | 93% | 94% |
| CR ½ hobgoblins, AC 18 | 47% | 41% | 41% | 33% |
| CR 1 orcs, AC 13 | 65% | 67% | 75% | 68% |

The action economy is not the culprit — a lone character facing the whole roster on
their turn is correct, and it costs them less per head than a party takes. Neither is
the one-blow cap, which binds on 16–17% of landed blows at level 1 on Merciless and on
none at all at level 3. The defect was that **nothing sized the encounter to the
table**: `encounterDirective` was handed only a difficulty, and the standing prompt in
`lobbyPrompts.js` knew the party size, spent it on level guidance, and then told the
model to "adjust the NUMBER of enemies rather than using single overpowered foes" with
no ceiling.

**Enemy count is far too sharp to use as a difficulty lever.** It scales the
opposition's damage output and its hit-point pool at once, so it moves win rate
quadratically. On Hardcore against goblins a party of three goes 93% → 68% → 35% → 11%
over four steps. Pushing past one enemy per character to chase the 25% target does not
make Merciless harder, it makes it impossible: a party of three against four AC 18
hobgoblins wins **0%** of the time.

## Decision

**An encounter is budgeted per living character, and one enemy per character is the
ceiling at every difficulty.** `encounterBudget({ partySize, difficulty })` returns a
whole-number `{min, max}`:

| enemies per character | Casual | Standard | Hardcore | Merciless |
|---|---|---|---|---|
| fewest | 0.5 | 0.75 | 1 | 1 |
| most | 0.75 | 1 | 1 | 1 |

**Difficulty above Standard is expressed in the multipliers, never in the ceiling.**
Casual and Standard get room below one per character; Hardcore and Merciless are pinned
at exactly one. That the top three settings share a ceiling is the finding, not an
oversight — the count says how big the table is, and `client/difficulty.js` says how
hard the setting is.

**One brief, two prompts.** `encounterSizingBrief` is shared verbatim by
`encounterDirective` (forced encounters) and by the standing system prompt (every DM
turn, which is where most fights are actually born). The standing prompt is the
load-bearing one; had the budget gone only into the directive it would have governed a
minority of encounters.

**A solo table is told to size the *creature*, not just the count.** Capping the head
count at one does nothing about one creature built for a party: measured, the CR 2 ogre
that is a 55% fight for a party of three is a **0.7% fight on Standard and 0% above it**
for a level 3 character alone. So the solo brief drops the "one larger monster may stand
in for the group" clause and says plainly that a party-sized monster kills a lone
character.

`balance-sim.mjs` now reads its enemy counts from `encounterBudget` rather than
hard-coding them, which is what let the original artifact survive four sessions.

## Consequences

Measured, 4000 fights per row, counts from the budget's ceiling:

| | Casual | Standard | Hardcore | Merciless |
|---|---|---|---|---|
| L1 solo vs goblins | 100% | 98.7% | 84.0% | 72.8% |
| L1 party of 3 vs goblins | 100% | 100% | 93.5% | 78.8% |
| L3 solo vs hobgoblins | 100% | 91.0% | 45.4% | 27.6% |
| L3 party of 3 vs hobgoblins | 100% | 98.3% | 41.4% | 11.7% |
| L5 solo vs orcs | 100% | 97.9% | 65.9% | 45.1% |
| L5 party of 4 vs orcs | 100% | 100% | 69.5% | 25.5% |

The solo gap closes. Standard solo goes 84.0% → 98.7% against the party's 100%, and the
worst solo-versus-party spread at any setting is now 16 points where it was 65.

Hardcore and Merciless move toward their targets without a single multiplier changing:
the party mean goes 76% → 67% on Hardcore and 55% → 39% on Merciless. Neither hits its
number, and **that is now understood rather than assumed**. The residual spread is
driven by the enemy's armour class against the party's to-hit — a quantity the
difficulty dial does not touch and the model invents freely. At one enemy per character
Merciless is 78% against AC 15 and 12% against AC 18. Closing that needs the dial to
reach armour class, which [ADR 0019](0019-difficulty-scales-the-opposition.md) rejected
for good reasons and this ADR does not reopen.

The one-shot rate stays 0% everywhere. The **one-turn** rate does not: a party of three
on Merciless takes a full character's hit points in a single player-turn in 34.8% of
hobgoblin fights. That is the cap working as specified — 0020 capped a blow and
explicitly declined to cap a turn — and it is the sharpest remaining edge in the engine.

Encounters get smaller on Casual and larger for parties facing archetypes the model
previously under-populated, so fights change length in both directions, and every round
is a paid model call.

**Level-scaled modifiers stay unbuilt.** 102 of 127 stored characters are level 1 and
none exceeds level 3, so the flat modifiers have no measurable defect to fix. Recorded
here so the next session does not re-derive it.

## Alternatives considered

**A challenge-rating budget rather than a head count**, as 5e builds encounters. Tested
against the grid and rejected: it does not predict this engine's win rates. Total CR per
character of 0.25, 0.5 and 1.0 gave 89%, 40% and 69% — not monotone, because difficulty
here comes mostly from armour class, which the engine's CR tables never see. A count is
also the one thing a narrator reliably obeys.

**Raise the ceiling above one per character on Hardcore and Merciless**, which is what
0020 proposed. Rejected on the measurement: it produces 0–6% encounters against high-AC
monsters, and "nothing is unwinnable" is the line this engine holds.

**A solo-specific adjustment in `client/difficulty.js`** — softer modifiers for a party
of one. Rejected: at equal enemies-per-character there is no consistent solo penalty to
compensate for, so it would have been a discount for a disadvantage that does not exist,
and it touches the party's own dice, which
[ADR 0019](0019-difficulty-scales-the-opposition.md) reserves for Casual alone.

**Leave the standing prompt alone and budget only forced encounters.** Rejected: the
directive fires only after a quiet streak, so most fights would have kept the old,
uncapped advice, and the two prompts would have named different counts.

_Last verified: 2026-07-28 against branch `Refactor`._
