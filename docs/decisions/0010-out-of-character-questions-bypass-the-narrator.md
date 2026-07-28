# 0010 — Out-of-character questions bypass the narrator

Status: accepted

## Context

The server had no concept of an out-of-character question. Anything a player typed
was an action.

So "ooc how do spell slots work in this game?" was composed into the full Dungeon
Master prompt and answered in the voice of the DM. The answer was a textbook 5e
lecture — spell slots by character level, slot levels, recovery on a long rest —
describing a system this game does not have. This game has one shared pool covering
every ability, martial and magical alike, sized by a host setting.

Four things then went wrong at once:

1. The lecture was broadcast to **every** player as story narration.
2. It was appended to the history the DM is re-prompted with, so rules that
   contradict this lobby became part of the narrator's own context for every
   subsequent turn.
3. It consumed the asker's turn.
4. It overwrote the whole table's action suggestions mid-turn.

An operator watching the activity log saw the DM begin lecturing about 5e spell
slots for no visible reason, because the question that prompted it was never
broadcast either — see the `player:action` change in the same series.

The people most likely to ask are the people this application is for. A newcomer
who asks what they can do should not lose their turn and mislead the table for it.

## Decision

Recognise `ooc`, `//` and `((…))` at the **start** of a submission and divert it
before any turn machinery runs: no clock cancelled, no table locked, no history
written, no turn consumed.

Answer it with a dedicated prompt that states this game's actual rules, carries the
asker's own sheet so the answer uses their real numbers, and says explicitly that
this is not narration. Reply on `ooc:reply` to the asking socket alone.

Detection is anchored to the start of the message. "I occupy the doorway" is an
action, and diverting it would be a worse failure than missing an occasional
question.

## Consequences

A rules question is now free and private. The narrator never sees it, so it cannot
pollute the story history or the table's screen.

The turn clock keeps running while a player asks. This is deliberate for now — a
question should not cost the turn, but nor should it be a way to stop the game — and
it may want revisiting if newcomers find it stressful.

Two prompts now describe the ability pool: the DM's party block and this one. They
draw on the same `buildCapability`, but the prose is written twice and could drift.

## Alternatives considered

**Teach the DM prompt to answer rules questions correctly.** Rejected. It keeps the
answer in the narration channel, which is what broadcast it to the table and wrote
it into history. It also spends a full DM prompt — scene, party, enemies, history —
on a question that needs none of it.

**Route to the existing newbie advisor.** Tempting, and the advisor already knows
the real rules. Rejected because the advisor answers "what should I do now" with
scored, filtered action options; a question like "what does poisoned do" has no
action to suggest, and forcing it through that shape would have produced worse
answers than a plain sentence.

**Handle it entirely client-side from static rules text.** Rejected: the answers
worth giving are specific to the asker's current sheet ("you have two uses left, and
Second Wind is one of them"), which the client would have to reimplement.

_Last verified: 2026-07-27 against branch `Refactor`._
