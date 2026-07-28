# Module: `server/services/credentials/`

Who pays for a third-party call, and where that credential is kept.

Three things need a credential — `chat` (the DM), `speech` (narration), `image`
(portraits) — and there are two possible payers: the instance operator, or the
lobby's host. This module owns the operator half and the rules that govern both.
The host half arrives with the session store; this document grows with it.

Decisions: [ADR 0013](../decisions/0013-operator-credentials-in-an-encrypted-vault.md)
for the vault and the policy model, [ADR 0001](../decisions/0001-player-supplied-ai-credentials.md)
for why host credentials are memory-only, [ADR 0003](../decisions/0003-host-presence-and-credential-lifetime.md)
for how long they live.

## Layout

| File | Responsibility |
|---|---|
| `vault.js` | Stores the operator's API keys, encrypted on disk. |
| `policy.js` | Records which providers are offered for each capability, and who pays. |

Both take `fsImpl`, the clock, and the logger as parameters, so the whole module
is exercised without a disk, a clock, or a key (`CQ-5`, `TDD-8`).

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

## Testing

`npm test`. No network, no disk, no real clock — the filesystem double matches
the one in `services/tts/localConfig.test.js`. Two tests assert security
properties directly rather than implementation: the plaintext key never appears
in the bytes written to disk, and `describe()` never carries it in any value.

## Not yet built

The per-lobby session store for host-supplied credentials, its purge triggers,
and the resolver that chooses between a host key, a shared key, and a local
service. Until those land, nothing consumes this module — the game loop still
runs on `services/llmService.js` and its `.env` keys.

_Last verified: 2026-07-27 against branch `Refactor` (ec6c6a0)._
