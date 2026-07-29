# Encounters

`server/services/encounterPacing.js` — **when** a fight happens, and **how big** it is.
What happens once it starts is [modules/combat.md](combat.md).

## When

Whether the party was ever attacked was the narrator's whim, and it declined: in one
120-turn game all 36 DM turns set `combat_over: true` and none carried an enemies array,
so the enemy-turn resolver had nobody to roll for and `player:death` could not fire
however dangerous the lobby claimed the world was. Brutality and difficulty governed
tone only.

So the server counts consecutive turns with no living enemy and, past a threshold, tells
the DM to start one in this response. A threshold and not a random chance — randomness
lets a table go a whole session untouched by luck, which is the situation this exists to
prevent.

| Casual | Standard | Hardcore | Merciless |
|---|---|---|---|
| 14 quiet turns | 9 | 6 | 4 |

A fight already in progress suppresses it; the resolver is handling that, and stacking
another encounter on a busy party is not pacing.

## How big

`encounterBudget({ partySize, difficulty })` returns a whole-number `{min, max}` of
hostile creatures, sized to the **living characters at the table**:

| enemies per character | Casual | Standard | Hardcore | Merciless |
|---|---|---|---|---|
| fewest | 0.5 | 0.75 | 1 | 1 |
| most | 0.75 | 1 | 1 | 1 |

Rounded, floored at one, and `min <= max` always. A party size that is missing, zero or
unreadable is budgeted as solo — the smallest encounter, so a caller that forgets cannot
ambush one character with six creatures.

**One enemy per character is the ceiling at every setting, and difficulty never raises
it.** Count is the sharpest lever in the engine because it scales the opposition's
damage output and hit-point pool at once: on Hardcore against goblins a party of three
goes 93% → 68% → 35% → 11% over four steps. Past one per character it does not make the
hard settings harder, it makes them impossible — a Merciless party of three against four
AC 18 hobgoblins wins 0% of the time. Difficulty above Standard is expressed in the
multipliers in `client/difficulty.js`. See
[ADR 0022](../decisions/0022-encounters-are-sized-to-the-party.md).

## Two prompts, one brief

`encounterSizingBrief` is shared verbatim by:

- `encounterDirective`, the system message pushed when the quiet threshold trips;
- the standing DM system prompt in `services/lobby/lobbyPrompts.js`, on **every** turn.

The standing one is load-bearing — the directive fires only after a quiet streak, so
most fights are born under the standing prompt. It previously knew the party size, spent
it on level guidance, and told the model to "adjust the NUMBER of enemies rather than
using single overpowered foes" with no ceiling: exactly wrong for the 39% of stored
games with one character in them.

Held separately the two named different counts, which is the drift this codebase has
already paid for with armour class, spell slots and the condition vocabulary.

## The solo case

A count ceiling of one does not protect a lone character from one thing built for a
party. Measured: the CR 2 ogre that is a 55% fight for a party of three is a 0.7% fight
on Standard, and 0% above it, for a level 3 character alone.

So a solo brief drops the "one larger monster may stand in for the whole group" clause
that a party's carries, and says in as many words that a monster sized for a party kills
a lone character outright.

## Known gaps

- **The budget is a head count, not a challenge-rating budget.** Tested and rejected:
  total CR per character of 0.25, 0.5 and 1.0 gave win rates of 89%, 40% and 69% — not
  monotone, because difficulty in this engine comes mostly from the armour class the
  model invents, which the CR tables never see.
- **Nothing verifies the model obeyed the count.** The budget is stated in the prompt;
  the roster that comes back is whatever the DM wrote. A post-hoc trim would need to
  decide which creature to delete mid-scene.
- **The severity lines are still adjectives.** "Make it lethal" is tone; only the count
  and the multipliers are mechanical.

_Last verified: 2026-07-28 against branch `Refactor`._
