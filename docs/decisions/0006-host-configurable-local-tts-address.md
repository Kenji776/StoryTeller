# 0006 — The local speech server's address is host-configurable, restricted to private networks

**Status:** Accepted (2026-07-27)
**Amends:** [0005](0005-pluggable-tts-with-a-local-server.md) — reverses its
"operator-controlled env var" decision for the local TTS address.

## Context

ADR 0005 put the local speech server's address in `LOCAL_TTS_URL`, reasoning that
the *server* performs the request, so a host-editable field would be a
server-side request forgery vector.

That reasoning was sound and the conclusion was still wrong, because it assumed a
fact that is not true: that the address is known in advance. A self-hosted speech
server can be on any machine and any port on the operator's network. The default
`http://127.0.0.1:8199` is a guess, and when it is wrong the settings window shows
"unavailable" with nothing a host can do about it — the fix required editing a
`.env` file and restarting the process, which is not a thing a game host does
mid-session. The feature was effectively unreachable for anyone whose server was
not on the exact default.

Worse, the UI compounded it: an unreachable engine was rendered as a *disabled*
dropdown option, so the one control that could have led to a fix was the one
control that was switched off.

## Decision

The address is entered by the host in the settings window, tested on demand, and
persisted server-wide to `server/data/tts-config.json`. A saved address beats
`LOCAL_TTS_URL`, which is demoted to a seed value for a first run.

The SSRF concern is answered by constraint rather than by prohibition. Every
supplied address is resolved before it is dialled, and **every** address the
hostname resolves to must be on a private network:

| Allowed | Refused |
|---|---|
| `127.0.0.0/8`, `::1` | Everything else, including all public addresses |
| `10/8`, `172.16/12`, `192.168/16` | `169.254.0.0/16` and `fe80::/10` link-local |
| `100.64/10` (CGNAT, which is what Tailscale hands out) | Any name resolving to a mix of private and public |
| `fc00::/7` (IPv6 unique local) | URLs carrying a path, credentials, or a non-http scheme |

Link-local is excluded deliberately: `169.254.169.254` serves instance
credentials on every major cloud, and nobody runs a speech server on an
autoconfiguration address, so excluding the range costs nothing.

Requiring *all* resolved addresses to be private, rather than any, is what stops
a name that resolves to one LAN address and one public address from passing.

The address is server-wide rather than per lobby. It describes the deployment,
not the story, and nobody wants to retype it for every new game.

## Consequences

**Easier.** The feature is reachable: a host with a speech server anywhere on
their network can point the game at it in about ten seconds and see, in the same
action, whether it answered and how many voices it has. The local engine stays
selectable even while disconnected, because selecting it is how its address field
is reached.

**Harder.** There is now a persisted server-side setting that any lobby host can
change, and it affects every lobby. In a self-hosted game where hosts already
choose the AI model per lobby this is consistent, but it is a real widening: a
second host can repoint the speech server under a first host's running game.

**Accepted risk.** The private-network check is done at validation time, and the
provider resolves the name again when it actually connects. A hostile DNS server
could answer differently on the two lookups — classic DNS rebinding. Closing that
means pinning the resolved address and connecting to it directly, which breaks
TLS and virtual hosting. For a self-hosted game server on a home network, where
the attacker would already need control of the operator's DNS, the check as
written is proportionate.

## Alternatives considered

**Keep it an env var, and just document it better.** No new attack surface at
all. Rejected: it does not solve the problem. The complaint was that the feature
reports "unavailable" and offers no path forward, and a better `.env.example`
comment does not change that a host must stop the server to fix it.

**Allow any address, with no restriction.** Simplest, and arguably the operator's
own business on their own machine. Rejected: the game server accepts connections
from every player in a lobby, so "the host" is not always someone the operator
vetted. A restriction that costs nothing for the stated use case — a server on
the LAN — is worth keeping.

**Per-lobby address instead of server-wide.** Consistent with how `llmProvider`
is stored, and it would stop one host repointing another's server. Rejected: it
means re-entering the address for every new lobby, which is the same
unreachability problem in a slower form.

**Probe continuously in the background instead of on a button.** No Test button
needed; the engine would simply appear when it came up. Rejected: it cannot
discover an address nobody has told it, which is the actual problem.

_Last verified: 2026-07-27 against branch `Refactor` (239340d)._
