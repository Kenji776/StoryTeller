<!-- GENERATED — DO NOT EDIT. Regenerate with:
     node server/test-integration/bakeoff/writeReport.mjs --in <results.json> --out <this file> -->

# Model bake-off — screen stage

**Screen only** — mixed player actions each. A screen grade is a floor, not a measurement: it cannot see context decay, history summarisation, or long-run combat drift.

21 model(s) evaluated in 0 minutes.

## Summary

| Verdict | Meaning | Models |
|---|---|---|
| **recommended** | run a table on it | 18 |
| **usable** | playable, with rough edges | 0 |
| **marginal** | works, but costs or misbehaves enough to hurt | 0 |
| **unusable** | cannot run the game loop | 2 |
| **not evaluated** | the provider never let it answer — no verdict, retry needed | 1 |

| # | Model | Score | Grade | Verdict | Turns | Median | p90 |
|---|---|---|---|---|---|---|---|
| 1 | `openai/gpt-5.4` | 100 | A | recommended | 13 | 6.5s | 7.9s |
| 2 | `openai/gpt-5.5` | 100 | A | recommended | 18 | 19.1s | 27.5s |
| 3 | `openai/chat-latest` | 100 | A | recommended | 18 | 3.6s | 4.6s |
| 4 | `openai/gpt-5.2-chat-latest` | 100 | A | recommended | 16 | 5.1s | 6.0s |
| 5 | `openai/gpt-5.2` | 100 | A | recommended | 186 | 5.9s | 7.9s |
| 6 | `openai/gpt-4o-mini` | 100 | A | recommended | 18 | 2.9s | 4.5s |
| 7 | `openai/gpt-5.3-chat-latest` | 100 | A | recommended | 14 | 6.4s | 8.7s |
| 8 | `openai/gpt-5.6-luna` | 100 | A | recommended | 19 | 2.7s | 4.0s |
| 9 | `openai/gpt-5.6-sol` | 100 | A | recommended | 16 | 9.7s | 18.2s |
| 10 | `openai/gpt-5.4-mini` | 100 | A | recommended | 15 | 3.0s | 3.5s |
| 11 | `openai/gpt-5.1` | 100 | A | recommended | 14 | 11.2s | 17.8s |
| 12 | `openai/gpt-5.4-nano` | 100 | A | recommended | 15 | 3.8s | 4.1s |
| 13 | `openai/gpt-5.6-terra` | 100 | A | recommended | 17 | 5.3s | 7.0s |
| 14 | `claude/claude-sonnet-4-6` | 99 | A | recommended | 25 | 15.0s | 20.6s |
| 15 | `anthropic/claude-opus-5` | 98 | A | unusable | 16 | 17.1s | 21.9s |
| 16 | `anthropic/claude-fable-5` | 98 | A | recommended | 16 | 16.3s | 28.2s |
| 17 | `anthropic/claude-opus-4-7` | 97 | — | not evaluated | 5 | 9.7s | 14.4s |
| 18 | `anthropic/claude-opus-4-8` | 96 | A | recommended | 13 | 13.0s | 15.2s |
| 19 | `anthropic/claude-sonnet-5` | 90 | A | recommended | 86 | 9.4s | 15.2s |
| 20 | `openai/gpt-4o` | 87 | B | recommended | 99 | 2.7s | 3.7s |
| 21 | `ollama/qwen2.5vl:7b` | 87 | B | unusable | 13 | 8.1s | 20.1s |

## recommended — run a table on it

### `openai/gpt-5.4` — 100/100 (A)

13 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-0j4ezf.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 13/13 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.5` — 100/100 (A)

18 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-1hsfk6.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 18/18 turns completed, 0 stall(s), 0 provider error(s)

### `openai/chat-latest` — 100/100 (A)

18 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-zlrzgj.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 18/18 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.2-chat-latest` — 100/100 (A)

16 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-b6e535.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 16/16 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.2` — 100/100 (A)

186 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-4x8pjg.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **1.00** — 1 encounter(s) over 183 combat turn(s); unresolved×1
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **n/a** — no implausible actions were submitted to judge
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **0.98** — 186/186 turns completed, 0 stall(s), 6 provider error(s)

### `openai/gpt-4o-mini` — 100/100 (A)

18 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-8f6bu0.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **0.99** — updates mistyped
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 18/18 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.3-chat-latest` — 100/100 (A)

14 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-8s0eau.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 14/14 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.6-luna` — 100/100 (A)

19 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-d6cq1s.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 19/19 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.6-sol` — 100/100 (A)

16 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-epgqs2.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 16/16 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.4-mini` — 100/100 (A)

15 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-k0k6en.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 15/15 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.1` — 100/100 (A)

14 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-n27r64.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 14/14 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.4-nano` — 100/100 (A)

15 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-rgpqzf.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 15/15 turns completed, 0 stall(s), 0 provider error(s)

### `openai/gpt-5.6-terra` — 100/100 (A)

17 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-xazn6s.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 17/17 turns completed, 0 stall(s), 0 provider error(s)

### `claude/claude-sonnet-4-6` — 99/100 (A)

25 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-tjiqpt.jsonl`

  - `jsonDiscipline` **0.98** — 100% parsed, 96% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **1.00** — 1 encounter(s) over 6 combat turn(s); no violations
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **n/a** — not measured: the server's feasibility gate was not enforcing (FEASIBILITY_MODE=observe or off)
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 25/25 turns completed, 0 stall(s), 0 provider error(s)

### `anthropic/claude-fable-5` — 98/100 (A)

16 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-7x2hu7.jsonl`

  - `jsonDiscipline` **0.95** — 100% parsed, 88% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 16/16 turns completed, 0 stall(s), 0 provider error(s)

### `anthropic/claude-opus-4-8` — 96/100 (A)

13 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-rjyu8g.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **0.70** — refused 100% of absurd actions; wrongly refused 10% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 13/13 turns completed, 0 stall(s), 0 provider error(s)

### `anthropic/claude-sonnet-5` — 90/100 (A)

86 graded replies · ended by `rescored-from-journal` · 1 JSON repair call(s) · transcript `server/logs/llm-vitqh9.jsonl`

  - `jsonDiscipline` **0.99** — 99% parsed, 99% on the first try without repair
  - `schemaConformance` **1.00** — suggestions missing
  - `combatLifecycle` **0.56** — 5 encounter(s) over 9 combat turn(s); oneTurnWipe×2, rosterDrop×2
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **n/a** — no implausible actions were submitted to judge
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **0.99** — 86/86 turns completed, 0 stall(s), 1 provider error(s)

### `openai/gpt-4o` — 87/100 (B)

99 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-6mavw3.jsonl`

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **0.92** — combat_over missing
  - `combatLifecycle` **0.50** — 9 encounter(s) over 22 combat turn(s); oneTurnWipe×2, rosterDrop×4, missingVerdict×10
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **n/a** — no implausible actions were submitted to judge
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 99/99 turns completed, 0 stall(s), 0 provider error(s)

## unusable — cannot run the game loop

### `anthropic/claude-opus-5` — 98/100 (A)

16 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-4kv2ln.jsonl`

**Blockers:**

  - only 94% of replies could be parsed as JSON — the game loop cannot run on this (1 of 16 replies — thin sample)

  - `jsonDiscipline` **0.94** — 94% parsed, 94% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 16/16 turns completed, 0 stall(s), 0 provider error(s)

### `ollama/qwen2.5vl:7b` — 87/100 (B)

13 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-ly869l.jsonl`

**Blockers:**

  - mean schema conformance 50% — the response schema is not being followed (over 13 replies — thin sample)

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **0.50** — combat_over missing, prompt missing, sfx missing, spellUsed missing, updates missing
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **1.00** — refused 100% of absurd actions; wrongly refused 0% of plausible ones
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **1.00** — 13/13 turns completed, 0 stall(s), 0 provider error(s)

## not evaluated — the provider never let it answer — no verdict, retry needed

### `anthropic/claude-opus-4-7` — 97/100 (—)

5 graded replies · ended by `rescored-from-journal` · 0 JSON repair call(s) · transcript `server/logs/llm-olgoum.jsonl`

**Blockers:**

  - the provider cut the run short after 5 reply(ies) (4 provider error(s)) — too little to judge the model on

  - `jsonDiscipline` **1.00** — 100% parsed, 100% on the first try without repair
  - `schemaConformance` **1.00** — every required key present and well typed
  - `combatLifecycle` **n/a** — not exercised by this run
  - `stateEvents` **1.00** — every state event carried the fields the appliers read
  - `judgement` **n/a** — no implausible actions were submitted to judge
  - `narrationHygiene` **1.00** — narration stayed free of markdown and JSON
  - `reliability` **0.60** — 5/5 turns completed, 0 stall(s), 4 provider error(s)
