# 0023 — A quest reward is read from both sides of the table

Status: accepted

Extends: [0017](0017-loot-is-rolled-by-the-server.md)

## Context

ADR 0017 took loot away from the narrator and gave it to `services/loot.js`, on the
evidence that a model mid-prose cannot say no: six of six loot-seeking turns paid out,
and two of three turns where the roll had *failed* paid out anyway.

It did not take quest rewards. `detectLootMoment` recognised `trash`, `elite`, `boss`,
`cache` and `search`, and nothing else, so when an NPC thanked the party and settled up
the narrator invented the gold and the item directly — exactly the behaviour 0017
removed everywhere else. `loot-tables.json` and `SOURCE_PROFILE` have carried a `quest`
source since 0017 (100% item, 90% gold, rarity biased up, exempt from search
exhaustion); nothing ever emitted it.

The obvious fix — widen the regex over the player's action — does not work, and it is
worth being precise about why, because it is the same class of trap as the `cast` idiom
list in `actionFeasibility.js`.

- **The player's words are not sufficient.** "I hand over the amulet to the elder" and
  "I hand over my sword to the guard" are the same sentence. "I accept the reward" and
  "I accept the challenge" differ by one noun, and "I reward myself with a drink" names
  a reward and receives nothing. What separates them is not in the action at all — it is
  in what an NPC said on the previous turn.
- **The two mistakes are not symmetric here, unlike every other source.** 0017 could be
  relaxed about detection precisely because a spurious `search` usually finds nothing —
  18% item, 30% gold. `quest` pays an item on *every* roll with the rarity table biased
  up. A false positive is not a wasted turn; it is a free rarity-biased item minted out
  of a sentence, and the player learns to type the sentence.

## Decision

`detectLootMoment` takes the lobby's `history` and reads the narrator's most recent turn
alongside the player's action. It returns `{ source: "quest" }` only when three
conditions hold together:

1. The newest `assistant` entry uses reward language — *reward*, *payment*, *wages*,
   *bounty*, *as we agreed*, *for your trouble*, *earned*, *owes you*. The prose is
   unwrapped from the raw JSON reply `appendDM` stores, as `autoSummarize` already does.
2. The player is collecting (a receiving verb aimed at a named reward) or delivering
   ("I turn in the quest", "I hand over the amulet", "I deliver the letter").
3. None of four vetoes fire: refusing it, paying it out, rewarding *yourself*, or going
   through a corpse — which stays `trash`/`elite`/`boss` however warmly the elder spoke.

The check sits after the named-container branch, so a chest the player is opening still
wins, and before `NOT_A_CONTAINER`, so "I accept the reward with a full heart" is not
read as searching somebody's heart. Omitting `history` disables the branch entirely, so
every other source is decided from `action` exactly as before.

The DM prompt's carve-out for "the agreed reward for a completed job", which sat beside
shops and wagers, is withdrawn.

## Consequences

The last channel through which the narrator sized a reward is closed, and `quest` — the
best-paying entry in the table — is reachable for the first time.

Detection is deliberately narrow and will miss turn-ins: an NPC who says only "the job's
done, see the quartermaster" offers nothing the first condition can see. **A miss now
costs the party the reward, not merely the roll**, because the prompt no longer permits
the narrator to invent one. That is the opposite trade from every other source, where a
miss costs nothing, and it is the reason detection demands two agreeing signals rather
than a wider regex: widening it trades a recoverable miss for an unrecoverable exploit.

Reading `history` makes the detector's verdict depend on lobby state rather than the
action alone. It stays pure — `history` is an argument, the extraction is a pure
function of the array, and every case is unit-testable with a literal.

`return` and `present` are not accepted as hand-over verbs, and *treasure*, *loot* and
*gold* are not accepted as reward nouns. Both refusals cost recall and both are
deliberate: the first cannot be separated from "I return to the tavern", and the second
would let `quest` capture turns that belong to `cache` and `search`.

## Alternatives considered

**Match the player's action alone, more broadly.** Rejected on the asymmetry above. The
phrasings that are unambiguous on their own ("I claim the bounty") are a small subset of
real turn-ins, and every widening step admits a sentence a player can type deliberately
to mint a guaranteed item.

**Scan several of the narrator's recent turns for an offer.** Rejected. It raises recall
for the case where an offer is made, discussed, then accepted — but an offer stays
matchable for as long as it is in the window, so one reward pays out repeatedly. The
newest turn is the one the player is actually answering.

**Ask the model whether this turn is a quest hand-over, as `judgeAction` does.** The
only approach that genuinely understands the fiction, and the honest answer to "what
would work better than a regex". Rejected *for now* on cost and latency: it is a second
blocking call on the critical path of every turn, to reach a source that comes up a
handful of times per campaign. If the miss rate proves to matter in play, this is the
upgrade — and unlike a wider regex it does not trade a miss for an exploit.

**Let the DM declare the quest reward in its reply and roll afterwards.** Rejected for
the reason 0017 gave: narration and updates come back together, so the roll would land
after the prose was written.

_Last verified: 2026-07-28 against branch `Refactor` (6a2adfb)._
