# 0024 — The output budget must cover the model's reasoning, not just its prose

**Status:** Accepted (2026-07-29)

## Context

A live game on `claude-sonnet-5` failed mid-session with `stop reason: max_tokens`
and no narration at all. The call journal for lobby `4p3gp1` shows what led up to it:
as the story grew, the gap between tokens billed and prose returned widened.

| input tokens | output tokens | prose returned | unaccounted |
|---|---|---|---|
| 7,575 | 1,078 | ~401 | 677 |
| 9,456 | 2,266 | ~558 | 1,708 |
| 12,830 | 3,213 | ~275 | 2,938 |
| 13,596 | 3,264 | ~644 | 2,620 |
| — | *(failed)* | none | — |

The unaccounted tokens are the model reasoning before it answers. Two consecutive
turns then spent the entire 4,096-token budget reasoning and returned a reply with
no text block in it, which the adapter correctly refused to publish as narration.

The trigger was a model change, not a code change. Anthropic's models from Sonnet 5
and Opus 5 onward reason **by default** when a request omits the `thinking`
parameter; the models before them did not. StoryTeller has never sent that
parameter, so switching the DM to Sonnet 5 silently turned reasoning on. `max_tokens`
caps reasoning and prose *together*, so a ceiling chosen when only prose counted
against it became a ceiling the prose had to compete for.

This is worth recording because the obvious reading of the symptom is wrong in a way
that costs a day. An empty reply from a mid-tier model reads as the model being too
weak for the job, and the first instinct is to move the DM to a larger one. A larger
model would have failed the same way, sooner — Opus 5 has the same default and
reasons more.

## Decision

Size the default output budget for reasoning plus prose. `DEFAULT_MAX_TOKENS` moves
from 4,096 to 16,384.

Leave reasoning **on**. Adjudicating a turn against server-resolved mechanics while
keeping continuity with the scene is exactly the kind of work it helps, and the
narration quality across this session's games has been good.

When a reply does arrive truncated with no prose, say so in those terms and name the
budget as the thing to raise. The previous message — "returned no usable content" —
described the symptom accurately and pointed at nothing.

## Consequences

**Easier.** The failure cannot recur through ordinary story growth; the budget now
sits roughly five times the worst turn observed. Anthropic bills tokens produced
rather than reserved, so raising a ceiling that most turns never approach costs
nothing on those turns. Any future model that reasons more has room.

**Harder.** A genuine runaway now runs longer before anything stops it — 16k tokens
of reasoning against a wall clock is a slower failure than 4k was. Nothing in the
turn pipeline currently caps that beyond the request timeout.

**Unchanged, and still a live cost.** Reasoning is billed as output at the same rate
as prose, and effort defaults to `high`. At roughly 3k reasoning tokens a turn, a
30-turn game spends about 90k output tokens on reasoning nobody reads. Lowering
`output_config.effort` to `medium` would cut most of that and take the 20–40s DM turn
down with it, which matters for a real-time game with speech. That is not done here:
the model is operator-selectable from a dropdown that still lists older models, and
`effort` is not accepted by all of them. Doing it safely needs a capability check per
model, which is its own change.

## Alternatives considered

**Send `thinking: {type: "disabled"}`.** Restores the old behaviour exactly and is the
cheapest and fastest option. Rejected because it gives up quality on a task that
benefits, and because it carries two documented failure modes of its own on these
models — tool calls emitted as plain text, and internal tags leaking into visible
output. Both would land in front of players as narration.

**Move the DM to a larger model.** The instinctive fix, and the wrong one: Opus 5
shares the default and reasons more, so it would truncate sooner on the same budget.

**Raise the budget only for the DM call and leave the default alone.** Narrower, and
tempting. Rejected because every other Anthropic call in the app — feasibility
judging, encounter staging, quest checks — runs on the same default and is exposed to
the same failure; fixing one caller would have left the rest waiting to fail.

_Last verified: 2026-07-29 against branch `Refactor` (af44873)._
