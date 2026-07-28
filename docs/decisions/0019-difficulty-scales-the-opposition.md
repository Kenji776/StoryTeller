# 0019 — Difficulty scales the opposition, and says exactly how

Status: accepted

## Context

`difficulty` was four adjectives. It selected a paragraph of prompt and fed
`shouldForceEncounter`; it touched no number in any roll.

That was survivable while combat was the narrator's to imagine. It stopped being
survivable with [ADR 0018](0018-player-attacks-are-rolled-by-the-server.md): once
attacks are rolled against real armour class, combat got materially harder for
everyone at once, and a setting named "difficulty" could not do anything about it.
A level 3 fighter with a shortsword against AC 18 misses more than half the time on
Casual exactly as readily as on Merciless.

The settings window also described the dial as "controls enemy strength, DC
thresholds, and how punishing mistakes are" — true of the prompt, and not something
a host could plan around.

## Decision

Difficulty scales the **opposition**, in three places, plus one clearly-disclosed
adjustment to the party's own attack roll.

| | Casual | Standard | Hardcore | Merciless |
|---|---|---|---|---|
| Enemy attack bonus | −3 | 0 | +2 | +4 |
| Enemy damage | ×0.5 | ×1 | ×1.25 | ×1.5 |
| Enemy hit points | ×0.6 | ×1 | ×1.25 | ×1.5 |
| Party attack bonus | +3 | 0 | 0 | −1 |

Standard is a true no-op, so every balance judgement made before this holds.

The party's own attack bonus is the one place the dial touches the party's dice
rather than the opposition's. It is there because armour class decides hits now, and
without it Casual is not casual. It is stated to the host in as many words.

Player *damage* is untouched at every setting: a weapon deals what the weapon deals.

Enemy hit points are scaled **once**, when the enemy is introduced. Rescaling on
every update would inflate a creature without bound, because the model re-sends its
stat block each turn.

The table lives in `client/difficulty.js`, imported by the server. `describeDifficulty`
renders it into the exact lines shown in the settings window and pasted into the DM
prompt, so the host's promise, the narrator's brief and the arithmetic are one
artifact. That is the same fix applied to armour class, spell slots and the condition
vocabulary, each of which drifted while held in two places.

## Consequences

The dial does what its name says, and a host is told the numbers before they commit
to a campaign rather than discovering them in play.

Casual is genuinely gentle: enemies are −3 to hit, deal half damage, have 40% fewer
hit points, and the party is +3 to hit. Merciless is genuinely brutal and a
character will die.

The DM is told the modifiers **and** told they are already applied. Given the
numbers without that caveat it would apply them a second time on top of damage the
server had already scaled.

Difficulty now has to be threaded to three call sites and `turnTimer.js`. A future
combat path that forgets to pass it plays at Standard — a quiet failure, not a
crash, and the reason `difficultyModifiers` falls back rather than throwing.

The modifiers are flat rather than level-scaled. A +4 enemy attack bonus matters
more to a level 1 party than a level 15 one. Reasonable at the one-shot lengths this
game is built for; it will want revisiting if campaigns run long.

## Alternatives considered

**Scale the party's damage too.** Rejected. It is the least legible knob — a player
watching their own greatsword deal different numbers on different days has no way to
attribute it — and the same effect is available by scaling enemy hit points, which
reads as "that thing is tougher" instead of "my sword got worse".

**Adjust enemy armour class instead of their hit points.** Rejected: AC is set per
creature by the model, and quietly rewriting it would fight the stat blocks it
invents. Hit points scale cleanly and are already the server's.

**Leave the party's rolls alone entirely.** Tempting, and it was the original
instinct — the party's dice should be the party's. Rejected because Casual then has
no way to help a party that keeps missing, which is the exact complaint ADR 0018
created.

**Express it as advantage/disadvantage rather than flat bonuses.** Rejected for now:
more 5e-authentic, harder to state in one line to a host, and it interacts with a
critical-hit rule the engine has but does not otherwise use.

_Last verified: 2026-07-28 against branch `Refactor`._
