# 0025 — Reasoning effort is capped, because a table is waiting

**Status:** Accepted (2026-07-29)
**Follows:** [0024](0024-the-output-budget-must-cover-reasoning.md)

## Context

ADR 0024 raised the output budget so the DM could reason and still have room to
narrate. It named the cost it was leaving in place: reasoning runs at the default
`high` effort, about 3k tokens and 20–40s a turn, and noted that capping it needed a
per-model capability check.

The very next game turned that from a cost into a failure. Measured across its DM
calls: 9.5s, 10.6s, 16.6s, 14.9s, 24.9s, **37.2s** — and one that ran past the 60s
request timeout and lost its narration outright. The table got nothing for that action.

The 4,096-token cap had been acting as an accidental brake on turn *length*: a model
that cannot produce more than 4k tokens cannot spend more than about 48s doing it.
Raising the ceiling removed the brake along with the truncation.

Reasoning effort is what actually governs this. `high` is the right default for a hard
coding problem and the wrong one for a narrator with four players and a speech
synthesiser waiting on the reply.

## Decision

Send `output_config: {effort: "medium"}` by default, and only to models that accept
the parameter — matched against a positive list of families, by prefix so dated
release ids are recognised. A model not on that list is sent nothing, which is exactly
today's behaviour.

Raise the request timeout from 60s to 120s as a backstop. It is not the fix; effort is.
A timeout tuned below the slowest turn we are willing to wait for converts a slow
narration into no narration.

The choice of the adapter as the home for this follows the boundary
`docs/modules/llm.md` already states: provider differences are absorbed there rather
than leaking into the game loop. Which knob controls reasoning, and which models have
it, is precisely such a difference.

## Consequences

**Easier.** Turns get shorter and cheaper without giving up the reasoning that keeps
the DM consistent about hit points and initiative. The failure mode, if the list is
wrong about a model, is a lost effort hint rather than a 400 on every turn.

**Harder.** The capability list is a hand-maintained fact about someone else's API, and
nothing fails loudly when it goes stale — a new model simply runs at `high` until
somebody notices. The dropdown in `client/config/llm_models.json` is already stale in
exactly this way, which is the same maintenance problem wearing different clothes.

## Alternatives considered

**Raise the timeout and leave effort alone.** One constant, no capability list. Rejected
as treating the symptom: 37s turns were already poor pacing for a live game, and the
operator had raised pacing as a complaint in this same session. A longer timeout makes
the bad case survivable, not good.

**Stream the response.** The general remedy for request timeouts on long outputs, and it
would remove the wall-clock question rather than move it. Rejected for now as much the
larger change: the turn pipeline consumes a complete reply, and every caller and test
assumes it.

**Set effort per call site** — `low` for feasibility judging, `medium` for narration.
Better matched to the work, and worth doing later. Rejected as the first move because
it means threading a new option through the gateway to every caller, where a single
adapter default fixes every call site at once.

_Last verified: 2026-07-29 against branch `Refactor` (84aab0c)._
