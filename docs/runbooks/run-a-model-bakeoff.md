# Runbook: run a model bake-off

Answers "which models can run this game", with evidence. Read
[modules/model-bakeoff.md](../modules/model-bakeoff.md) for what the numbers mean and
[ADR 0028](../decisions/0028-model-viability-is-screened-before-it-is-played.md) for
why it is two stages.

## Before you start

**Use a dedicated dev-mode server on its own port.** Not the one you play on.

```bash
PORT=3099 DEV_MODE=TRUE FEASIBILITY_MODE=judge node server/server.js
```

Dev mode skips ElevenLabs synthesis and image generation and touches nothing in the
DM turn pipeline. Without it a full sweep synthesises speech for every one of
several thousand turns, which is a large bill for audio nobody hears. Its own port
keeps the sweep from disturbing a live table.

**`FEASIBILITY_MODE=judge` is not optional if you want a judgement score.** It is
unset by default, and `actionGate` then runs in `observe` mode: it logs what it
*would* have refused and lets everything through, never emitting `action:rejected`.
On such a server no model can be observed to judge anything.

The harness no longer silently scores that zero — before the script it submits one
action naming a spell no level-1 character knows, which `hardChecks` refuses in pure
code with no model call. Look for one of these lines early in the output:

```
gate is enforcing (probe refused: unknown_ability)
gate is NOT enforcing — judgement cannot be measured on this server
```

If you see the second, the judgement dimension is reported `n/a` and its weight
renormalises away, rather than being charged to every model equally.

Keys come from `server/.env` via the operator vault — `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` (or the legacy `CLAUDE_API_KEY`). Ollama needs none. A provider
with no key is reported and skipped, not fatal.

## Stage 1 — screen the whole field

```bash
node server/test-integration/bakeoff/bakeoff.mjs \
    --url http://localhost:3099 --actions 12 --concurrency 8 \
    --providers openai,anthropic --out server/logs/bakeoff-screen-hosted.json
```

### Descending sweep (`--descend`)

For a catalogue as large and as layered as OpenAI's, walk generations newest to oldest
and stop once a whole generation is dead:

```bash
node server/test-integration/bakeoff/bakeoff.mjs \
    --url http://localhost:3099 --actions 12 --concurrency 3 \
    --providers openai --descend --out server/logs/screen-openai.json
```

Models are grouped into release "rungs" (`generations.js`) and ordered by the **dated
snapshots the catalogue itself publishes** — not by version number, because version
numbers lie about recency across families: `gpt-4.1` (April 2025) is newer than `gpt-4o`
(November 2024), and the `o` series interleaves with both. Expect an order like:

```
chat-latest > gpt-5.6 > gpt-5.5 > gpt-5.4 > gpt-5.3 > gpt-5.2 > gpt-5.1 > gpt-5
  > o4 > o3 > gpt-4.1 > o1 > gpt-4o > gpt-4-turbo > gpt-4 > gpt-3.5
```

The stopping rule is deliberately not "stop at the first failure": a single failing
model only means the next generation down has to be proven too. The sweep stops when
**every** judged model in one generation fails, and everything older is then recorded as
`assumed failure` — a tier that is explicitly not a measured result. A model marked
`not evaluated` (provider throttling) never counts toward the stopping rule, or a rate
limit could silently truncate the sweep.

Two generations with no ISO-dated snapshot are placed by hand in
`generations.js` (`LEGACY_RELEASES`): `gpt-4`, `gpt-4-turbo` and `gpt-3.5` publish only a
bare `-MMDD` tag whose year is implicit. Without those entries an undated rung is treated
as *newest* — right for `gpt-5.6`, and badly wrong for `gpt-4`, which sorted to the top.

### Local models

Run them **separately, at concurrency 1**:

```bash
node server/test-integration/bakeoff/bakeoff.mjs \
    --url http://localhost:3099 --actions 12 --concurrency 1 \
    --providers ollama --out server/logs/bakeoff-screen-local.json
```

They share one GPU, so running them alongside each other measures contention rather
than capability.

**Why 12 actions and not fewer.** The absurd probe that the judgement dimension is
computed from sits at index 8 (`ABSURD_EVERY = 9`). A screen shorter than nine
actions cannot measure judgement at all and reports it `n/a`.

Combat is excluded below 24 actions (`expectCombat`), because a screen does not
reliably reach a fight and scoring it zero would libel the model.

## Stage 2 — full games for the survivors

20 turns each for a four-player party is `--actions 80`.

```bash
node server/test-integration/bakeoff/bakeoff.mjs \
    --url http://localhost:3099 --actions 80 --concurrency 4 \
    --models claude-opus-5,gpt-5.2,gpt-4o --out server/logs/bakeoff-full.json
```

Keep concurrency modest here: each run holds four sockets and a live lobby for the
whole game, and rate limits bite before the server does.

## Reading the result

`--out` is JSON, ranked by score. Per model you get the dimension breakdown with a
one-line justification each, the blockers, latency median and p90, and a `run` block
naming the lobby id.

**That lobby id is the receipt.** `server/logs/llm-<lobbyId>.jsonl` holds every call
with its raw reply, so any grade can be traced to the text that earned it:

```bash
node -e 'import fs from "node:fs";
  const {classifyCall}=await import("./server/services/bakeoff/journal.js");
  fs.readFileSync("server/logs/llm-<lobbyId>.jsonl","utf8").split("\n").filter(Boolean)
    .map(JSON.parse).forEach((e,i)=>console.log(i,classifyCall(e),(e.response??e.error??"").slice(0,120)));' \
  --input-type=module
```

Do this before believing any surprising result. Both bugs found while building the
rubric were found this way, and both were the rubric's fault rather than a model's.

## Gotchas

- **`grade` and `verdict` are allowed to disagree.** Grade is the weighted score;
  verdict is whether you could run a table on it, and applies blockers and the
  repair cap. A model can grade B and read `marginal`.
- **A screen grade is a floor, not a measurement.** It cannot see context decay,
  history summarisation, or long-run combat drift. Do not quote screen numbers as if
  a full game produced them.
- **`endedBy: "tpk"`** means the party died. The run's requested-turn count is
  rewritten to what it reached, so the model is not charged for the turns that
  became unreachable.
- **`endedBy: "no-opening"`** almost always means the key or model id is wrong
  rather than that the model is bad. Check the journal for an `error` field.
- Every run leaves a lobby in `server/data/lobbies/` and a journal in
  `server/logs/`. A full sweep is tens of megabytes; prune when done.

_Last verified: 2026-07-29 against branch `feature/tactical-map`._
