# Module: `server/services/credentials/`

Who pays for a third-party call, and where that credential is kept.

Three things need a credential — `chat` (the DM), `speech` (narration), `image`
(portraits) — and there are two possible payers: the instance operator, or the
lobby's host. This module owns both, and the single path that chooses between
them.

Decisions: [ADR 0013](../decisions/0013-operator-credentials-in-an-encrypted-vault.md)
for the vault and the policy model, [ADR 0014](../decisions/0014-a-host-credential-is-consented-bounded-and-outlived-by-its-ledger.md)
for consent, limits and expiry, [ADR 0001](../decisions/0001-player-supplied-ai-credentials.md)
for why host credentials are memory-only, [ADR 0003](../decisions/0003-host-presence-and-credential-lifetime.md)
for how long they live.

## Layout

| File | Responsibility |
|---|---|
| `vault.js` | Stores the operator's API keys, encrypted on disk. |
| `policy.js` | Records which providers are offered for each capability, and who pays. |
| `sessionKeys.js` | Holds a lobby host's key in memory, and what the lobby has spent. |
| `resolve.js` | Decides whose credential serves one call, or refuses with a reason. |
| `capabilities.js` | Describes what the instance can do — one shape for players, one for the operator. |
| `readiness.js` | Whether a lobby can start, and what its host would have to do about it. |
| `index.js` | Composition root: assembles the above and is the only file here that knows the registries. |

Every one of them takes `fsImpl`, the clock, and the logger as parameters, so the
whole module is exercised without a disk, a clock, or a key (`CQ-5`, `TDD-8`).

## The vault

`server/data/credentials.enc` — AES-256-GCM over a scrypt-derived key. The
secret comes from `STORYTELLER_SECRET` (or `STORYTELLER_SECRET_FILE`); it is
never stored beside the ciphertext, which is the entire security claim and the
reason this is not the theatre ADR 0001 rejected for lobby state.

```js
createVault({ fsImpl, filePath, secret, now, log })
  → { persistent, set, clear, read, has, describe, recordValidation }
```

`read()` is the only function that yields key material and exists for credential
resolution alone. `describe()` is what the admin console renders — `configured`,
`last4`, `addedAt`, `status`, `lastValidated` — and is the only shape that may
travel to a browser. A key of eight characters or fewer shows no tail at all,
matching `redactLLMConfig` in `services/llm/config.js`.

Three behaviours are load-bearing rather than incidental:

- **No secret means no persistence.** The vault runs in memory and says so at
  boot. It never falls back to writing plaintext.
- **A vault that would not open is never written to.** Wrong secret, corrupt
  file, and tampered ciphertext are one failure to AES-GCM (`VaultLockedError`)
  and all three leave the file exactly as found. Overwriting a file we could not
  read would destroy working keys on a typo.
- **A fresh salt and IV per file, a fresh IV per write.** Two vaults holding the
  same key produce different ciphertext; a test enforces it.

## The policy document

`server/data/provider-policy.json` — plain JSON, deliberately. It holds no
secrets, only which providers are offered and who pays, so it is worth keeping
readable and hand-editable.

```
{ capability: { providerId: { policy, sharedModels, maxCallsPerLobby, baseUrl } } }
```

| Policy | Means | Extra fields |
|---|---|---|
| `shared` | The instance's key pays | `sharedModels`, `maxCallsPerLobby` |
| `byok` | The player supplies the key | — |
| `local` | Self-hosted, no credential | `baseUrl` |
| `off` | Not offered | — |

The rules worth knowing:

- **Lookups fail closed.** An unknown capability, an unconfigured provider, or a
  null document all resolve to `off`. Guessing the other way spends money nobody
  agreed to.
- **Fields that do not apply to the chosen policy are dropped, not rejected.** An
  admin flipping `shared` to `byok` should not have the save refused because a
  now-meaningless call cap is still sitting in the form.
- **Unknown capabilities are dropped; unknown policy values are errors.** A
  document from a future version that grew a fourth capability must still load,
  or the operator is locked out of the console that would fix it. A misspelled
  policy has no safe reading, so it stops the load.
- **`sharedModels: []` and `maxCallsPerLobby: 0` are errors.** Both are `off`
  written in a way no reader would interpret correctly.
- **A call cap given as a string is rejected, not coerced** — it means the caller
  did not parse its own form.
- **The module never consults the registry.** A policy can be written for a
  provider whose adapter does not exist yet, and this file stays testable without
  one.

### The base URL is shape-checked here and safety-checked at the write boundary

`policy.js` validates that a local provider's address is a bare http(s) origin
with no path and no embedded credentials. It does **not** check that the address
resolves onto a private network, because that needs DNS and this function runs on
every load including from disk.

The server dials that address, so the private-network guard is mandatory. It
lives in [`services/net/privateUrl.js`](../../server/services/net/privateUrl.js)
— extracted from `services/tts/localConfig.js`, which now delegates to it, since
the speech server is no longer the only self-hosted service an operator can aim
this app at ([ADR 0006](../decisions/0006-host-configurable-local-tts-address.md)).

```js
await validatePrivateServiceUrl(raw, { lookup, serviceName: "Ollama server", example })
```

It resolves the hostname and requires **every** returned address to be private —
requiring all rather than any is what refuses a name resolving to one LAN address
and one public one, which is the shape a DNS rebinding attempt takes. Link-local
is excluded, so `169.254.169.254` and its equivalents are unreachable.

The two layers are complementary, not redundant: the shape check is synchronous
and runs on every load; the network check needs I/O and runs once, when an
operator submits an address. **Anything adding a write path for `baseUrl` must
call the second one.**

## First-run defaults

`defaultPolicyDocument({ known, configured })` derives a starting document from
what the registries offer and what the vault holds, by one rule: needs no
credential → `local`; vault has a key → `shared`; otherwise → `byok`.

`shared` for a configured key reproduces what every existing install already
does, so upgrading does not silently withdraw access from a running instance.
`byok` rather than `off` for the rest matters just as much: a fresh install with
no keys is still playable by anyone willing to bring their own.

## The host's credential

`sessionKeys.js` — memory only, never reachable from a `LobbyStore` object, so
the invariant that `persist()` cannot serialise a secret holds unchanged.

```js
createSessionKeys({ now, log, onPurge, idleTtlMs })
  → { put, take, describe, dropSecrets, dropSecretsBySocket, forget, sweep,
      countSharedUse, sharedUse, size }
```

**Consent is an argument, not a convention.** `put` refuses unless `consent`
is exactly `true`, because the server is the only place that can enforce the
disclosure that one host's key pays for every player at the table. A truthy
string is not agreement.

**Two lifetimes, deliberately.** This is the least obvious thing in the module
and the easiest to "tidy" away:

| | Purged by | Why |
|---|---|---|
| The secret | host disconnect, expiry, idle TTL, lobby end | It exists only while useful |
| The spend ledger | lobby end only | Not sensitive, and see below |

ADR 0003 drops the credential on *every* host disconnect and has the client
re-send it on rejoin. A ledger sharing that lifetime would reset on every flaky
connection, so a host's limit of 200 calls would mean 200 per reconnect. A test
pins this: `the spend ledger survives a secret purge, so reconnecting cannot
reset the budget`.

**`take` checks and counts in one operation**, so a caller cannot read a
credential and forget to record the spend. It returns `{ok: true, config}` or
`{ok: false, reason}` — `absent`, `expired`, `exhausted` — and never throws; the
resolver owns the error type.

**Exhaustion keeps the key, expiry destroys it.** A host may raise their own
limit without re-entering a credential. An expiry is what the host asked to have
enforced, so it is enforced by an active `sweep()` as well as on read — "after
that date regardless of game state" cannot be delivered by a read-path check
alone. An expiry may only ever *shorten* a life; every other trigger still
applies underneath it, and a date in the past is refused rather than stored.

## Choosing whose key pays

`resolve.js` — the one place that decides. Order is fixed:

1. **The host's key**, matched on provider as well as presence, so an Anthropic
   key is never sent to OpenAI because the lobby switched providers.
2. **The instance's shared key**, subject to the model allowlist and the
   per-lobby cap.
3. **A local service**, with the operator's address or the provider's default.
4. **Refuse**, with `CredentialRequiredError`.

A host key that is expired or exhausted **throws rather than falling back** to
the operator's. Falling back would move the bill to someone who never agreed to
pay it, at the moment they are least likely to notice.

`CredentialRequiredError` carries `capability`, `providerId`, and a
machine-readable `reason`; `userMessage()` produces copy naming the provider and
the corrective action. It is the signal to **pause the lobby** — the same pause
ADR 0003 uses for an absent host — and explicitly not something the DM narrates
(ADR 0009). A test holds that no message, for any reason, carries key material.

`providerFor(capability, providerId)` is injected, so this module imports no
registry and one path serves chat, speech and images alike.

## Describing the instance

`capabilities.js` answers two different questions and deliberately does not try
to answer them with one shape:

| | Player view | Operator view |
|---|---|---|
| Providers switched off | omitted | listed — that *is* the control |
| Providers with no policy yet | omitted | listed, as `off` |
| Vault metadata | none at all | `configured`, `last4`, `status`, `lastValidated` |
| Policy knobs | the shared-model restriction only | all of them |

`ready` is the field that matters to a player: can this provider serve a game
right now without me supplying anything. `anyUsableWithoutPlayerKey` aggregates
it per capability, and is what tells the browser to warn *before* someone builds
a character that they will need to bring a key.

An **unprobed** local service counts as ready. Reporting it broken because a boot
probe has not finished would show "no AI available" on a fresh start — both wrong
and the most alarming possible first impression. Readiness is withheld only when
reachability is known to be `false`.

The registry is the source of truth for what exists: a policy naming a provider
with no adapter is ignored rather than offered.

## Testing

`npm test` — 198 tests, no network, no disk, no real clock. The filesystem
double matches the one in `services/tts/localConfig.test.js`; time is a
hand-driven clock, so expiry is asserted at an instant rather than slept through.

Six tests assert security properties directly rather than implementation: the
plaintext key never appears in the bytes written to disk, `describe()` never
carries it in any value on either store, the config handed out is a copy so a
caller cannot mutate what is stored, no failure message carries key material, the
player-facing capability view carries no vault metadata at all, and neither
capability view carries a key anywhere in its output.

## Not yet built

Nothing consumes this module yet. The game loop still runs on
`services/llmService.js` and its `.env` keys. Still to come: wiring the purge
triggers to real events (`disconnecting`, `game:end`, `deleteLobby`, hibernate,
and an interval calling `sweep()`), the gateway that replaces `llmService.js`,
the admin write path — which **must** carry the private-network guard described
above — and the host-facing consent and limit UI.

_Last verified: 2026-07-27 against branch `Refactor` (ec6c6a0)._

## Assembling it

`index.js` is the composition root and the only file here that knows the
registries exist. Everything else takes providers as data, which is why it can be
tested without one.

```js
createCredentialSystem({ fsImpl, dataDir, secret, env, log, now, onPurge })
  → { vault, sessionKeys, resolver,
      providersFor, providerFor,
      getPolicy, setPolicy, setAvailability,
      describe, describeForPlayers }
```

One table maps each capability to its registry — chat to `services/llm/`, speech
to `services/tts/`, image to `services/images/` — and normalises away their
differences: the chat registry throws on an unknown id where the others return
null, and the speech registry has no `list` that strips adapter functions, so
this module supplies one.

`getPolicy` is a closure over a mutable binding rather than a snapshot. An admin
saving a policy takes effect on the very next resolution, with nothing rebuilt.

### Importing what an install already has

On construction, keys sitting in the environment are imported into empty vault
slots and the operator is told the variables can be removed:

| Variable | Provider |
|---|---|
| `OPENAI_API_KEY` | `openai` |
| `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY` | `anthropic` |
| `ELEVENLABS_API_KEY`, `ELEVEN_API_KEY` | `elevenlabs` |

`CLAUDE_API_KEY` is the legacy spelling: the old service called the provider
"claude" and the registry calls it "anthropic", so the import is also the rename.

**The environment never overwrites a key already in the vault.** A key entered
through the admin console is the current one, and a stale variable left in a
compose file must not win on the next restart — the same rule ADR 0006
established for the speech server's address.

The import runs *before* the first-run policy is derived, so a key that arrived
from `.env` produces a `shared` default and an existing install keeps behaving
exactly as it did.

### `isLocal` has to survive the registry projection

`defaultPolicyDocument` decides which providers default to `local` by reading
`isLocal` off each descriptor. Each registry's `list` function projects a fixed
set of fields, so a descriptor flag that is not in that projection is silently
dropped — which is exactly what happened when this was first wired: Ollama
arrived without `isLocal` and defaulted to `byok`, making a free self-hosted model
look like a paid account. A test now pins it.

## The operator's control surface

`server/routes/providerAdmin.js`, mounted at `/api/admin/providers`.

| Method | Path | Does |
|---|---|---|
| `GET` | `/` | The operator view of every capability |
| `PUT` | `/:capability/:providerId/key` | Store a key |
| `DELETE` | `/:capability/:providerId/key` | Forget a key |
| `PUT` | `/:capability/:providerId/policy` | Save one provider's policy |
| `POST` | `/:capability/:providerId/test` | Call the real endpoint and record the outcome |

Three properties are the point of the file:

**Gated on a password admin session and nothing else.** The admin console also
issues lobby-scoped host tokens, and a host is not an operator — they run one
game, not the instance. `isHostToken` is not merely rejected here, it is never
consulted, so there is no branch that could later be relaxed into accepting one.
A test asserts the check is never called.

**A key travels in one direction.** It arrives in a request body and never
appears in a response; every handler answers with the vault's metadata view. A
test asserts no response — including a *failure* response, where a provider may
have echoed the key back in its own error text — contains key material. The test
endpoint reads the credential from the vault rather than the request, so it
cannot be used to probe arbitrary keys through the server.

**A local provider's address is resolved before it is stored.** `setPolicy` runs
`validatePrivateServiceUrl` for a `local` policy and refuses anything that does
not land on a private network. This is the write path the guard was extracted
for. It runs only for `local`, because on any other policy the address is
discarded by the policy model anyway and refusing a save over a field about to be
dropped would be a confusing failure.

### Testing a provider needs three different shapes

The registries disagree about how to prove a credential works: chat adapters take
`{config, fetchImpl}` and list models, image adapters take the same and probe,
and the **TTS adapters predate the credential layer entirely** — they take a
bundle of loose environment values (`{ELEVEN_API_KEY}` or `{LOCAL_TTS_URL}`) and
call it `isAvailable` rather than `probe`.

The adaptation lives in one visible table in `providerAdmin.js` rather than being
smeared across callers. It is a wart, and the fix is to give the TTS adapters the
same shape as the other two.


## Whether a lobby can start

`readiness.js` produces one verdict, consumed by three things that must never
disagree: the settings window drawing the AI panel, the Start button, and the
server refusing `game:start`. If those answered separately they would drift, and
the failure mode is the worst kind — a Start button that looks enabled and then
does nothing.

**Only the story service blocks a game.** Narration degrades to silence and
portraits to a blank frame, which is still a game; a Dungeon Master that cannot
answer is not. Refusing to start because nobody has an ElevenLabs key would be
hostile, and it is precisely the gate that gets added by accident when every
capability is treated uniformly.

| State | Means |
|---|---|
| `server` | The instance's key pays. Nothing to do. |
| `local` | A self-hosted service. Free, nothing to do. |
| `own-key` | The host supplied their own. |
| `needs-key` | A key would make this work. |
| `unavailable` | Nothing on offer — and **not** actionable. |

The last distinction matters. An unreachable Ollama with no paid alternative is
`unavailable`, not `needs-key`: no key would fix somebody else's server being
down, and offering a key field would be busywork dressed as a solution.

A host's key is matched against what is *currently* offered, so a key for a
provider the operator has since withdrawn satisfies nothing. Otherwise a lobby
passes its own start check and fails on the first turn.

## The host's side

`routes/aiSetup.js` is host-gated throughout — a joining player neither supplies
nor sees a credential, because ADR 0001 made the host's key the one a lobby runs
on. It serves `GET /api/capabilities` (public, carries nothing sensitive) and the
`ai:*` socket handlers.

`CONSENT_TERMS` is exported as one string so the server's refusal and the
browser's checkbox cannot drift. A host agreeing to wording different from what
was enforced is the shape of a complaint nobody can answer.

**Listing models does not spend budget.** `sessionKeys.peek()` reads a credential
without touching the call counter — browsing models while configuring is not
playing the game. And where the operator restricts a shared key to an allowlist,
that list *is* the answer; no request is made at all, because asking the provider
would spend a call to produce a superset we would then discard.

## The browser

`client/aiPanel.js` holds the logic — row building, the Start gate, and turning a
form into a submission — because `options.html` is one long inline script with no
test harness. It decides nothing: the server's verdict is presented, never
re-derived. `index.html` and `options.html` both attach it to `window` rather than
duplicating it, since both pages are classic scripts.

Two rules it encodes that are easy to get wrong:

- **Unknown means not startable.** Before the first `ai:state` arrives there is no
  verdict, and defaulting to enabled lets someone press a button the server then
  refuses — which reads as a broken game rather than as missing configuration.
- **A date input means the end of that day.** A host choosing "the 5th" wants the
  key to last *through* the 5th; treating it as midnight would expire it as that
  day begins.
