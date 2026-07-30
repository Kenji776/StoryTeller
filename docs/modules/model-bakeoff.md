# Module: `server/services/bakeoff/`

Answers one question: **which models can actually be the brains of this game?**

The scoring half lives here and is pure — no network, no clock, no filesystem — so
the whole rubric is unit-testable without spending a token. The half that drives
real games over real sockets lives in `server/test-integration/bakeoff/`, because
it needs a live server and costs money.

## Why a bake-off exists at all

A model that writes beautiful prose and cannot close a JSON brace is worthless
here. The game loop consumes a structured object (`helpers/parseDMJson.js`) and
applies it to HP, XP, inventory, initiative and the enemy roster. Everything the
players see is downstream of that object being well formed. So "is this model any
good" is not a question about writing — it is a question about protocol
compliance, and it has a measurable answer.

## Layout

| File | Responsibility |
|---|---|
| `dmReply.js` | The structural verdict on one raw reply: did it parse, did it parse *cleanly*, does it carry the required keys and types, did markup or JSON leak into the narration. |
| `runGame.mjs` (integration) | Drives one real game over sockets for one model. Returns counters, not a grade. |
| `bakeoff.mjs` (integration) | Discovers candidates, plays them through a concurrency pool, grades and ranks. |
| `combatTrace.js` | Whether a sequence of replies behaved like a fight — the five ways combat breaks while the JSON stays valid. |
| `journal.js` | Reads `logs/llm-<lobbyId>.jsonl` into evidence, classifying each call so repairs and titles are counted but never graded. |
| `candidates.js` | Which of a provider's catalogue is worth a game: rejects non-chat endpoints, collapses dated snapshots onto their alias. |
| `actionScript.js` | The deterministic player input every model faces, so two grades can be compared. |
| `scoreRun.js` | Weighs the dimensions into a score, a letter grade, and an operational verdict. |

## The distinction the whole rubric turns on

`parsed` and `cleanParse` are separate, and conflating them is the mistake that
would make this report useless.

`parseDMJson` rescues a fenced or prose-prefixed reply through five escalating
stages, and **two of those stages spend another model call**. A model that is only
ever rescued is playable in the sense that nothing crashes, and unusable in the
sense that every turn costs double and arrives late. Scoring it alongside a model
that gets it right first time would recommend something nobody should pay for.

Hence two outputs, deliberately allowed to disagree:

- **grade** (A–F) is mechanical — the weighted dimensions. How good was the output.
- **verdict** (`recommended` / `usable` / `marginal` / `unusable`) is operational —
  could you run a table on it. It applies **blockers** (a fatal flaw a weighted
  average would absorb) and a **repair cap** (below 50% clean parses nothing is
  better than `usable`; below 25%, nothing beats `marginal`).

A model can therefore grade B and read `marginal`. That is the honest answer.

## Two ways to mark a model down for nothing

Both were found by running the rubric against a real game and reading the evidence,
and both flattered nothing — they penalised every model equally for behaviour that
has no consequence:

- **The opening scene is asked for a different schema.** `buildOpeningPrompt` requests
  four keys (`text`, `music`, `sfx`, `suggestions`); there is no combat, no state to
  update and nothing to roll before anyone has acted. Judging it against the
  nine-key turn schema charged every model for obeying its instructions. It is now
  classified as its own call kind and graded against `OPENING_KEYS`.
- **An omitted nullable key is not a missing key.** `roll` and `music` are declared
  `X | null`, and every reader in the game loop does a falsy check, so omitting the
  key is byte-identical in behaviour to sending `null`. `combat_over` is *not*
  nullable and its absence is still counted, because the server genuinely cannot tell
  whether to purge the roster without it.

## Dimensions

| Dimension | Weight | What it measures |
|---|---|---|
| `jsonDiscipline` | 30 | `0.6 × parse rate + 0.4 × clean-parse rate`. |
| `schemaConformance` | 20 | Required keys present and correctly typed, averaged over parsed turns. |
| `combatLifecycle` | 20 | Severity-weighted combat violations per combat turn. |
| `stateEvents` | 10 | Do HP/XP/inventory entries carry the fields the appliers read. |
| `judgement` | 10 | Absurd actions refused, minus **3×** the rate of plausible ones wrongly refused. |
| `narrationHygiene` | 5 | Markdown and raw JSON staying out of the prose. |
| `reliability` | 5 | Turns completed, stalls, provider errors. |

Weights renormalise over whatever a run could measure, so a screen that never
reaches a fight is not punished for it (`applicable: false`).

Two weightings are deliberate rather than incidental:

- **A false rejection costs three misses.** `actionFeasibility.js` states the
  asymmetry: refusing a reasonable idea tells a new player their idea was
  impossible, and three of those end their turn. Letting an absurd action through
  merely produces a silly beat.
- **`unresolved` combat is discounted to a quarter.** A run truncated by its own
  turn budget produces it innocently; the other four violations are always the
  model's fault.

## Combat violations

Each is separately fatal to play, and all five occur with perfectly valid JSON:

| Kind | What happens in the game |
|---|---|
| `prematureEnd` | `combat_over: true` with enemies up. The server purges the roster, so the fight ends mid-swing and nobody is struck back. |
| `oneTurnWipe` | A fight introduced and finished in one reply. This is what made the adventure riskless. |
| `rosterDrop` | Enemies stop being listed while the fight is live. The roster is rebuilt from the array each turn, so the creatures cease to exist. |
| `missingVerdict` | `combat_over` unreadable during a fight; the server cannot tell whether to purge. |
| `unresolved` | The run ended with enemies up. |

`rosterDrop` is checked before the "was there a fight this turn" guard, and that
ordering is load-bearing: it is the one violation *defined by absence*, so gating
it on enemies being present would make it undetectable.

## Blockers

A blocker forces `unusable` no matter what the score says:

- fewer than 95% of replies parse — the game loop cannot run;
- mean schema conformance below 50% — the appliers get too little to work with;
- fewer than 80% of requested turns completed.

## What the results drive

The verdicts are not just a report. `writeRatings.mjs` turns them into
`client/config/model_ratings.json`, which two places read:

| Reader | Effect |
|---|---|
| `client/modelRatings.js` | Badges every option in both model pickers — the host's narrator panel (`client/app.js`) and the admin console (`client/admin/sections/model.js`) — and orders good models first. |
| `server/services/llm/defaults.js` | Supplies the model a brand-new lobby starts on, when the environment does not name one. |

Two rules in the badge mapping, both about not overclaiming:

- **A thin sample is a caution, not a condemnation.** `claude-opus-5` failed on 1 of 16
  turns, which is a real defect and not an established frequency, so the badge quotes
  the evidence rather than telling a host the flagship does not work.
- **Untested is not broken.** A model the provider throttled, or one released since the
  last sweep, carries no claim at all and gets no mark.

The marks are text (`★ recommended`, `✓ known to work`, `⚠ use with caution`,
`✕ known not to work`) rather than colour, because a native `<select>` renders its
options as plain strings on most platforms — a CSS class would be invisible at exactly
the moment someone is choosing.

### The default, and the one figure that is not measured

`chooseBestValue` (`value.js`) picks it, ordering lexicographically rather than blending
a single figure, because the inputs are not commensurable and a formula would hide its
assumptions: **correctness is a gate**, then banded score, then price, then latency. A
model that cannot run the game is never the default however cheap, and neither is one
whose evidence is a thin sample.

**Price is hand-maintained and cannot be generated.** Nothing in any provider API
reports it, so it lives in `server/data/model-prices.json`. An absent price counts as
*unknown*, never as free — otherwise every unpriced model would be the cheapest thing on
offer and win by default. As of the July 2026 sweep only two OpenAI figures are filled
in, both from general knowledge rather than a pricing page, which is why
`pricesVerifiedOn` is null and the current pick is `gpt-4o-mini`: the cheapest model
whose price is actually known *and* which scored 100/100. Filling in `gpt-5.4-nano` or
`gpt-5.6-luna` may well change the answer.

An explicit `DEFAULT_LLM_PROVIDER` / `DEFAULT_LLM_MODEL` always wins. Silently
overriding an operator's stated choice would be worse than a stale default.

## Testing

Unit tests are colocated and need no network or key — `npm test`. The integration
side is deliberately excluded from the default run; see
[testing.md](../testing.md) and
[runbooks/run-a-model-bakeoff.md](../runbooks/run-a-model-bakeoff.md).

_Last verified: 2026-07-29 against branch `feature/tactical-map`._
