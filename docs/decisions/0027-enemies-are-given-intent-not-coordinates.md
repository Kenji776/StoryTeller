# 0027 — Enemies are given intent, not coordinates

**Status:** Proposed (2026-07-29) — branch `feature/tactical-map`, phases 4 and 5

## Context

With a grid, something has to decide where the monsters go. That decision does not fit the rule
the rest of this project runs on, and noticing why is the whole of this ADR.

From [ADR 0008](0008-experience-is-awarded-by-the-server.md) to
[0020](0020-combat-balance-measured-not-guessed.md), fact after fact was taken away from the
narrator and computed instead: experience, loot, whether an attack landed, what a spell did,
enemy hit points. Every one of those was taken for the same reason — **it had a right answer and
the model kept getting it wrong.**

Enemy movement has no right answer. Whether a ghoul lunges at the wounded cleric or holds the
archway is a judgement about what that creature is like, and a good table wants a ghoul, a
disciplined guard and a wolf pack to behave differently. That is characterisation with
mechanical consequence, and it is the thing a Dungeon Master is actually for.

So this is the first decision in combat that should genuinely go the other way. It sits against
the constraint [ADR 0026](0026-tactical-combat-happens-on-a-grid.md) already committed to: the
narrator is told positions and never chooses them, because a model handed a grid will assert
that F7 is within 30 feet of C4 whenever that is the sentence it wanted to write.

Both hold at once, if the thing the model supplies is not a position.

## Decision

**The model chooses an intent from a closed vocabulary. The server turns intent into geometry.**

An intent is a verb and a target name — never a cell:

| intent | what the server does with it |
|---|---|
| `close(target)` | path toward the named creature, spend movement, attack if it ends in reach |
| `hold` | do not move; attack whatever is already in reach |
| `ranged(target)` | keep distance and line of sight; move only to restore one |
| `seek_cover(target)` | move to the nearest reachable cell with cover from that creature, then attack |
| `withdraw` | move away from the nearest threat, breaking off |
| `regroup(ally)` | move toward the named ally |

Six verbs, validated against a closed set. An unknown verb, a target that is dead or was never
on the map, or an intent that has become nonsense is discarded — not repaired.

**Every enemy has a deterministic default intent, and the fight runs on it alone.** The default
is a legible policy — close on the nearest reachable enemy, or hold if already in reach — and it
is what executes when the model says nothing, returns something unparseable, or the provider
falls over. That last case is not hypothetical: a provider error froze a seventy-action run
after two turns earlier the same day this was written. A fight that cannot proceed without a
working language model is worse than a fight with dull monsters.

**Intents ride the existing narration call as standing orders.** The DM's structured reply
already carries updates; it also carries next round's intents. There is no second call, so no
extra latency and no extra cost — which matters, because turn time was just cut from 37 seconds
to 15 and spending it again here would undo that.

The price is one round of lead time: an intent is chosen before the model has seen the player's
most recent move. That is a feature more than a cost — a monster that telegraphs is a monster a
player can play against — and the server re-validates every standing order at execution time,
falling back to the default the moment one has gone stale.

## Where the line falls

| The model decides | The server decides |
|---|---|
| who a creature goes for | whether it can get there |
| whether to hold, close, or break off | the route, and how far the movement actually reaches |
| whether cover is worth crossing the room for | which cells give cover, and against whom |
| what all of it looks like in prose | every distance, every roll, every hit point |

The test for anything new: **if two competent Dungeon Masters could reasonably disagree, the
model decides it; if they would both reach for a tape measure, the server does.**

## Consequences

**What this makes possible.** Monsters that behave in character without ever being wrong about
space. A closed verb set is also inspectable — an intent can be logged, replayed, and blamed,
which a paragraph of prose about a ghoul's mood cannot be.

**What it costs.** A vocabulary is a thing to maintain, and the temptation will be to add a
seventh verb rather than compose two existing ones. Standing orders make a turn slightly harder
to reason about, because the intent being executed was chosen a round earlier — worth a line in
the log saying which order fired and when it was issued.

**What it risks.** The default policy is what will actually run most of the time, since it runs
whenever anything goes wrong, and it will therefore set the felt quality of combat far more than
the interesting path does. It deserves to be tuned as a first-class feature rather than treated
as a fallback nobody looks at.

## Alternatives considered

**Fully deterministic enemy behaviour, no model involvement.** Cheapest, fastest, completely
reproducible, and it would play acceptably — approach the nearest, focus the wounded, keep
archers back. Rejected because it throws away the one thing the narrator is uniquely good at:
every creature in the game would fight identically, which is exactly the flatness that made
abstract combat feel like arithmetic in the first place. Kept as the default layer, where its
reproducibility is worth having.

**Let the model emit destination cells directly.** The obvious implementation, and the one a
naive version of this feature would ship. Rejected on the whole weight of this project's
history plus the specific finding behind ADR 0026: a model asked for coordinates produces
confident, wrong ones, and here it would do so at the exact moment a player is deciding whether
they die.

**A second model call per round, dedicated to tactics.** Fresh state, no staleness, and the
intents would be better. Rejected on latency and cost: it doubles both on every turn of every
fight, immediately after that budget was cut in half, and one round of lead time is a small
price beside it.

**Have the model rank a server-generated menu of legal moves.** Tempting, since precomputed
menus are already the pattern for player agents. Rejected because it inverts the split it looks
like it shares: a menu of cells is still a decision about position, so the model would be back
to choosing geometry, only with training wheels. Intent keeps the two concerns genuinely apart.

_Last verified: 2026-07-29 against branch `feature/tactical-map` (fd12f5a) — design only._
