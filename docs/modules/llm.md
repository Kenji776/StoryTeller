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

Provider adapters, the registry, and the credential store are being added in
subsequent phases; this document grows with them.

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
