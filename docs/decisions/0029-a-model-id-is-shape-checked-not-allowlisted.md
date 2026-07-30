# 0029 — A model id is shape-checked, not allowlisted

Status: accepted

## Context

`setLLMSettings` deliberately accepts model names it does not recognise. Local and
self-hosted models are named freely — `llama3`, `mixtral`, a path, a build tag —
and refusing the merely unfamiliar would lock an operator out of every provider
whose naming conventions this code happens not to know. That is recorded in
`providerOfModel`'s own comment and is the right call.

The narrator picker then gave that field a way in from the browser. A provider
whose models cannot be enumerated gets a free-text box, and the model in force is
rendered into the lobby options panel — on **every** player's screen, not only the
host's — through `innerHTML`. So a host could store markup and have it execute in
the browser of everyone who joined. A lobby host is not the instance operator;
they are whoever created the game, and strangers join them.

Nothing else stood in the way. The value passed straight from the socket payload
to `s.llmModel` to the page.

## Decision

Validate the **shape** of a model id at the boundary, and keep accepting
unfamiliar names within that shape:

```
/^[A-Za-z0-9._:/@+-]{1,120}$/
```

Escaping in the panel is the second layer, not the first. `escapeHtml` is applied
to every value the panel interpolates, including ones the server does not gate —
provider labels from config, a key's tail, the consent text.

The refusal does not echo the rejected value back into the page.

## Consequences

Easy: a model name from any provider, present or future, still works —
`gpt-4o`, `claude-opus-5`, `llama3:8b`, `meta-llama/Llama-3-70b-instruct`,
`accounts/fireworks/models/mixtral` all pass, and a test names each one so the
guard cannot quietly tighten later.

Hard: a provider that one day names a model with a character outside that set
will be refused until the pattern is widened. The character class is the thing to
change, and the test listing real names is where to prove it still fits.

The 120-character cap is arbitrary but bounded; the longest real id in the
catalogue is well under half of it.

## Alternatives considered

**Allowlist known models.** Refuse anything not in `llm_models.json`. Rejected:
this is exactly the lock-out that `providerOfModel` was written to avoid, and it
would break every self-hosted install the moment it shipped. The catalogue is a
convenience for pickers, never an authority on what exists.

**Escape in the browser only.** Cheaper, and it would have stopped this
particular script from running. Rejected as the sole defence: it leaves invalid
data in the lobby and on disk, every future renderer of `llmModel` has to
remember to escape, and one that forgets reintroduces the whole problem. Bad data
should not be stored (`CQ-6`).

**Render with `textContent` instead of `innerHTML`.** Correct in principle and
what the rest of `app.js` does for text. Rejected here as a full answer because
the panel is built as one template with markup interleaved; converting it is a
larger change than this warranted, and it still would not have stopped the value
being stored. Worth doing on its own terms later.

_Last verified: 2026-07-29 against branch `feature/tactical-map`._
