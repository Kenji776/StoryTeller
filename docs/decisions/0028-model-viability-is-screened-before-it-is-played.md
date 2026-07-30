# 0028 — Model viability is screened before it is played

Status: accepted
Date: 2026-07-29

## Context

We need to know which models from OpenAI, Anthropic and the local Ollama instance
can actually run the game: emit parseable DM JSON, handle loot/XP/damage events,
start and stop combat properly, and make sensible judgement calls on player
actions. The brief was a 20-turn-per-player game for every available model.

The three catalogues list **94** models. After rejecting non-chat endpoints and
collapsing dated snapshots onto their floating aliases, **56** remain worth
testing. A 20-turn game for a four-player party is 80 DM calls, plus repairs,
judgements, title and summarisation calls. Playing all 56 in full is on the order
of 7,500 model calls and days of wall clock, most of it spent discovering that a
3B local vision model cannot close a JSON object — a fact three calls establish.

The cost is not evenly distributed either. The failures that disqualify a model are
overwhelmingly *early* failures: a model that cannot produce the response object on
turn 2 will not learn to by turn 60.

## Decision

**Run every candidate through a cheap screen first, and play full games only for
the survivors.** Both stages use the same driver against the same real server over
real sockets, differing only in `--actions`; the screen is literally the opening of
the same game, because `buildActionScript` guarantees a short script is a strict
prefix of a long one.

Every model still appears in the final report with a grade and evidence. The screen
does not narrow the scope of the evaluation — it narrows only the spend on models
whose verdict is already decided.

A screen cannot reach a fight, so the combat dimension is marked
`applicable: false` for screens and its weight renormalises away, rather than
scoring zero and libelling the model.

## Consequences

**Easier.** The full field is evaluated for roughly the cost of five full games
instead of fifty-six. Re-screening after a prompt change is cheap enough to do
routinely. A model that fails is failed with a quoted reply rather than an opinion.

**Harder.** A model that is fine for three turns and degrades at thirty is not
caught by the screen — only by promotion to a full run. Screen thresholds are
therefore set to admit anything ambiguous, accepting wasted full runs as the
cheaper error. The screen also cannot see context-window decay, history
summarisation, or long-run combat drift; those are exactly what stage two is for,
and the report must not claim screen-only results say anything about them.

**Grades from the two stages are not interchangeable**, and the report labels which
stage produced each. A screen grade is a floor, not a measurement.

## Alternatives considered

**Play all 56 in full.** Faithful to the brief as literally worded, and rejected on
cost: days of wall clock and a large bill, the majority of it spent re-proving
turn-2 failures for another 78 turns. Nothing in the extra spend changes a verdict.

**Screen with direct adapter calls instead of a real game.** Cheaper still, and
rejected because it would grade models against a hand-written approximation of the
prompt. `lobbyPrompts.js` assembles the real one from party state, enemy roster,
difficulty, brutality and encounter pacing; a model judged against a simplified
stand-in tells you nothing about the game that actually ships.

**Sample a few models per family.** Cheapest, and rejected because family names do
not predict protocol compliance — `-nano` and `-pro` members of one generation
behave nothing alike on structured output, which is the whole thing being measured.

**Reuse `playtest.mjs` for both stages.** Tempting, and rejected: it is built for
human-watched exploratory soak runs, with reading-speed pacing, a reconnect test,
advisor probes and persona-improvised turns. Improvised turns are fatal here —
comparability requires that every model be asked the same questions — and its
pacing would add hours across 56 runs. Bolting a second personality onto an
825-line file was the worse option.
