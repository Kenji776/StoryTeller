# 0016 — The game loop moves onto the credential resolver

**Status:** Accepted (2026-07-27)

Completes [ADR 0001](0001-player-supplied-ai-credentials.md), which specified this
in July and could not land it until the resolver, the vault and the policy model
existed. Retires `server/services/llmService.js`.

## Context

Every model call in the game went through one function, `getLLMResponse(messages,
{provider, model, lobbyId})`, backed by a service that built an OpenAI client and
an Anthropic client **at module load** from `OPENAI_API_KEY` and
`CLAUDE_API_KEY`. Everything ADR 0001 promised — a player's own key, a local
model, a provider the operator had not configured — was blocked on that one fact.

Roughly twenty call sites share that signature, across `server.js`, the turn
timer, the DM-JSON repair passes, `parseDMJson`, the action gate and the newbie
advisor. Two of them run with no client connected at all.

The old service also had a failure contract that ADR 0009 already records as a
design fault: adapters caught their own exceptions and returned an *error string*,
which travelled the same channel as narration. `llmFailure.js` exists to spot
those strings before they are published to players as story.

## Decision

**`services/llmGateway.js` replaces the service behind an unchanged signature.**
No call site moved. What changed is where the credential comes from: the resolver,
which applies the host's key, then the instance's, then a local service, then
refuses (ADR 0014).

**The string-returning failure contract is preserved deliberately, warts and
all.** Converting twenty call sites to handle exceptions, in the same change that
replaces what they call, would make any regression ambiguous. `llmFailure.js`
gains one new sentinel prefix, `[AI unavailable]`, and the gateway and the guard
must stay in step — a sentinel the guard does not recognise is published as story.

**A second, structured channel is added.** `onFailure` receives the real error —
its reason, its kind, whether it is retryable — and `server.js` turns that into an
incident *and* an `ai:unavailable` event to the lobby. A missing key is the host's
to fix, and a sentinel string travelling up the narration path could never tell
them so.

**Legacy provider ids are aliased, not migrated.** Persisted lobbies carry
`llmProvider: "claude"`, which no registry knows. The gateway maps it to
`anthropic`. Rewriting every lobby file on disk would be irreversible and could
corrupt state; an alias cannot.

**Boot no longer validates keys against the providers.** It reports the policy and
probes only local services, which is free. Live validation moved to the admin
console's Test button, which records its result against the key.

**The five purge triggers ADR 0014 specified are wired**: host disconnect, game
end, lobby deletion, hibernation, and a sweep on the existing maintenance interval
— the last being what makes a host's expiry date fire "regardless of game state".

**Portraits are no longer OpenAI-only.** `/api/character-image` asks the capability
view whether *any* image provider is configured, and generation runs through the
image registry, so a local server with no key at all can draw.

## Consequences

**Easier.** Everything ADR 0001 described is now true: a host can bring their own
key, use Ollama, use a local image server, and the operator can run a public
instance holding no credentials at all. A provider failure now reaches the person
who can fix it instead of only the log. `@anthropic-ai/sdk` is no longer a
dependency.

**Harder.** The failure contract is still a string, and it is now the gateway's
job to keep it in step with `llmFailure.js` — a coupling between two modules that
a test pins but a reader could miss. Credential state lives across three stores,
and a model call now touches all of them.

**Behaviour change worth stating plainly.** The boot log no longer says whether a
key *works*, only whether one is configured and what policy applies. An operator
who relied on `✅ OpenAI API key is valid` at startup now gets that from the admin
console instead, on demand. `/api/features` keeps publishing `openai` and `claude`
booleans, but they now mean "a key is configured" rather than "a key was tested
and passed".

## Alternatives considered

**Convert the call sites to handle exceptions properly, fixing ADR 0009's fault
in the same change.** The honest fix, and it is still the right one eventually.
Rejected for this change: twenty call sites and a provider-layer swap in one step
means any regression has two candidate causes. The gateway makes the later fix
smaller, because the structured channel already carries what those call sites
would need.

**Rewrite persisted lobbies to canonical provider ids.** Cleaner than an alias
table that must be carried forever. Rejected: a migration over live state that
cannot be undone, to avoid a four-line lookup, is a bad trade — and a lobby not
opened in months would have to be migrated correctly by code nobody runs often.

**Keep validating keys at boot.** Preserves a log line operators know. Rejected:
it spends real API calls on every restart, its answer is stale the moment a key is
revoked, and it cannot express the thing that now matters — that a provider may be
`byok`, where the instance having a key is irrelevant.

_Last verified: 2026-07-27 against branch `Refactor` (5fcf307)._
