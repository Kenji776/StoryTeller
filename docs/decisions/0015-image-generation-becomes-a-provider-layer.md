# 0015 — Image generation becomes a provider layer, with a local server first

**Status:** Accepted (2026-07-27)

Applies to images what [ADR 0002](0002-fetch-based-provider-adapters.md) did for
chat and [ADR 0005](0005-pluggable-tts-with-a-local-server.md) did for narration.

## Context

Portrait generation was a single function in `services/llmService.js` that reached
for an OpenAI client constructed at module load from `OPENAI_API_KEY`. Three
things follow from that and all three are now wrong:

- **Only OpenAI could ever draw.** A player using Anthropic as their DM had no
  portrait provider at all, and `/api/character-image` gated on `hasOpenAI()`.
- **Only the operator could pay.** The key was ambient, so a player's own
  credential could not be used even once the rest of the system supported it.
- **There was nowhere to put a second generator.** A self-hosted image server is
  now available on the operator's network — free, private, and needing no
  account — and there was no seam to add it at.

The self-hosted server is a ComfyUI-backed HTTP service. Probing its documented
contract establishes what has to be accommodated:

| | Local server | OpenAI |
|---|---|---|
| Credential | none — an address | an API key |
| Sizes | any multiple of 16, 256–2048 | three fixed strings, differing per model family |
| Style control | named presets (`fantasy-portrait`, …) | prompt text only |
| Concurrency | serialised; parallel calls queue | parallel is fine |
| Cold start | 15–22 s while a 12 GB checkpoint loads | none |
| Moderation | **none** | provider-side |

## Decision

Image generation moves to `server/services/images/`: one descriptor per provider,
`fetch` injected, a registry as the only list of what exists. The local server is
registered first, because it is the option that costs nothing and needs no
account, and first is what a UI built from this list offers as the obvious choice.

**Parameters the local server documents as "leave alone" have no code path.**
`cfg` is the one that matters — the model is distilled for the server's default
and raising it produces burnt output — so rather than sending a correct default,
the adapter has no way to send it at all. `steps` and `negative_prompt` follow the
same rule; the latter has no effect at that cfg, so exposing it would be a control
that silently does nothing. Three tests assert each is absent from the payload.

**Sizes are mapped, not refused.** A caller asking for a portrait shape gets a
portrait from either provider: the local adapter validates against the 16-pixel
grid, and the OpenAI adapter picks the supported string with the closest aspect
ratio from the right family.

**The OpenAI model ladder is preserved and moved onto `fetch`.** A key that can
*list* a model cannot always *call* it, because access is granted per
organisation, so the adapter walks candidates until one answers and remembers the
winner. It stops on 401 and 402 — a rejected key is not fixed by another model —
but deliberately walks past 403, which is how the API reports a model this
organisation may not call.

**The local server's address goes through the private-network guard**
(`services/net/privateUrl.js`), like the speech server before it. This endpoint
has no authentication at all, so the consequence of an unvalidated address is
worse here than anywhere else in the system.

## Consequences

**Easier.** Portraits work without an OpenAI account, and without any account.
Adding a third generator is one file and one registry line. The credential path is
the same one chat and narration use, so a player's own key, the operator's shared
key, and a local service are all already handled by `credentials/resolve.js`. Both
adapters are testable without a network, which the old function was not.

**Harder.** There are now three provider layers with near-identical shapes, and a
change to the adapter contract has three places to land. The two image adapters
disagree about almost everything except "prompt in, base64 out", so the normalised
surface is thin and callers wanting style presets have to know they are talking to
the local server.

**Known wart.** The image adapters reuse `LLMRequestError` and `requestJson` from
`services/llm/`. The failure taxonomy — auth, quota, rate limit, network, server —
is exactly right for an image API, and duplicating it would guarantee drift. But
the name now lies slightly, and an image failure reports as an `LLMRequestError`.
Renaming it to `ProviderRequestError` touches six chat adapters, two speech
adapters, and their tests; it is worth doing and is deliberately not being done in
the same change as introducing the layer.

## The thing an operator has to decide

**The local server has no moderation and no authentication.** Its own
documentation states the model does not refuse prompts, including NSFW, and that
there is no moderation layer.

StoryTeller lets players edit their portrait prompt — `client/portraitPrompt.js`
hands the player's own text to whichever provider is configured. On this provider,
that text reaches an unmoderated model. In a multiplayer game with strangers, that
is a product decision rather than a technical one, and it is the operator's to
make.

What this decision does, rather than deciding it for them: the default model is
the general-purpose one and the explicit-content one is not surfaced in any
picker; the server is reachable only from a private network; and the choice of
whether to offer this provider at all is a policy entry like any other, so an
operator can set it `off` for images while leaving Ollama on for chat.

## Alternatives considered

**Keep portraits OpenAI-only and add the local server as a special case.** Less
structure for one more provider. Rejected: the special case would need its own
credential path, its own availability probe, and its own admin control, all of
which the provider layer already gives every generator for free.

**Send the local server's documented defaults explicitly, for clarity.** Reads
better and makes the request self-describing. Rejected for `cfg` specifically: a
value in a request body is a value someone can later make configurable, and the
failure mode is silent — burnt images rather than an error. Having no code path is
a stronger guarantee than having a correct default.

**Use the local server's `?raw=1` mode to skip the base64 round trip.** Cheaper,
and the endpoint offers it. Rejected for now: the existing portrait pipeline is
base64 end to end, from `generateCharacterImage` through to the `Buffer.from`
that writes the file, and changing the transport and the provider layer in one
step would make a failure ambiguous. Worth revisiting if payload size bites.

**Expose the LoRA controls in the UI.** The server supports fine-grained style
adapters. Rejected as premature: the named presets already apply the right
adapters and prompt suffixes, and a combined-strength rule that "washes out the
prompt above ~2.0" is not something to put in front of a player mid-character-
creation.

_Last verified: 2026-07-27 against branch `Refactor` (501aaee)._
