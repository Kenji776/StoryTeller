# 0009 — A failed model call is never published as narration

Status: accepted

## Context

Both provider adapters in `llmService` catch their own exceptions and return an
error *string*:

```js
} catch (err) {
    console.error("💥 [OpenAI] LLM call failed:", err);
    return "[Error: LLM unavailable or failed to respond]";
}
```

That string travels the same channel as real narration, so nothing downstream can
distinguish a dead provider from a quiet scene.

A lobby opened against a provider whose key was invalid. The result was published
to all three players as the opening narration, stored as the adventure's *name*,
appended to the durable story log, and echoed on the debug channel. The turn timer
then started on top of it, and play continued — turn after turn of
"[Error: LLM unavailable or failed to respond]" as the entire story. No incident
was raised, nothing was retried, and the only trace was a stack trace in the server
console.

The compounding failure is worse than the display: `appendDM` writes narration into
the history that later prompts are built from, so the error text became part of the
DM's own context for every subsequent turn.

## Decision

Add `isLLMFailure(reply)` and check it at both sites that publish narration — the
opening and the per-turn response.

On failure: raise an incident (so it reaches the admin console and the operator),
toast the players in plain language, unlock the UI, and return without narrating,
without appending to history, and without consuming the turn. A failed opening
returns the lobby to `waiting` so the host can fix the setting and start again,
rather than stranding it in `running` with no story.

The sentinels are matched exactly. A loose test on "error" or "unavailable" would
swallow real narration — characters make errors, and bridges are unavailable.

## Consequences

A provider outage is now visible as an outage. Players are told the DM is not
responding instead of reading it as prose, and the operator gets an incident naming
the provider and model.

Turn cost is not consumed by a failure, so a transient outage costs a retry rather
than a turn.

`isLLMFailure` is a guard, not a repair: the adapters still return sentinels, and a
caller that forgets to check still publishes one. Two call sites are covered; the
summariser, advisor and JSON-repair paths still take the strings at face value.

## Alternatives considered

**Make the adapters throw instead of returning a sentinel.** This is the correct
fix and remains the intended destination. Rejected *for now* only because it changes
the contract for every caller — the turn path, setup, the summariser, the advisor,
the feasibility judge, and `parseDMJson`'s repair pass — each of which currently
assumes a string and would need its own handling. That is a phased refactor
(`PW-2`), not a change to make while a game is running. Recorded here so the next
session knows the sentinel check is scaffolding around a known design fault.

**Retry automatically on failure.** Rejected as the first move: the observed failure
was an invalid API key, which no number of retries fixes, and retrying would have
turned one clear error into a slow silent stall. Retry is worth adding for
timeouts specifically, where it would help.

**Show the raw error to players.** Rejected. It is already what happened, and it is
what this ADR exists to stop. Players get a plain-language toast; the provider and
model go to the incident, which is admin-facing.

_Last verified: 2026-07-27 against branch `Refactor`._
