# Module: `server/services/llm/`

The provider-agnostic AI layer. Every model call in StoryTeller goes through
here; no other module constructs a provider client or reads a provider key.

Credentials are supplied per lobby by the host's browser
([ADR 0001](../decisions/0001-player-supplied-ai-credentials.md)) and adapters
speak HTTP directly rather than through vendor SDKs
([ADR 0002](../decisions/0002-fetch-based-provider-adapters.md)).

## Layout

| File | Responsibility |
|---|---|
| `config.js` | Validates and canonicalises an untrusted AI configuration; redacts it for logging. |
| `errors.js` | `LLMRequestError` and the status→kind classification behind it. |
| `http.js` | The one place a request is issued and a failure is mapped. `fetch` is injected. |
| `registry.js` | The only list of which providers exist. Resolves an id to an adapter. |
| `providers/openai.js` | OpenAI chat completions and model listing. |
| `providers/anthropic.js` | Anthropic Messages API and model listing. |

The credential store and the remaining adapters (Google, Ollama,
OpenAI-compatible) arrive in later phases; this document grows with them.

## Adapter contract

Every provider exports one descriptor. Adding a provider means writing one file
and adding a line to `registry.js` — nothing else in the system needs to change.

```js
{
	id, label,                    // identity
	requiresApiKey,               // drives config validation and the UI
	requiresBaseUrl,
	defaultBaseUrl,               // pre-filled, overridable
	supportsImages,               // eligible as an image provider
	keyUrl,                       // where a player obtains a key
	chat({ messages, config, model, json, temperature, maxTokens, signal, fetchImpl }),
	listModels({ config, signal, fetchImpl }),
}
```

`chat` resolves to `{ text, model, finishReason, usage }` and rejects with an
`LLMRequestError`. `listModels` resolves to `[{ id, label }]`, newest first —
this is what populates the model dropdown, replacing the hardcoded lists that
used to be duplicated between the settings menu and the admin panel.

`fetchImpl` is a parameter on both, which is what makes the adapters testable
without a network or a key.

### What the adapters normalise away

The differences between providers are absorbed here rather than leaking into the
game loop:

- **Anthropic takes `system` as a top-level parameter**, not a message role, and
  requires `max_tokens` (defaulted to 4096, matching previous behaviour).
- **Anthropic requires alternating user/assistant turns**, which StoryTeller
  cannot guarantee — several players can act before the DM replies, and a lobby
  resumed from history may open on the DM's last narration. Consecutive turns
  from one role are merged and a leading `(begin)` user turn is inserted when
  needed, rather than letting a 400 land mid-game.
- **Anthropic replies in content blocks.** All text blocks are concatenated;
  taking only the first would truncate a long narration mid-sentence.
- **`json: true` is a no-op for Anthropic**, which has no response-format
  parameter. JSON steering for that provider lives in the prompt.
- **OpenAI's model list is account-wide** and mixes in embeddings, audio, and
  image models. Those are filtered out; offering them in a DM picker would
  guarantee a confusing failure at the first turn.
- **OpenAI constrains the message `name` field** to letters, digits, underscore,
  and hyphen, capped at 64 characters. Anthropic has no `name` field at all, so
  it is stripped there.

## Configuration contract

`normalizeLLMConfig(raw, provider)` is the boundary. It runs **once**, when a
configuration arrives from a browser, and everything downstream may assume its
output is well-formed (`CQ-6`).

```
{ providerId: string, apiKey: string|null, model: string|null, baseUrl: string|null }
```

The rules worth knowing, because they are load-bearing rather than incidental:

- **Unknown fields are dropped.** The result contains exactly the four keys
  above. Whatever else a browser sends cannot ride along into a log or into
  persisted lobby state.
- **`model` may be null; `model: ""` is an error.** The configuration flow is
  pick provider → enter key → *list models* → pick model, so listing has to work
  before a model exists. But a blank model means the UI failed to populate its
  dropdown, which is a bug worth surfacing rather than a default worth guessing.
- **`baseUrl` must be `http`/`https` and loses its trailing slashes.** The URL is
  player-supplied and the server fetches it, so `file://` and friends are refused
  outright. Adapters build paths by concatenation, so a trailing slash would
  produce a double slash and a 404 on strict gateways.
- **Errors name the offending field.** `LLMConfigError.field` lets the UI
  highlight the right input instead of showing a generic failure.

`redactLLMConfig(config)` is the only safe way to put a configuration into a log
line. Keys of nine characters or more show their last four so an operator can
tell *which* key was in play; anything shorter is masked entirely (`STY-3`).

## Failure contract

`LLMRequestError` classifies every provider failure into a `kind`:

| Kind | Meaning | Retryable |
|---|---|---|
| `auth` | Key rejected (401/403) | no |
| `quota` | Out of credit (402) | no |
| `rate_limit` | Too many requests (429) | yes |
| `not_found` | Unknown model or endpoint (404) | no |
| `bad_request` | Malformed request (400/422) | no |
| `server` | Provider-side fault (5xx) | yes |
| `network` | Transport failed, no response | yes |
| `bad_response` | 2xx body was not JSON | no |
| `unknown` | Anything else | no |

`err.retryable` drives whether the game loop tries again; `err.userMessage()`
produces player-facing copy that names the provider and the corrective action.
`userMessage()` scrubs token-shaped substrings, because provider error bodies
occasionally echo the submitted key back and that text reaches a player's screen.

## Testing

Unit tests are colocated (`config.test.js`, `errors.test.js`, `http.test.js`) and
need no network or key: `requestJson` takes `fetchImpl` as a parameter and tests
pass a fake that records its calls. Run `npm test`.

_Last verified: 2026-07-27 against branch `Refactor` (634b6c1)._
