# 0020 — Combat balance is measured, and no single blow deletes a character

Status: accepted
Supersedes: [0019](0019-difficulty-scales-the-opposition.md)

## Context

[ADR 0019](0019-difficulty-scales-the-opposition.md) gave difficulty real numbers.
They were chosen by reasoning, and never measured. Asked to play a game on the
hardest setting, the answer was a level 3 fighter in chain mail killed in three
turns by two CR ½ hobgoblins.

Simulating the real resolvers over thousands of fights found three things.

**The enemy action economy was inverted.** `resolveEnemyAttacks` is called inside
`action:submit`, so every enemy attacked every time *any* player acted. A party of
three facing three goblins took nine goblin attacks per round against their three,
and the penalty grew with party size — a party of four was punished harder than a
party of two for the same encounter. Hardcore was winnable 2–4% of the time and
Merciless 0%. This predated ADR 0019 entirely; making difficulty real is what
exposed it.

**A multiplicative hit-point bonus is disproportionate.** ×1.4 adds three hit points
to a goblin and twenty-four to an ogre, so one setting was a mild handicap against a
horde and unwinnable against a single brute: 78% versus 4% in the same run.

**A damage multiplier deletes characters.** At ×2.0 a CR 2 ogre one-shot a level 3
character from full health in 82% of fights — 2d6+4 tops out at 16, doubled is 32,
against 26 hit points.

## Decision

**Enemies share a round out across the party's turns.** Enemy *i* acts on player turn
*i mod partySize*, so each enemy attacks exactly once per full round while every
player's turn still draws fire. A solo character faces the whole roster on their turn,
correctly — their turn is the round. A caller that does not know whose turn it is
gets the whole roster, which is the old behaviour and the safe default.

**No single blow may take more than three-quarters of a character's maximum hit
points.** A character at full health survives any one hit; two still kill. It is a
cap on a *blow*, not on a turn, and a wounded character is in as much danger as ever.

**Hit points are not scaled above Standard**, and hit chance is preferred to damage
as the difficulty lever, because an attack bonus saturates — past a point every swing
lands and more does nothing — while a damage multiplier compounds without limit.

| | Casual | Standard | Hardcore | Merciless |
|---|---|---|---|---|
| Enemy attack bonus | −3 | 0 | +6 | +9 |
| Enemy damage | ×0.5 | ×1 | ×1.5 | ×2 |
| Enemy hit points | ×0.7 | ×1 | ×1 | ×1 |
| Party attack bonus | +3 | 0 | −1 | −1 |

`test-integration/balance-sim.mjs` is the tool that produced these and is kept so the
next change to combat can be checked the same way. It costs nothing to run.

## Consequences

Measured across five encounters, 4000 fights each:

| | Casual | Standard | Hardcore | Merciless |
|---|---|---|---|---|
| Party win rate | 100% | 99–100% | 29–91% | 26–78% |
| Solo win rate | 100% | 84% | 34% | 20% |
| One-shot rate | 0% | 0% | 0% | 0% |

Nothing is unwinnable and nothing is a formality. The one-shot rate is zero at every
setting, which was the operator's stated line.

Hardcore and Merciless land easier than the 50%/25% they were aimed at. That is the
cap doing its job: damage cannot rise further without one-shots returning, and the
attack bonus has largely saturated by +9. Making the game harder than this needs
tougher *encounters*, which is the DM's job and `encounterPacing`'s, not a bigger
multiplier.

**Solo play is much harder than party play** — 20% against 56% on Merciless for the
same encounter — because a lone character faces the whole roster every turn. That is
mechanically right and may still be worth compensating for; it is not compensated for
today.

Removing the hit-point multiplier also shortened fights, and every round of a fight is
a paid model call.

## Alternatives considered

**Resolve the whole enemy roster once per game round.** Strictly correct turn order,
and rejected: two of three players would take no return fire on their own turn, which
reads as the engine ignoring them.

**Leave the economy and soften the multipliers.** Rejected. It would have papered
over a bug whose severity scaled with party size, so a table of five would still have
been punished far harder than a table of two.

**Cap damage as a flat number rather than a share of maximum health.** Rejected: a cap
that protects a level 1 character is no protection at level 10, and one that protects
at level 10 is no cap at all early.

**Cap the damage of a whole turn rather than a single blow.** Rejected as too
protective — it would make a character effectively unkillable in any one exchange, and
the point is that losing must stay possible.

_Last verified: 2026-07-28 against branch `Refactor`._
