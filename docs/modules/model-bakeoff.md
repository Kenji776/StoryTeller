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

## Testing

Unit tests are colocated and need no network or key — `npm test`. The integration
side is deliberately excluded from the default run; see
[testing.md](../testing.md) and
[runbooks/run-a-model-bakeoff.md](../runbooks/run-a-model-bakeoff.md).

_Last verified: 2026-07-29 against branch `feature/tactical-map`._
