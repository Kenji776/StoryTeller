# StoryTeller — documentation index

StoryTeller is an AI-narrated multiplayer D&D game. Players join a lobby, build
characters, and take turns; a large language model plays the Dungeon Master,
narrating scenes and returning structured JSON that drives HP, XP, inventory,
music, and sound effects.

## Running it

```
npm install
cp server/.env.example server/.env    # then fill in the values you need
npm run dev                            # http://localhost:3000 (PORT overrides)
```

`--devmode` (or `DEV_MODE=TRUE`) suppresses narration and image generation to
conserve API spend, and unlocks the canned-response test provider.

Narration works through either a self-hosted TTS server or ElevenLabs. Both are
probed at boot; a new lobby prefers whichever is up, local first, and the host
switches per lobby in the settings window. Neither is required — without one, the
game plays silently.

The local server can be on any machine and port on your network: enter its
address in the settings window and press **Test**, which checks the connection,
loads its voices, and saves the address. `LOCAL_TTS_URL` only seeds the first run.

## Tests

| Tier | Command |
|---|---|
| Unit | `npm test` |
| Integration | `npm run test:integration` |
| Coverage | `npm run coverage` |

See [testing.md](testing.md) for conventions and for what is deliberately untested.

## Where things are

| Path | What lives there |
|---|---|
| `server/server.js` | Express + Socket.IO entry point; core game-flow socket events |
| `server/routes/` | Turn timer, admin auth/events, TTS HTTP routes, chat |
| `server/services/` | Lobby store and its mixins, LLM access, map, SFX, game-state broadcasts |
| `server/services/llm/` | Provider-agnostic AI layer — see [modules/llm.md](modules/llm.md) |
| `server/services/tts/` | Provider-agnostic narration layer — see [modules/tts.md](modules/tts.md) |
| `server/helpers/` | Dice, DM JSON parsing/repair, class progression, asset downloads |
| `client/` | Browser client (no build step; plain ESM and HTML fragments) |

## Documents

- [architecture.md](architecture.md) — system map, data flow, module boundaries
- [modules/llm.md](modules/llm.md) — the AI provider layer
- [modules/tts.md](modules/tts.md) — the narration provider layer
- [modules/admin-console.md](modules/admin-console.md) — the operator interface
- [testing.md](testing.md) — tiers, conventions, gaps
- [decisions/](decisions/) — architecture decision records
  (newest: [0012 — the admin console as a routed shell](decisions/0012-admin-console-as-a-routed-shell.md))
- [worklog/](worklog/) — append-only session journal

_Last verified: 2026-07-27 against branch `Refactor` (634b6c1)._
