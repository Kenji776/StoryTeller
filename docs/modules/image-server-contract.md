# The image server contract

What an HTTP service must implement to be usable as StoryTeller's `local-image` provider.

Written because none of this was written down. The only specification was
`server/services/images/providers/localImageServer.js` — so the contract existed only as
whatever one particular server happened to do, and nobody could write a second
implementation, or move the first one, without reading the client line by line. Behaviour and
rationale for the provider *layer* are in [`images.md`](images.md); this is the wire format.

Everything here is derived from that adapter and is authoritative for it. If the two ever
disagree, the adapter wins and this file is the bug.

## Shape

One base URL — a bare `http(s)` origin, no path. Every route below hangs directly off it.
JSON in, JSON out. Images are **base64-encoded PNG strings**, never binary bodies or URLs.

Authentication is a single optional header, sent on every request except `/health`:

```
X-API-Key: <the operator's key>
```

Omitted entirely when no key is configured, so a server on a trusted LAN can ignore auth. If
your server requires a key, **`/health` must still answer without one** — reachability is
probed before any credential is resolved.

**The address must resolve to a private network.** `services/net/privateUrl.js` enforces this
at the write boundary, and the reason is in `images.md`: the reference server has no
moderation and no authentication, and players type the prompts.

## Required

| Route | Purpose |
|---|---|
| `GET /health` | Reachability. Any `200` with a JSON body. No auth. |
| `POST /generate` | Make an image from a prompt. |
| `POST /characters` | Register a persistent character identity. |
| `GET /characters` | List registered identities. |
| `POST /characters/:id/generate` | Draw a registered character in a new scene. |
| `POST /characters/:id/delete` | Forget an identity. A `POST`, not `DELETE`. |

## Optional

Both degrade rather than failing. A server without them still works.

| Route | Purpose | Absent means |
|---|---|---|
| `GET /models` | Which checkpoints are installed. | Empty picker; the operator types a model name. |
| `GET /progress` | How far the current job has got. | No progress readout. |

## `POST /generate`

```json
{ "prompt": "…", "style": "fantasy-portrait", "model": "krea2",
  "width": 896, "height": 1152, "batch_size": 1, "seed": 12345 }
```

`seed` is present **only** when reproducibility was asked for; otherwise pick one and report
it back. Response:

```json
{ "images": ["<base64 PNG>", "…"], "model": "krea2", "seed": 12345 }
```

`images` is required and must be non-empty — an empty array is treated as a failure, not as
an empty portrait. `model` and `seed` are echoed back if you have them.

**Three parameters are never sent, and adding support for them changes nothing:** `cfg`,
`steps`, `negative_prompt`. The adapter has no code path for any of them, and tests assert
their absence. `images.md` explains why that is a stronger guarantee than a correct default.

## Character continuity

The point of this pair of routes is that the same character looks like themselves across
scenes. The server holds a likeness; the game holds only an id.

`POST /characters` — `{ "name": "…", "appearance": "…" }` → `{ "id": "…", "image": "<base64>" }`

`appearance` is what is *permanently* true of them: build, features, colouring, scars. Not
what they are wearing today and not where they are standing. Continuity rests entirely on
this text, so the adapter refuses an empty one. `id` is required; `image` is an optional
reference portrait.

`POST /characters/:id/generate` — `{ "scene": "…", "identity_strength": 1.0, "width": …, "height": … }`

`scene` is the situation, not the person. Same response shape as `/generate`.
`identity_strength` and the dimensions are omitted unless set.

`GET /characters` → `{ "characters": [ … ] }`. A bare array is also accepted.

`POST /characters/:id/delete` → any `200`. The caller is responsible for clearing its own
record; a stale id makes the next scene fail with a `404`.

## `GET /models`

The reference server keys models by id rather than listing them, and both forms are read:

```json
{ "models": { "krea2": { "label": "Krea 2", "installed": true } } }
```

Anything with `installed: false` is filtered out. `installed` absent counts as installed —
a server that does not track it should not vanish from the picker.

## `GET /progress`

```json
{ "running": true, "step": 12, "steps": 30, "percent": 40 }
```

Every field is coerced and defaulted, so partial answers are fine. This route may never fail
the image it describes: any error is read as "not running".

## Validated before the request, not by it

The adapter rejects these itself rather than spending a round trip (`CQ-6`):

| Field | Rule | Default |
|---|---|---|
| `width`, `height` | 256–2048, multiple of 16 | 896 × 1152 (portrait) |
| `style` | `fantasy-portrait`, `fantasy-painterly`, `photoreal` | `fantasy-portrait` |
| `model` | any non-empty string | `krea2` |
| `batch_size` | integer 1–8 | 1 |
| `identity_strength` | 0.8–1.2 | omitted |

A server accepting a wider range gains nothing until the adapter's bounds widen too.

## Two operational facts a new implementation must match

- **Requests are serialised.** Parallel calls queue rather than running concurrently.
  `batch_size` is how variations are requested. A server that runs them in parallel is fine,
  but nothing depends on it.
- **Cold start is 15–22 seconds** while a checkpoint loads. Client timeouts allow for it, so
  a fast server is not required — but one that returns `503` while loading is a failure, not
  a wait.

## Should this live in its own repository?

Undecided, and this document is the prerequisite either way — the contract has to be written
down before anything can be moved or reimplemented against it.

Arguments for: the server is a separate deployable with its own dependencies (a Python
inference stack, model weights) that this repository neither declares nor tests. It is
currently the only implementation of a documented interface, which is exactly the shape that
belongs behind a boundary.

Against, or at least to solve first: the contract above and the adapter would then version
independently, so `/generate` gaining a field becomes a coordination problem rather than one
commit. That wants a version marker in `/health` before the split, not after.

_Last verified: 2026-07-30 against branch `feature/tactical-map`._
