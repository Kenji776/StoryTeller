# Which models can be the brains of the game

**Date:** 2026-07-30 · **Branch:** `feature/tactical-map` · **Stage:** screen only
**Data:** [generated/model-bakeoff-2026-07-data.md](generated/model-bakeoff-2026-07-data.md)
**Method:** [modules/model-bakeoff.md](../modules/model-bakeoff.md) ·
[ADR 0028](../decisions/0028-model-viability-is-screened-before-it-is-played.md) ·
[runbooks/run-a-model-bakeoff.md](../runbooks/run-a-model-bakeoff.md)

## The answer

**Any current OpenAI chat model runs this game correctly.** Thirteen were measured and
all thirteen scored 100/100 — clean first-try JSON on every reply, full schema
conformance, no markup leaking into narration, and every absurd player action correctly
refused with no false refusals. Pick on latency and price, not capability.

**Anthropic's models also run it**, with one caveat worth knowing (below). Four of five
measured land in `recommended`.

**The local Ollama models cannot.** Not for lack of JSON — `qwen2.5vl:7b` parsed 13 of 13
replies cleanly — but because it ignores most of the response contract.

### Recommended, with the fastest first

| Model | Score | Median latency | Note |
|---|---|---|---|
| `openai/gpt-5.6-luna` | 100 | 2.7s | fastest of the current generation |
| `openai/gpt-4o-mini` | 100 | 2.9s | cheapest thing that is flawless here |
| `openai/gpt-5.4-mini` | 100 | 3.0s | |
| `openai/chat-latest` | 100 | 3.6s | floating alias |
| `openai/gpt-5.4-nano` | 100 | 3.8s | smallest model that still scores 100 |
| `openai/gpt-5.2-chat-latest` | 100 | 5.1s | |
| `openai/gpt-5.6-terra` | 100 | 5.3s | |
| `openai/gpt-5.2` | 100 | 5.9s | |
| `openai/gpt-5.3-chat-latest` | 100 | 6.4s | |
| `openai/gpt-5.4` | 100 | 6.5s | |
| `openai/gpt-5.6-sol` | 100 | 9.7s | |
| `openai/gpt-5.1` | 100 | 11.2s | |
| `openai/gpt-5.5` | 100 | 19.1s | slowest for no measured gain |
| `anthropic/claude-sonnet-4-6` | 99 | 15.0s | |
| `anthropic/claude-fable-5` | 98 | 16.3s | |
| `anthropic/claude-opus-4-8` | 96 | 13.0s | |
| `anthropic/claude-sonnet-5` | 90 | 9.4s | fastest Anthropic measured |
| `openai/gpt-4o` | 87 | 2.7s | oldest model still `recommended` |

**For a live table, `gpt-4o-mini` or `gpt-5.4-nano` is the recommendation**: both score a
perfect 100 at about 3 seconds a turn, and nothing more expensive measured better. That is
the single most useful finding here — the game's bottleneck is protocol compliance, and
the small cheap models comply perfectly.

## The one real defect found

**`claude-opus-5` dropped the JSON envelope entirely on 1 of 16 turns.** It returned 1,836
characters of well-formed HTML narration with no JSON object anywhere in it:

```
<p><strong>Dorn Hammerfall</strong> has one fist locked on the rope, the shepherd's
weight swinging and scraping below…
```

`parseDMJson` cannot rescue that — there is no JSON to repair — so the turn produces no
state updates at all and the beat is lost. All five repair stages fail.

That is why the flagship model reads `unusable` on a 98/100 score: the score is the
weighted quality of what it produced, and the verdict is whether you can run a table on
it. **Caveat: one event in sixteen turns is not a rate.** The report flags it
`lowSample`, and it needs a full 80-turn game to know whether the true frequency is 6% or
0.5%. Do not treat "94% parse" as a measurement.

## What the local models actually did

`qwen2.5vl:7b` produced **13 of 13 cleanly-parsing JSON objects** — better first-try JSON
discipline than some hosted models. It then omitted, on every turn:

`combat_over` · `updates` · `prompt` · `sfx` · `spellUsed`

The consequences are specific and fatal rather than cosmetic. Without `combat_over` the
server can never learn a fight has ended, so **combat would never stop**. Without
`updates` no damage, XP, loot or condition change is ever applied, so **nothing that
happens to a character persists**. It writes good prose and cannot run a game.

The other five local models were not measured: each run held the single GPU for over
thirty minutes, and one cold-start call exceeded the deployment's own
`LLM_TIMEOUT_MS=60000`. Given the 7B model fails on schema conformance, the two 3B models
are unlikely to do better — but that is an expectation, not a result, and it is not
recorded as one.

## What was not measured, and why

This is a **screen**, not the 20-turn-per-player game that was asked for. Two provider
quotas ran out mid-sweep:

- **OpenAI is out of quota** — "You exceeded your current quota, please check your plan and
  billing details." This was **caused by this exercise**: an early sweep ran at
  concurrency 8, which both burned the budget and triggered rate limiting. Concurrency 3
  and then 1 were still refused. That was my error, and it cost the stage-2 runs.
- **Anthropic hit an account usage cap**, regaining access **2026-08-01 00:00 UTC**. Five
  models were measured before it tripped; six were not.

Everything above was therefore recovered by **re-scoring the call journals already on
disk** (`rescore.mjs`), which costs nothing: the gateway records every call with its raw
reply, and the whole scoring layer is pure. Twenty-one models were recovered from 149
journals this way.

### Consequences for how much to trust this

| Claim | Confidence |
|---|---|
| Current OpenAI models emit correct DM JSON | **High** — 13 models, 100/100 each, consistent |
| `gpt-4o-mini` / `gpt-5.4-nano` are the value picks | **High** — perfect scores at ~3s |
| Local Ollama models cannot follow the schema | **High** — same five keys missing on every turn |
| `claude-opus-5` drops the envelope ~6% of turns | **Low** — one event in sixteen |
| Combat lifecycle behaviour across a long fight | **Not measured** — screens do not reach sustained combat |
| Context decay, history summarisation, long-run drift | **Not measured** — needs the 80-action run |

Three marked rows are the gap. `combatLifecycle` is `n/a` throughout, because a 12-action
screen does not reliably reach a fight; it is excluded from the weighting rather than
scored zero.

## To finish the job

When either quota resets:

```bash
PORT=3099 DEV_MODE=TRUE FEASIBILITY_MODE=judge node server/server.js

node server/test-integration/bakeoff/bakeoff.mjs --url http://localhost:3099 \
    --actions 80 --concurrency 2 \
    --models gpt-4o-mini,gpt-5.4-nano,claude-opus-5,claude-sonnet-5 \
    --out server/logs/bakeoff-full.json
```

`--actions 80` is 20 turns for each of the four players. Keep concurrency at 2 — the
lesson of this exercise is that the sweep's own concurrency is what exhausted the budget.
Priorities in order: confirm or clear `claude-opus-5`'s envelope defect, and exercise
combat over a sustained fight for the two value picks.

## One finding that is not about models

**`FEASIBILITY_MODE` is unset on this deployment**, so `actionGate` runs in `observe`
mode: it logs what it *would* have refused and lets everything through. Player actions are
not being gated in the operator's own instance. The bake-off had to set
`FEASIBILITY_MODE=judge` to measure judgement at all, and every model scored a perfect
100% refusal rate with zero false refusals once it was on — the capability is there and
switched off.

_Last verified: 2026-07-30 against branch `feature/tactical-map` (2e96378)._
