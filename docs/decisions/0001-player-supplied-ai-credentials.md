# 0001 — Players supply their own AI credentials

**Status:** Accepted (2026-07-27)

## Context

Until now the server held a single OpenAI key and a single Anthropic key in
environment variables, constructed one client of each at module load
(`server/services/llmService.js`), and every lobby on the instance spent the
operator's money. The per-lobby `llmProvider` / `llmModel` setting only chose
*between the operator's two keys*; a player could not bring their own account,
could not use a local model, and could not use any provider the operator had not
configured.

Three forces shape the replacement:

- **The server drives the game loop.** Turn-timer expiry, background history
  summarization, and the DM-JSON repair retries all call the model with no
  client connected. A browser-side-only integration cannot work.
- **A lobby is multiplayer, but a call has one payer.** Several players share one
  narration stream, so one credential has to be authoritative for the lobby.
- **Lobby state is persisted wholesale.** `LobbyStore.persist()` serialises the
  entire lobby object to `server/data/lobbies/*.json` on every mutation.

## Decision

Players configure an AI provider, credential, and model in the browser. The
configuration is stored in `localStorage` and sent to the server over the
existing Socket.IO connection.

**The lobby host's configuration is the one the lobby runs on.** Joining players
need no credential of their own. A host with no configuration is blocked from
starting a game and is shown the configuration UI instead.

**Credentials live in a separate in-memory store keyed by lobby id, never in
`LobbyStore`.** Only the non-secret `llmProvider` and `llmModel` remain in lobby
state where they can be persisted and published to clients. Consequently a
credential does not survive a server restart: on reconnect, or when a hibernated
lobby resumes, the server asks the host's client to re-send it from
`localStorage`.

The image provider is configured separately from the chat provider, because
portrait generation is DALL·E-specific and would otherwise silently vanish for
every player who picks a non-OpenAI DM.

## Consequences

**Easier.** Any player can use their own account, their own spend limits, and any
supported provider including a local model. The operator no longer needs to hold
credentials at all to run a public instance. Provider failures become explicable
to the person who can fix them — a rejected key is now a message to its owner.

**Harder.** A credential is in server memory for the life of a lobby, and travels
over the socket connection, so a deployment must terminate TLS to be safe; this
is now a deployment requirement rather than a nicety. Server restarts interrupt
running games until the host's client re-sends its configuration, which is new
reconnect logic that did not previously exist. `localStorage` is readable by any
script on the origin, so an XSS anywhere in the client becomes a credential
disclosure — a materially higher cost for a client-side bug than before.

**Unchanged.** ElevenLabs narration remains an operator-provided, server-side
key. It is a per-instance media feature rather than the per-player AI brain, and
nothing about this decision requires moving it.

## Alternatives considered

**Keep server-side keys, add more providers.** Cheapest, and preserves a working
demo out of the box, but leaves the operator paying for every game and every
player restricted to whatever the operator configured. Rejected: it does not
address the actual request.

**Every player supplies a key; the server uses whoever's turn it is.** Distributes
cost fairly, but timer expiry, auto-summarization, and DM chat all fire with no
triggering player, so a designated fallback credential is required anyway. That
collapses back into the host model with extra state and extra ways to surprise
someone with a bill. Rejected.

**Browser calls the provider directly; server never sees the key.** The strongest
option for credential safety, and it was rejected reluctantly. It cannot work
here: the server-driven turn timer and background summarization have no client to
delegate to, browser CORS blocks Anthropic and most local endpoints, and the key
would be exposed to the page anyway.

**Encrypt credentials at rest in the lobby JSON.** Would survive restarts. There
is no key-management story on a single-process app with no secret store — the
decryption key would sit beside the ciphertext. Rejected as security theatre;
in-memory with an explicit re-send is honest about its guarantees.

_Last verified: 2026-07-27 against branch `Refactor` (634b6c1)._
