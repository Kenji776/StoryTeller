# Module: turns, feasibility, and the advisor

Round structure, and deciding whether a proposed action is something the character
could actually attempt.

## Turn order

`rollInitiative` (`lobby/lobbyCombat.js`) rolls `d20 + DEX modifier` per living
player and sorts descending; ties break on DEX modifier, then name, so the order is
total and reproducible. The total is stored as `player.initiativeTotal`.

Both ordering paths share that one key and one comparator. They previously did not:
`startGame` used `Object.keys(s.sockets)` — socket registration order, no roll at
all — while `insertIntoInitiative` sorted by raw DEX score against a list that had
never been DEX-sorted, so a rejoining player reliably landed near the front and
visibly reshuffled the table.

**A returning player keeps the seat they already rolled.** Re-rolling on rejoin
would reshuffle the order under everyone and let a player re-roll a bad initiative
by dropping their connection. Only someone with no roll on record rolls.

`nextTurn` reports `{current, order, round, roundAdvanced}`; the round increments
when the order wraps. A one-player table wraps every turn, which is correct.

## The capability model

`characterCapability.buildCapability(lobby, name)` is the single answer to "what can
this character do right now", and is pure. It exists once because the gate and the
advisor must agree: an advisor that recommends what the gate rejects is worse than
no advisor.

It normalises every legacy shape found in real saved lobbies — bare-string abilities
and inventory entries, conditions arriving either as an array or as a comma-joined
display string with `None`/`Dead` sentinels, `stats` that is not an object.

**It refuses to invent facts.** `max_hp` has four different fallbacks across four
existing consumers (1, 1, 10, 10); rather than add a fifth guess it reports `null`.
A guess laundered into a model prompt reads as truth.

Two properties of this game it reports honestly because they surprise people:

- Every ability — martial and magical alike — spends **one shared pool sized to
  character level**, refilled only by a long rest. A level-1 character has a single
  activation of anything.
- `details.uses` / `recharge` on the class table are read by no code, so per-ability
  budgets and item charges are reported as *untracked*, not as live limits.

## The gate

`actionFeasibility.hardChecks` is pure and answers only what code can answer with
certainty. It is deliberately **lenient**: a false rejection tells a new player their
reasonable idea is impossible, and three of those end their turn, so anything
ambiguous is passed on rather than guessed at. Only genuinely impossible proposals
cost a strike — empty input, being dead and over-long text do not.

`judgeAction` is a cheap model call for the remainder: the absurd, the anachronistic,
the self-declaring ("I win"). It receives the capability digest and **no story
history**, so a poisoned earlier turn cannot influence it, and the player's text goes
in a user message, never the system prompt. It **fails open** on every failure —
error, timeout, unparseable reply, off-contract verdict.

`actionGate` owns the consequences: tell the player, spend one of three chances,
restore the turn clock, forfeit the turn on the third failure. Four modes:

| Mode | Behaviour |
|---|---|
| `off` | allow everything, consult nothing |
| `observe` | form a verdict and log it, allow everything, charge nothing |
| `hard` | enforce the deterministic checks; never spends a model call |
| `judge` | deterministic checks, then the model for anything ambiguous |

Set with `FEASIBILITY_MODE`. **Default is `observe`** — read a real session's
verdicts before letting it tell players no.

## The advisor

`newbieAdvisor` returns 3–4 ranked options in plain language, each naming the ability
or item it uses, what it costs, and the roll it will need. Every suggestion — model-
written or fallback — is run back through **the same `hardChecks` the gate applies**,
so "never suggests something unavailable" is enforced in code, not requested in a
prompt.

It degrades rather than fails: if the model is down, unparseable, or every suggestion
is filtered away, a deterministic set built from the character sheet is offered
instead, always including at least one option that costs nothing. Someone who does
not know what to do is exactly the person who cannot recover from an error message.

Replies go only to the asking socket — they name that character's items, remaining
uses and health.

## Turn clock

`action:submit` cancels the turn timer before it validates, so every early return has
to put it back or the lobby waits forever. `resumeTurnTimer` restores only the time
that remained, so a rejection cannot buy a fresh budget. `startTurnTimer` clears
`turnDeadlineAt` when entering the reading delay — otherwise the field still holds the
previous turn's deadline, already past, and a resume reads it as overdue and expires
the new player's turn instantly.

_Last verified: 2026-07-27 against branch `Refactor`._
