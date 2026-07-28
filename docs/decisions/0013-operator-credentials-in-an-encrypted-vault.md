# 0013 — Operator credentials live in an encrypted vault, governed by a per-provider policy

**Status:** Accepted (2026-07-27)

Extends [0001](0001-player-supplied-ai-credentials.md), which moved AI credentials
from the operator to the host but left the operator's own keys in `.env` and left
"who may spend them" unanswered.

## Context

ADR 0001 established that a host's browser supplies the credential a lobby runs
on. It also recorded, as an unchanged fact, that ElevenLabs stays an
operator-provided server-side key — and in practice so did everything else:
`server/services/llmService.js` still reads `OPENAI_API_KEY` and `CLAUDE_API_KEY`
at module load and constructs one client of each, so every lobby on the instance
spends the operator's money.

That is fine for a private install and wrong for a public one. The operator wants
both shapes from one build, and the choice has to be theirs per provider rather
than a fork of the code.

Three forces:

- **An instance owner may want to share, or not, or partly.** "Use my key" and
  "bring your own" are both legitimate defaults, and so is "use my key, but only
  the cheap model" — the actual shape of the cost concern.
- **Operator keys must survive a restart.** Unlike a host's credential, which
  ADR 0001 deliberately keeps in memory only, an instance's own key is long-lived
  configuration. It cannot live in memory and it should not require a redeploy to
  change, which `.env` does.
- **`server/data/` is not a safe place for a plaintext secret.** It is a mounted
  volume in the Docker deployment, it is what a backup captures, and a static
  mount misconfiguration would serve it. `.env` has the same exposure with worse
  ergonomics.

## Decision

**Operator keys move from `.env` into an encrypted vault** at
`server/data/credentials.enc`: AES-256-GCM, key derived by scrypt from a secret
read from the process environment (`STORYTELLER_SECRET`, or
`STORYTELLER_SECRET_FILE` for a Docker secret). Existing `.env` keys are imported
on first boot and the variables can then be removed.

**The key never leaves the server.** The admin API returns only
`{configured, last4, status, lastValidated}`; there is no read path to a browser.

**With no secret configured the vault refuses to persist** and holds keys in
memory for the life of the process, saying so at boot. Writing plaintext would be
worse than forgetting; refusing to boot would break LAN installs that never
wanted a vault.

**A vault that cannot be decrypted is never written to.** A wrong secret, a
corrupt file, and a tampered ciphertext are indistinguishable to AES-GCM and all
three raise `VaultLockedError`, leaving the file untouched — overwriting a file
we could not read would destroy working credentials on a typo.

**Who may spend a credential is a separate, non-secret document**
(`server/data/provider-policy.json`), one entry per capability × provider:

| Policy | Meaning |
|---|---|
| `shared` | The instance's key, optionally capped per lobby and restricted to an allowlist of models. |
| `byok` | Offered; the player supplies the credential. |
| `local` | A self-hosted service — an address, no credential. |
| `off` | Not offered. |

Lookups fail closed: an unknown capability, provider, or absent document resolves
to `off`. The first-run default is one rule — a provider needing no credential is
`local`, one the vault holds a key for is `shared`, everything else is `byok`.

## Consequences

**Easier.** One build serves a private instance, a public BYOK instance, and
every hybrid between, chosen from the admin console rather than by editing files
and restarting. A fresh install with no keys at all is still playable, because
unconfigured providers default to `byok` rather than `off`. A leaked backup or
volume snapshot no longer hands over working credentials.

**Harder.** There is now a secret that must be present for the instance to reach
its own keys, and losing it means re-entering every key. Credential state is
split across three places — the vault, the policy document, and the in-memory
per-lobby store from ADR 0001 — and a reader has to know which holds what.
Rotating `STORYTELLER_SECRET` is not implemented; it currently means clearing the
vault and re-entering the keys.

**What this does and does not protect against, stated plainly.** The encryption
key is derived from a secret in the process environment, not from anything stored
beside the ciphertext. Someone holding `credentials.enc` has nothing. Someone
holding the environment has everything. That is the whole of the guarantee, and
it is the specific reason this is not the security theatre ADR 0001 rejected when
it declined to encrypt lobby JSON — there, the decryption key would have sat next
to what it protected.

## Alternatives considered

**Keep operator keys in `.env`.** Zero new code, and it is where a Twelve-Factor
app puts them. Rejected: changing a key means editing a file on the host and
restarting the process, which is not a thing an operator does from the admin
console, and it leaves the plaintext in a file that backups and `docker cp`
capture. The worklog already records live keys sitting in a gitignored
`docker-compose.yml` — the ergonomics push secrets into worse places.

**Encrypt with a key stored beside the ciphertext.** Would need no environment
secret and no boot-time failure mode. Rejected for exactly the reason ADR 0001
rejected it for lobby state: it protects against nothing, while looking like it
protects against something.

**A real secret manager (Vault, SOPS, cloud KMS).** The right answer at a
different scale. Rejected as disproportionate for a single-process game server
with no infrastructure dependency today; the envelope format is versioned, so
moving the key derivation to an external provider later is a contained change.

**Policy as a field on each vault record.** Fewer files, and the two are always
edited together. Rejected: policy holds no secrets and benefits from being
readable and hand-editable, while the vault must never be either. Merging them
would mean an operator cannot inspect who-pays without the decryption secret.

**One global "share keys" switch instead of per-provider policy.** Much simpler
UI. Rejected: it cannot express "share the cheap model, BYOK for the expensive
one", which is the case the operator actually described, and it would tie the
narration key to the chat key when those have very different cost profiles.

_Last verified: 2026-07-27 against branch `Refactor` (ec6c6a0)._
