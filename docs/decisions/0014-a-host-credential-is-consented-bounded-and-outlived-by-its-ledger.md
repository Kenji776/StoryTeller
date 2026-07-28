# 0014 — A host's credential is consented to, bounded by them, and outlived by its ledger

**Status:** Accepted (2026-07-27)

Implements the store [ADR 0001](0001-player-supplied-ai-credentials.md) specified
and [ADR 0003](0003-host-presence-and-credential-lifetime.md) bounded, and settles
three questions neither answered.

## Context

ADR 0001 decided that the host's credential runs the lobby. ADR 0003 decided it is
dropped the moment the host's socket closes and re-sent on rejoin. Between them
they describe *where* the credential lives and *how long*, and leave three things
open that only became visible when the store was built.

**One person's key pays for everyone.** A lobby is multiplayer and a call has one
payer, so the host funds every DM turn, every narration, and every portrait for
every player at the table. Nothing in the system said so, and a host discovering
it from their provider's billing page would be entitled to be angry.

**A host wants to bound their own exposure.** The operator asked for a call limit
with an unlimited option, and an expiry date after which the key is dropped
"regardless of game state".

**ADR 0003's aggressive purge undermines any budget.** The credential is dropped
on every host disconnect and re-sent on rejoin. If the spend counter shares that
lifetime, it resets on every flaky connection, and a limit of 200 calls becomes
200 calls per reconnect — which is no limit at all.

## Decision

**Consent is a required argument, not a UI convention.** `put` refuses a
credential unless `consent === true` is passed alongside it, and records when it
was given. A browser that forgets to show the disclosure cannot store a key. The
value must be exactly `true`; a truthy string is not agreement.

**The secret and the ledger have deliberately different lifetimes.** The
credential is purged on host disconnect, expiry, idle timeout, and the end of the
lobby. The spend ledger — how many calls this lobby has made — is not sensitive
and lives as long as the lobby does. `dropSecrets` clears the first; `forget`
clears both.

**A host sets a call limit or no limit, and optionally an expiry.** An expiry may
only ever *shorten* a credential's life: every other purge trigger still applies
underneath it, so a date a year out does not mean we hold a key for a year. An
expiry already in the past is refused rather than accepted and instantly expired.

**Exhaustion retains the key; expiry destroys it.** A host who hits their own
limit may raise it without re-entering the credential. A host whose expiry passes
must supply a new one — which is what the operator asked for, and the reason
expiry is enforced by an active sweep rather than only on the read path.

**Resolution order is host key → shared key → local service → refuse.** A host who
supplied a credential is spending their own money by choice, so billing the
operator instead would be wrong; equally, reaching for the host's key when the
operator is offering theirs and the host supplied none would be. A host key is
matched on provider as well as presence, so an Anthropic key is never sent to
OpenAI because the lobby switched providers.

**A refusal is typed, not narrated.** `CredentialRequiredError` carries the
capability, provider, and a machine-readable reason, and is the signal to pause
the lobby — the same pause ADR 0003 uses for an absent host, and explicitly not
something the DM says (ADR 0009).

## Consequences

**Easier.** A host can cap their exposure in the two ways people actually think
about it — how much, and until when — and neither can be defeated by reconnecting.
The consent record means "I didn't know it would charge me for everyone" stops
being possible. One resolution path serves chat, narration and images, so a fourth
capability is a registry entry rather than new logic.

**Harder.** Credential state now lives in three stores with three lifetimes — the
vault, the policy document, and this — and a reader has to know which holds what.
The ledger outliving the secret is the least obvious thing in the module and is
the kind of asymmetry a later refactor could "tidy" away, reintroducing the
reconnect-resets-budget bug; it is commented at the point of definition for that
reason.

**Accepted tradeoff.** Overwriting a key string before dropping the reference does
not guarantee it leaves process memory — JavaScript offers no way to promise that,
and claiming otherwise in a security document would be worse than saying nothing.
What is guaranteed is that the live object graph stops referencing it, and that it
was never written to disk or sent to a client.

## Alternatives considered

**Reset the spend ledger when a credential is re-supplied.** Simplest, and it
matches the intuition that a new key is a fresh start. Rejected: ADR 0003 makes
re-supply an *automatic* part of every rejoin, so this would silently void the
host's own limit on every network blip. The counter is not a secret and has no
reason to share the secret's lifetime.

**Drop the credential when its call limit is reached.** Symmetrical with expiry,
and holds the secret for the shortest possible time. Rejected: the host is still
connected, so the exposure window is unchanged, and making someone re-enter a key
to raise a limit they set themselves is a gratuitous obstacle. Expiry is different
because the host asked for the key to be gone at that moment.

**Treat consent as a client concern.** The browser shows the disclosure and sends
the key; the server trusts it. Rejected: the server is the only place that can
enforce it, and "the checkbox was in the HTML" is not a record that a specific
host agreed on a specific date.

**Fall back to the operator's key when the host's is expired or exhausted.** Keeps
the game running, which is what a player wants. Rejected for the same reason ADR
0003 rejected migrating the host role: it moves the bill to someone who did not
agree to pay it, quietly, at the moment the host has least attention on it.
Pausing is more honest.

_Last verified: 2026-07-27 against branch `Refactor` (284fbff)._
