# 0002 — Provider adapters call HTTP directly instead of using vendor SDKs

**Status:** Accepted (2026-07-27)

## Context

[ADR 0001](0001-player-supplied-ai-credentials.md) makes credentials per-lobby
and runtime-supplied. The existing code constructs `new OpenAI({apiKey})` and
`new Anthropic({apiKey})` once at module load from environment variables — a
shape that cannot express "a different key per lobby, supplied after boot".

Whatever replaces it must also support five provider families, three of which
(Google, Ollama, arbitrary OpenAI-compatible gateways) have no SDK in the project
today, and must be unit-testable without a network or a real key (`TDD-8`).

## Decision

Provider adapters are hand-written against each provider's HTTP API using
`fetch`, sharing one injectable request helper (`server/services/llm/http.js`).
`fetch` is passed in as a parameter rather than reached for as a global.

The `openai` and `@anthropic-ai/sdk` dependencies are dropped once the adapters
reach parity, including the DALL·E image-generation path.

## Consequences

**Easier.** One uniform code path for all five providers instead of two SDK
idioms plus three hand-rolled ones. Per-request credentials are natural — there
is no client object to construct or cache. Unit tests inject a fake `fetch` and
assert on the exact request body, so adapter behaviour is pinned without a
network, a key, or SDK-specific mocking. Two dependencies and their transitive
trees leave the project, which is a supply-chain reduction. Error handling is
consistent, because every failure flows through one mapper.

**Harder.** We now own the request shapes. Provider API changes that an SDK
upgrade would have absorbed become our maintenance: Anthropic's required
`max_tokens`, its separate `system` parameter, OpenAI's `response_format`, and
each provider's model-listing endpoint are all now hand-maintained. Newer
features — streaming, tool use, prompt caching — would each need writing rather
than being available on the client object. Streaming in particular is a plausible
future want, and this decision makes it more work.

**Neutral.** Nothing about the request shapes used here is exotic; they are the
documented, stable chat-completions surfaces of each provider.

## Alternatives considered

**Keep the SDKs, construct a client per request.** Both SDKs support this, and it
preserves SDK-maintained request shapes. Rejected on balance: it still leaves
three providers without an SDK, so a `fetch` path is required regardless, and
maintaining both idioms is worse than maintaining one. Testing would also mean
mocking two different client surfaces rather than one `fetch`.

**Keep the SDKs and reach the other three through their OpenAI-compatible
endpoints.** Fewer adapters, but Gemini's compatibility layer and Ollama's are
both partial, and model listing in particular differs. Rejected: it trades
honest adapter code for silent behavioural gaps.

**Adopt a routing library (LangChain, LiteLLM, Vercel AI SDK) to abstract
providers.** Solves the problem wholesale and adds streaming for free. Rejected:
a large dependency and a large abstraction for what amounts to five POST
requests, and it would require a supply-chain review disproportionate to the
benefit. Revisit if streaming and tool use both become requirements.

_Last verified: 2026-07-27 against branch `Refactor` (634b6c1)._
