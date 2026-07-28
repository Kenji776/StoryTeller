# Module: `server/services/images/`

Everything that turns a prompt into a picture. Mirrors `services/llm/` and
`services/tts/`: one descriptor per provider, `fetch` injected, a registry as the
only list of what exists.

Decision: [ADR 0015](../decisions/0015-image-generation-becomes-a-provider-layer.md).

## Layout

| File | Responsibility |
|---|---|
| `registry.js` | The only list of which image providers exist. |
| `providers/localImageServer.js` | The self-hosted server on the operator's network. |
| `providers/openaiImages.js` | OpenAI's image API, with the model ladder. |

## Adapter contract

```js
{
	id, label,
	requiresApiKey, requiresBaseUrl, defaultBaseUrl,
	isLocal,                      // drives the `local` policy default
	keyUrl,                       // where a player obtains a key, or null
	styles,                       // named presets, or [] when the provider has none
	generate({ prompt, config, size, style, seed, batchSize, signal, fetchImpl }),
	probe({ config, signal, fetchImpl }),
	listModels({ config, signal, fetchImpl }),
}
```

`generate` resolves to `{ b64, model, seed, contentType }`. `probe` resolves to a
boolean and **never throws** — a caller asking "is this available" wants an
answer, not an exception. A registry test holds every adapter to this contract,
and asserts the registry is non-empty first so it cannot pass vacuously.

## The local server

Free, private, needs no account. Registered first, because that is what a UI built
from this list offers as the obvious choice.

**Parameters it documents as "leave alone" have no code path at all.** This is the
part most likely to be undone by someone being helpful:

| Never sent | Why |
|---|---|
| `cfg` | The model is distilled for the server's default. Raising it produces burnt, oversaturated output — and the failure is silent, not an error. A value in a request body is one someone can later make configurable; having no path is a stronger guarantee than having a correct default. |
| `steps` | Documented as leave-alone. |
| `negative_prompt` | Has no effect at that cfg. Exposing it would be a control that does nothing. |

Three tests assert each is absent from the payload.

Other behaviour worth knowing:

- **Dimensions are validated here**, against the 256–2048 range and the 16-pixel
  grid, rather than spending a round trip to be told (`CQ-6`). The default is
  896×1152 — portrait, because character art is the only thing this generates.
  The server's own default is square, which is the wrong shape.
- **Requests are serialised server-side.** Parallel calls queue; `batchSize` is
  how to ask for variations.
- **Cold start is 15–22 s** while a checkpoint loads, so client timeouts need to
  be generous.
- **An empty `images` array is a failure**, not an empty portrait.
- **Model discovery is live** (`GET /models`, filtered to `installed`), because
  which checkpoints exist is the operator's business and changes without this
  code changing. A server with no discovery endpoint degrades to an empty list
  rather than reporting itself broken.

### It has no moderation and no authentication

Its own documentation states the model does not refuse prompts and that there is
no moderation layer. Two things follow:

- **The address must never leave a private network.** It goes through
  `services/net/privateUrl.js` at the write boundary, like the speech server
  ([ADR 0006](../decisions/0006-host-configurable-local-tts-address.md)) — with
  more at stake here, since this endpoint would accept anything from anyone who
  could reach it.
- **Players type the prompt.** `client/portraitPrompt.js` hands the player's own
  text to whichever provider is configured, so on this one it reaches an
  unmoderated model. Whether that is acceptable is the operator's policy call.
  What the code does rather than deciding for them: the default model is the
  general-purpose one, the explicit-content one is surfaced in no picker, and
  offering this provider at all is a policy entry that can be set `off` for
  images while Ollama stays on for chat.

## OpenAI

**The model ladder is the interesting part.** A key that can *list* a model cannot
always *call* it — access is granted per organisation and the difference only
appears on a real request — so the adapter walks candidates until one answers and
remembers the winner. `resetPreference()` clears that memo, both for an operator
who has just been granted a better model and so the memo cannot leak between
tests (`TDD-8`).

It stops on **401 and 402**, because a rejected key or an exhausted account is not
fixed by a different model. It deliberately walks past **403**, which is how the
API reports a model this organisation may not call — which is precisely what the
ladder exists to step over. That distinction is on `status` rather than the
coarser `kind`, since `classifyHttpStatus` folds 401 and 403 together.

`listModels` returns the ladder rather than the account's `/models` response: that
list is account-wide, mixes in chat, audio and embedding models, and includes
models that can be listed but not called. Offering it would put entries in the
picker that fail on use.

## Sizes are mapped, not refused

The two providers disagree: the local server takes any multiple of sixteen,
OpenAI takes three fixed strings that differ per model family. A caller asking for
a portrait shape gets a portrait from either — `nearestSupportedSize` picks the
candidate with the closest aspect ratio. Both helpers are exported, because size
rules are the thing a caller is most likely to get wrong.

## Known wart

These adapters reuse `LLMRequestError` and `requestJson` from `services/llm/`. The
failure taxonomy is exactly right for an image API and duplicating it would
guarantee drift, but the name now lies slightly and an image failure reports as an
`LLMRequestError`. Renaming to `ProviderRequestError` touches six chat adapters,
two speech adapters, and their tests — worth doing, deliberately not done in the
same change that introduced this layer.

## Testing

`npm test` — 71 tests, no network and no key. `fetch` is a double that records its
calls, which is how the never-send rules are asserted at all.

## Not yet wired

Nothing calls this. `/api/character-image` still routes through
`services/llmService.js` and its module-load OpenAI client. Connecting them is the
same phase that retires that file.

_Last verified: 2026-07-27 against branch `Refactor` (501aaee)._

## Keeping a hero looking like themselves

The server stores a *character*: a reference portrait plus a remembered
appearance. Posing one feeds that portrait back through the model, so the same
face comes out in a new scene. Reusing prompts or seeds does **not** achieve this
— it produces a different face every session.

```
portrait generated ──► createCharacter ──► chr_xxx stored on the player record
                                              │
epic battle ends ─────────────────────────────┴──► generateForCharacter({ scene })
```

**`generateForCharacter` takes no `prompt` parameter at all.** Restating
appearance inside a scene is the documented cause of drift, so rather than
documenting "don't", there is no argument through which a caller could. Same
reasoning as `cfg` above.

`characterRecords.js` owns the two decisions either side of the API:

- **`characterPlan`** — reuse the stored likeness, or mint a new one. Case and
  whitespace differences are not changes; a sheet re-saved with a stray space
  must not throw away a working face. A genuine change returns the old id as
  `retire`, because the API cannot edit a likeness and an orphan the game no
  longer references is just litter. A stored id with *no* remembered appearance
  predates this feature and is rebuilt rather than trusted.
- **`sceneFor`** — trims, folds in a mood, and strips the character's own name.
  The server already knows who this is; a name in the scene reads as a second
  person in the frame. Whole words only, so a character called "Shallow" does not
  turn "shallows" into "s".

`buildAppearance` in `client/portraitPrompt.js` is what gets stored — the sheet's
permanent traits with **no rendering style**. A stored description carrying
"dramatic cinematic lighting" would fight the `style` preset on every future
scene, which is another way faces drift.

### Party scenes are one image per hero

`POST /api/party-scene` draws each character separately and broadcasts the set.
Continuity is per character — one likeness per generation — so a single group
shot would be a nice picture of strangers. Characters with no stored likeness are
skipped rather than drawn wrong, and the requests run sequentially because the
server processes one at a time anyway; firing them in parallel only queues them
and makes a failure harder to attribute.

### A provider without continuity still works

OpenAI's image API has no character concept. `ensureCharacterImage` falls through
to a plain generation there and returns `characterId: null`, so the caller stores
nothing it cannot use. The portrait appears; it simply carries no promise that
the next one matches.
