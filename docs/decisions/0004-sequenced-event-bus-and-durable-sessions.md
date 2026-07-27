# 0004 — Sequenced event bus and durable player sessions

Status: accepted

## Context

Players reported events failing to reach them and the party falling out of sync.
Two adversarially-verified audits of the realtime path confirmed 64 defects (15
further claims were refuted). Seven were critical, and six of those seven reduce
to the same root cause.

Socket.IO issues a new `socket.id` on every reconnect. Every authority check in
this codebase is keyed on that id — `lobby.sockets[socket.id]`, `isHost`,
`belongs`, `playerBySid` (`server/services/lobby/lobbyPlayers.js:76-79, 97-100,
211-216`). Room membership is likewise per-socket. The client's only `connect`
handler re-subscribes to the lobby *list* and nothing else
(`client/sockets.js:726-729`), and it registers no `disconnect` or
`connect_error` handler at all.

The result is a zombie client: after any real transport close — proxy idle kill,
laptop sleep, server restart — the player's socket sits in no room, so every
subsequent broadcast misses them, while `server/server.js:1042-1056` has already
removed them from the initiative order and told the rest of the party they left.
Their UI shows no change whatsoever.

Underneath that sits a second absence: nothing names "the state of lobby X at a
point in time". A client cannot tell it missed an event, the server cannot tell a
client is behind, and neither can name what to resend. A missed `map:update` or
`suggestions:update` is unrecoverable over the socket entirely, because
`publicState()` (`server/services/lobbyStore.js:156-216`) does not carry either.

## Decision

Introduce two primitives and derive everything else from them.

**1. A per-lobby monotonic sequence with a bounded journal.** Every state-bearing
broadcast passes through one choke point that stamps it with
`{lid, seq, epoch, ts}` and retains the last 256. A client tracks a watermark and
applies an event only when `meta.epoch === syncEpoch && meta.seq > syncSeq`; a gap
triggers a request for the missing range, which the server answers with a replay
or, when the gap is too old, a full snapshot.

The envelope travels as a **third emit argument**, not a payload field. Socket.IO
passes extra arguments through untouched, so the ~45 existing handlers written as
`socket.on("turn:update", ({current, order}) => …)` ignore it and need no edits.

`epoch` is the process boot time. The journal is in-memory only, so a restart
resets the counter; a changed epoch tells the client to take a snapshot instead of
mistaking the reset for events going backwards.

**2. A session token that outlives `socket.id`.** Issued once when a player
identifies, presented on every reconnect, and used to rebind the existing session
to the new socket. A disconnect starts a 90-second grace window during which the
player keeps their character and their place in the turn order.

## Consequences

Makes easy: detecting loss at all, which is currently impossible; recovering a
short outage without a page reload; distinguishing "briefly dropped" from "gone",
which the turn order needs and cannot currently express; a truthful connection
indicator; an admin view of who is actually connected.

Makes hard: adding a broadcast now means classifying it. An unclassified event
defaults to durable — the failure mode is a redundant idempotent re-apply rather
than silent drift, which is the failure this work exists to remove. Replay also
depends on payloads carrying absolute post-values; the existing deltas already do
(`hp:update` sends `hp`, not just `delta`), and that is what makes this viable.
Anything added later that sends only a delta breaks replay silently.

Bounded retention is a deliberate ceiling: a gap older than 256 events costs a
full snapshot. Snapshots are journaled as tombstones rather than stored, so a
snapshot anywhere in a missed range forces a full resync — necessary because some
state (equipment, initiative, pinned moments) reaches clients only via
`state:update` and has no corresponding delta to replay.

## Alternatives considered

**Socket.IO `connectionStateRecovery` alone.** Restores `socket.id` and room
membership in one line, which is real leverage given how much is keyed on the id.
Rejected as *sufficient*, adopted as *complementary*: it restores the transport,
not the domain teardown that `disconnecting` already performed, so the player
returns to the right room while still absent from initiative and already announced
as departed. It also cannot survive a page reload, is best-effort past
`maxDisconnectionDuration`, does not survive a server restart, and is defeated
outright by `client/init.js:4` calling `socket.disconnect()` on `beforeunload`.

**Per-packet acknowledgements.** Rejected. Socket.IO over a live TCP connection
does not drop ordered packets; the observed losses are room-membership losses and
disconnect-window losses. A sequence number plus a bounded journal covers both at
a fraction of the cost and without an ack round-trip per broadcast.

**Persisting the journal.** Rejected. It would make a restart look like a
continuation when the in-memory turn timers, pending narration handshakes and rest
votes have all been lost anyway. Forcing a snapshot on epoch change is both
simpler and more honest about what actually survived.

_Last verified: 2026-07-27 against branch `Refactor`._
