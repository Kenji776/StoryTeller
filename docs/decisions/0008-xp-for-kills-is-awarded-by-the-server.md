# 0008 — XP for defeated enemies is awarded by the server, not the narrator

Status: accepted

## Context

XP was entirely at the Dungeon Master's discretion. `broadcastXPUpdates` fired only
when the model volunteered an `updates.xp` block in its JSON.

Across a full 30-turn playtest it never did — not once, including for the session's
only confirmed kill, a goblin reduced to 0 HP and flagged dead. Every character
finished at `xp: 0`. Levelling, `player:levelup`, and the abilities granted on
level-up were therefore unreachable in normal play: the progression system existed
and had never run.

The enemy stat blocks carried a challenge rating throughout (`"cr": "1/4"`).
Nothing read it.

This is a predictable failure rather than a bad model. The narrator is mid-scene,
optimising for prose, and bookkeeping is the first thing to fall out of a long
generation. Asking it to remember on every turn is asking for the thing it is
worst at.

## Decision

Award XP server-side when an enemy dies, from its challenge rating.

`updateEnemies` now returns the enemies that transitioned to dead on that update,
each reported exactly once — guarded by an `xpAwarded` flag on the enemy record,
because the model re-sends enemy blocks after combat ends and would otherwise be
paid repeatedly for the same corpse.

`experience.js` converts a rating to XP against the standard table and splits the
total evenly across living party members, rounding down so a larger party cannot
mint XP, with a floor of 1 so a kill is never worth literally nothing.

The `updates.xp` channel stays open for non-combat awards — puzzles, negotiation,
milestones — and the prompt now says so explicitly, so the two sources do not
double-pay for the same kill.

## Consequences

XP now accrues without the model's cooperation, so levelling is reachable and
`xp:update` and `player:levelup` are exercised by ordinary play.

The award is only as good as the `cr` the model assigns. A mislabelled enemy pays
the wrong amount — but a wrong amount is recoverable and an admin can correct it,
whereas the previous behaviour was unrecoverable by construction.

Ratings above the table clamp to CR 30 rather than paying nothing, so an invented
"CR 40" boss is generous rather than worthless.

## Alternatives considered

**Strengthen the prompt to require an `xp` block.** Rejected as the primary fix. It
was already in the schema and the model still never used it; making correctness
depend on a narrator remembering bookkeeping is what failed. It is kept as the
secondary path for story awards, where no deterministic signal exists.

**Award XP from damage dealt, or per turn survived.** Rejected. Both reward
attrition and grinding rather than accomplishment, and neither matches what players
coming from tabletop expect.

**Award the full value to every character rather than splitting.** Rejected: it
makes a large party level several times faster than a small one for the same
content, and the encounter scaling in the prompt assumes party level.

_Last verified: 2026-07-27 against branch `Refactor`._
