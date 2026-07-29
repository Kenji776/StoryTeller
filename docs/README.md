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
| `server/services/` | Lobby store and its mixins, the LLM gateway, map, SFX, game-state broadcasts |
| `server/services/llm/` | Provider-agnostic AI layer — see [modules/llm.md](modules/llm.md) |
| `server/services/tts/` | Provider-agnostic narration layer — see [modules/tts.md](modules/tts.md) |
| `server/services/credentials/` | Operator key vault and provider policy — see [modules/credentials.md](modules/credentials.md) |
| `server/services/images/` | Provider-agnostic image generation — see [modules/images.md](modules/images.md) |
| `server/services/net/` | The private-network guard for operator-supplied service addresses |
| `server/helpers/` | Dice, DM JSON parsing/repair, class progression, asset downloads |
| `client/` | Browser client (no build step; plain ESM and HTML fragments) |

## Documents

- [architecture.md](architecture.md) — system map, data flow, module boundaries
- [modules/llm.md](modules/llm.md) — the AI provider layer
- [modules/tts.md](modules/tts.md) — the narration provider layer
- [modules/admin-console.md](modules/admin-console.md) — the operator interface
- [modules/credentials.md](modules/credentials.md) — who pays for a third-party call
- [modules/images.md](modules/images.md) — the image generation layer
- [modules/items-and-loot.md](modules/items-and-loot.md) — inventory, equipment, treasure
- [modules/combat.md](modules/combat.md) — who rolls what, and what the narrator may not invent
- [modules/encounters.md](modules/encounters.md) — when a fight happens, and how big it is
- [modules/spells.md](modules/spells.md) — what a caster knows, and what casting costs
- [modules/spell-resolution.md](modules/spell-resolution.md) — what a cast spell does
- [testing.md](testing.md) — tiers, conventions, gaps
- [runbooks/](runbooks/) — repeatable procedures (start here for restarting the server)
- [decisions/](decisions/) — architecture decision records
  (newest: [0023 — a quest reward is read from both sides](decisions/0023-a-quest-reward-is-read-from-both-sides.md))
- [worklog/](worklog/) — append-only session journal

_Last verified: 2026-07-28 against branch `Refactor` (6a2adfb)._
