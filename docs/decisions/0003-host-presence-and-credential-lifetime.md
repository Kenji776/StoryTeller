# 0003 — A game belongs to its host, and cannot run without them

**Status:** Accepted (2026-07-27)

Extends [0001](0001-player-supplied-ai-credentials.md), which established that
the host's credential powers the lobby. This ADR settles where that credential
lives in the browser and what happens when the host is not there.

## Context

Under ADR 0001 the host's API key pays for every DM call in the lobby. Two
questions were left open, and the current code answers neither the way the new
model requires.

**Where does the configuration live in the browser?** Per lobby, or once per
user? A per-lobby copy means re-entering a key for every game; a single copy
means the configuration is a property of the person, not of the game.

**What happens when the host leaves?** Today, nothing special:
`server/server.js:1042` treats a disconnecting host exactly like any other
player — marked disconnected, removed from the turn order, and play continues
for whoever remains. A lobby only hibernates once *every* player has gone. That
behaviour is incompatible with the host's key funding the game: the remaining
players would keep spending a credential belonging to someone who has left, and
after a server restart there would be no way to obtain it again.

## Decision

**One AI configuration per browser, belonging to the user as a host.** It is
stored once in `localStorage`, not per lobby, and is reused for every game they
host. Changing it in the settings menu changes it everywhere.

**A game cannot run while its host is absent.** When the host disconnects from a
running lobby the game pauses: no model calls are issued, turn timers stop, and
the remaining players are told the host has left rather than being silently
stalled. When the host returns and their client re-sends the configuration, the
game resumes.

**The credential is dropped from server memory as soon as the host's socket
disconnects.** Because no model call may happen without the host present, there
is no window in which a held credential would be useful, and holding one for
longer than it is needed is the only cost. The returning host's client re-sends
it automatically as part of the existing rejoin exchange, so this is invisible
in the normal case of a brief network blip.

Host identity across reconnects uses the existing `hostCharacterId` anchor:
assigned on the host's first character save
(`server/services/lobby/lobbyPlayers.js:154`) and matched on rejoin
(`server/server.js:446`) to restore `hostSid`.

## Consequences

**Easier.** The credential's lifetime becomes trivially bounded — it exists only
while its owner is connected, which is both the safest and the simplest rule to
reason about. "Whose key is being spent?" always has the same answer as "who is
in the room?". Re-supply needs no new identity mechanism, because rejoin already
re-establishes who the host is.

**Harder.** Players can no longer continue an adventure while the host is away,
which is a real loss for drop-in groups and a change in behaviour that existing
players will notice. A host with a flaky connection now interrupts everyone, not
just their own turn. Host identity depends on `hostCharacterId`, which is only
assigned once the host has saved a character — a host who disconnects before
that cannot be re-identified, so the lobby is unrecoverable. That case already
deletes the lobby for `waiting` lobbies (`server/server.js:1027`) and needs no
new handling, but it does mean host identity is not durable for the first few
seconds of a lobby's life.

**Consequence worth stating plainly:** a server restart pauses every running
game until each host's browser reconnects. With the previous single server-side
key, a restart was invisible to players.

## Alternatives considered

**Per-lobby configuration in `localStorage`.** Would let one person host
different games on different providers — a cheap key for a casual game, a strong
model for a campaign. Rejected as unnecessary complexity for a want nobody has
expressed: the provider and model are already per-lobby settings on the server,
so the only thing genuinely per-user is the credential.

**Migrate the host role to another player when the host leaves.** Keeps games
alive, and the code already tracks enough to do it. Rejected: the new host would
have to supply their own credential mid-session, silently transferring the bill
to someone who did not agree to pay it. Explicitly pausing is more honest than
quietly charging a different person.

**Keep the credential in memory after the host disconnects, so a brief drop does
not interrupt play.** Tempting, and it would smooth over flaky connections.
Rejected because it only helps if play continues without the host, which this
ADR forbids — so the credential would be retained for no purpose. The
client-side re-send already covers the blip case without holding a secret longer
than its owner is present.

_Last verified: 2026-07-27 against branch `Refactor` (ba25153)._
