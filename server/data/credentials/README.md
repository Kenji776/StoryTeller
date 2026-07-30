# This folder holds secrets

Everything in here should be readable and writable by **one** account: the one the game server
runs as. Not the group, not other users, not a web server, not a backup agent that syncs to
somewhere public.

Nothing in this folder is in git, and nothing is in the Docker image. It exists only on your
machine, and losing it has consequences worth knowing before you delete anything.

## What is in here

| File | What it is | If you lose it |
|---|---|---|
| `charkey.pem` | RSA private key. Signs exported `.stchar` character files. | Every character anyone exported stops importing, and a host holding one cannot open the DM tools until they export again. Games in progress are unaffected. |
| `credentials.enc` | Your API keys, AES-256-GCM encrypted under `STORYTELLER_SECRET`. | Re-enter your keys in the admin panel. |
| `provider-policy.json` | Which providers are offered and who pays. **No secrets.** Safe to read and hand-edit. | Defaults are regenerated on next boot. |
| `credentials.enc.locked-*` | A vault that would not open, set aside rather than overwritten. | Nothing — these are backups of a failed unlock. |

`charkey.pem` is a private key in plaintext. It has to be: the server reads it on every export.
That is the file to think about when deciding permissions.

## Locking it down

The server checks this folder at startup and prints a warning if it is readable beyond its owner.
It will **never refuse to start** over it — a game that will not boot because of a directory mode
is a game nobody plays. The warning carries the command; running it is up to you.

### Linux and macOS

```bash
chmod 700 server/data/credentials          # only the owner may enter the folder
chmod 600 server/data/credentials/*        # only the owner may read the files
```

Run these **as the user the server runs as**, and check that user owns them:

```bash
ls -ln server/data/credentials             # the UID column should be that user's
```

If you run the server under a service account, `chown` the folder to it first. `chmod 700` on a
folder owned by somebody else locks the server out of its own key — which is the usual way this
goes wrong.

### Docker

Set the permissions on the **host** side of the bind mount, not inside the container. The shipped
image runs as root, and root ignores file permissions, so tightening the host directory does not
lock the game out:

```bash
chmod 700 ./server/data/credentials
chmod 600 ./server/data/credentials/*
```

If you have modified the image to run as a non-root `USER`, that account's UID needs ownership
instead, or the container cannot read its own key. This is the one case where the advice above
will break things.

### Windows

`chmod` does nothing meaningful here, and the server does not check permissions on Windows —
the mode bits Node reports do not describe what Windows enforces, so a warning either way would
be guesswork.

Use `icacls` instead. Grant the account running the server and your administrators, and drop
inherited access for everyone else:

```powershell
icacls server\data\credentials /inheritance:r
icacls server\data\credentials /grant:r "%USERNAME%:(OI)(CI)F"
icacls server\data\credentials /grant:r "Administrators:(OI)(CI)F"
```

### Network shares

If this folder is on SMB or NFS, POSIX modes are usually advisory or synthesised, and the real
control is the share's own permissions. Restrict the share; do not trust `chmod` to have done
anything.

## Things not to do

- **Do not put this folder anywhere a web server can serve it.** It is under `server/data/`,
  which the app never serves as static files — keep it that way.
- **Do not commit it.** `.gitignore` covers it, and `.dockerignore` keeps it out of the image.
  Both were added after the key was found baked into a built image, so they are load-bearing.
- **Do not back it up to anywhere shared** without encrypting the backup. A copy of `charkey.pem`
  is as good as the original.
- **Do not hand-edit `credentials.enc`.** A vault that will not decrypt is set aside, not
  overwritten, so a bad edit costs you the keys rather than corrupting them silently — but it
  still costs you the keys.

## Replacing the signing key

If `charkey.pem` has leaked, replace it: **Admin panel → Toolbox → Character signing key**. The
consequences are the ones in the table above, and re-exporting affected characters is the fix.
There is no way to un-leak a key, so rotating is the only real remedy.

_Last verified: 2026-07-30 against branch `feature/tactical-map`._
