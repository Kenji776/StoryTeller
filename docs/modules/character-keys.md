# Module: `server/services/characterKeys.js`

The RSA key that signs exported character files, and what replacing it costs.

Small module, easy to underestimate. A `.stchar` file is a character sheet plus a signature over it,
and that signature does two jobs: it lets `/api/character/import` refuse a sheet somebody edited, and
it **is the credential** that gets a host into the DM tools — `/api/admin/host-verify` accepts a
validly-signed file whose `characterId` matches the lobby's recorded host.

## Nobody sets this up

Absent key → generate RSA-2048, write it, log one line. A fresh clone and a fresh container both just
work. There is no setup step and no prompt, which is the point: the guarantee is invisible until
somebody tries to forge a character file.

Lives at `server/data/credentials/charkey.pem`, with the vault. It is a plaintext private key — it has
to be, since the server reads it on every export — so it is the file that decides what permissions
that folder wants. See [`credentials.md`](credentials.md) and the folder's own README.

## What rotating actually costs

Worth stating precisely, because the intuitive answer is wrong and more alarming than the truth.

| Affected | Not affected |
|---|---|
| `.stchar` files exported before the rotation stop importing (400) | Any character in a lobby |
| A host holding an old export cannot open the DM tools (401) | Any campaign, sheet, inventory or progress |
| | Saved games, in any way at all |

**Characters in a running game carry no signature.** They are plain JSON in the lobby file; the key is
nowhere near them. Grepping a real lobby for `sig`/`signature`/`signed` finds nothing. So "rotating
corrupts all your characters" is false — the accurate sentence is "every exported character file stops
importing".

It is also recoverable: exporting again from the running lobby signs with the new key, and the new file
works. That is what makes rotation a reasonable thing to offer rather than a one-way door, and both
halves are tests rather than claims.

Offered because a leaked key cannot be un-leaked. This one has leaked before — it was baked into a
built Docker image until `.dockerignore` learned to exclude `server/data`.

## Three decisions that are not obvious

**A corrupt key file is fatal.** Generating a replacement would invalidate every export, with a log
line as the only evidence. An operator has to see that and decide, so the constructor throws and the
unreadable file is left where it can be rescued.

**A key at the old path is moved, not replaced.** `charkey.pem` used to live in `server/data/`. An
install upgrading past that change must keep its key, so `legacyKeyPath` migrates it — adopting the
content *before* writing or unlinking anything, so an unreadable key throws while the original is
still there. With keys at both paths the new one wins and the stray is reported rather than deleted.

**The public key is handed out as a function.** `server.js` used to pass it into `registerAdminAuth`
by value. A rotation would then have left host-verify checking the retired key: accepting files that
should have stopped working and rejecting freshly exported ones. That is a latent bug the rotation
feature would have activated, and the accessor is the fix.

## Permissions are advisory, on purpose

`checkPermissions()` reports whether the folder is readable beyond its owner, and `server.js` prints
the advice. It never blocks the boot. This is a game: an install that refuses to start over a
directory mode is one nobody plays, and a check people disable has achieved nothing.

The advice carries the actual command. "Secure your keys" is what every project says and is why nobody
does it — an operator who does not already know `chmod` will not go and find out.

**Nothing is claimed on Windows.** `statSync().mode` there is synthesised and does not describe the
ACLs in force, so judging it would produce a confident warning about a permission model the machine is
not using. The Windows branch points at `icacls` and asserts nothing. A filesystem that cannot be
`stat`ed — a network share, say — reports unknown, which is not the same as insecure.

## The operator's surface

Two routes on `providerAdmin`'s password-only gate, rendered in the admin panel's Toolbox beside the
character-file tools:

| Route | Answers |
|---|---|
| `GET /api/admin/character-key` | `{fingerprint}` |
| `POST /api/admin/character-key/rotate` | `{previous, current, consequence}` |

**A host token cannot reach either.** A host runs one game; rotating invalidates exports for the whole
instance. `isAdminAuthenticated` consults password sessions only, and never host tokens — the same
boundary the rest of that file documents.

Responses carry fingerprints and never key material. A fingerprint is the first sixteen hex characters
of a SHA-256 over the *public* half: enough to confirm a rotation happened, useless to anyone who
intercepts it.

_Last verified: 2026-07-30 against branch `feature/tactical-map`._
