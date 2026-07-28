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

### The base URL is shape-checked here and safety-checked elsewhere

`policy.js` validates that a local provider's address is a bare http(s) origin
with no path and no embedded credentials. It does **not** check that the address
resolves onto a private network, because that needs DNS and this function runs on
every load including from disk.

The server dials that address, so the private-network guard is mandatory — it
belongs at the async admin write boundary, reusing what
`services/tts/localConfig.js` already does for the speech server
([ADR 0006](../decisions/0006-host-configurable-local-tts-address.md)). The two
layers are complementary. **Anything adding a write path for `baseUrl` must
apply it.**

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

## Testing

`npm test` — 145 tests, no network, no disk, no real clock. The filesystem
double matches the one in `services/tts/localConfig.test.js`; time is a
hand-driven clock, so expiry is asserted at an instant rather than slept through.

Four tests assert security properties directly rather than implementation: the
plaintext key never appears in the bytes written to disk, `describe()` never
carries it in any value on either store, the config handed out is a copy so a
caller cannot mutate what is stored, and no failure message carries key material.

## Not yet built

Nothing consumes this module yet. The game loop still runs on
`services/llmService.js` and its `.env` keys. Still to come: wiring the purge
triggers to real events (`disconnecting`, `game:end`, `deleteLobby`, hibernate,
and an interval calling `sweep()`), the gateway that replaces `llmService.js`,
the admin write path — which **must** carry the private-network guard described
above — and the host-facing consent and limit UI.

_Last verified: 2026-07-27 against branch `Refactor` (ec6c6a0)._
