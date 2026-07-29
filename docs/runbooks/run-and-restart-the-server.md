# Running the server, and restarting it properly

## Restarting

**`pkill -f "node server/server.js"` does not work in this environment.** Use PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3013 -State Listen -ErrorAction SilentlyContinue |
	Select-Object -ExpandProperty OwningProcess -Unique |
	ForEach-Object { Stop-Process -Id $_ -Force }
```

Then `npm run dev`, and **confirm the boot banner** before concluding anything:

```
✅ Server running at http://localhost:3013
📋 All config files OK
```

A second `node server/server.js` against a live one dies with `EADDRINUSE: :::3013`, which
is easy to miss when it is buried in a probe's output.

### Why this has its own page

A previous session lost two hours to three "failures" in a row that were a stale process
serving old code — including two HTTP 500s reasoned about at length. The tell was a log
line that could not have existed alongside the error it appeared with.

**If a fix appears not to work, confirm the server actually restarted before debugging
anything else.** It has been the cause more often than the code has.

## Run it and look

Unit tests do not catch what a render or a live turn does. From one session's tally:

| Found by | Defects |
|---|---|
| 2,469 unit tests | 0 of the 6 below |
| Reading a rendered prompt block | 3 — a doubled verb, an unnamed saving throw, `→ 0` for an unerring spell |
| One live three-caster game | 4 — a cast that was also a weapon attack, a cantrip charged an activation, the judge not knowing spells exist, a spell's target unprotected from the model |
| Booting the server | 2 — an unvalidated config file, a boot line miscounting it |

Probes live in `server/test-integration/`. The free ones (no model, no network) are
`balance-sim.mjs`, `consumable-probe.mjs` and `spell-picker-probe.mjs`.

**Probes submit actions as a player, so they must follow initiative.** One probe's first
run ignored turn order, had most submissions refused — including the `[admin_command]`
that stages its fight — and reported an empty roster and no resolution. That reads exactly
like a dead feature. Check `initiative[turnIndex]` before submitting.

## Pruning the lobby store

Every probe creates a lobby through the real socket path and none clean up, so the landing
page fills with them: 66 had accumulated at a median age of one day.

```
node server/tools/prune-lobbies.mjs            # report only, the default
node server/tools/prune-lobbies.mjs --delete   # actually remove
```

It removes a lobby only when it holds no characters, was never played past the opening
turns, or has been untouched for 30 days. A record with no timestamp or one that will not
parse is **kept** — reading a missing date as "very old" is how a sweep deletes the thing
you cared about. The decision is `services/lobbyMaintenance.js` and is unit tested; the
CLI only touches the disk.

_Last verified: 2026-07-28 against branch `Refactor` (5b84773)._
