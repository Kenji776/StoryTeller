# StoryTeller — AI-Powered D&D

A multiplayer, browser-based D&D experience powered by AI. Create or join a lobby, build a character, and play a rules-light one-shot with an AI Dungeon Master. The server handles turns, dice rolls, initiative, and broadcasts everything live over WebSockets.

## Prerequisites

- **Node.js** v18 or later
- **npm** (comes with Node.js)
- At least one LLM API key (OpenAI or Anthropic) for the AI Dungeon Master — the app runs without one using a stub DM, but it's not much of a game

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-username/StoryTeller.git
cd StoryTeller
```

### 2. Install dependencies

```bash
npm install
```

This installs Express, Socket.io, the OpenAI and Anthropic SDKs, and all other server dependencies. There is no separate client build step — the client is vanilla JS served as static files.

### 3. Set up the environment file

Copy the example environment file and fill in your API keys:

```bash
cp server/.env.example server/.env
```

Open `server/.env` in a text editor. At minimum, set one of these:

- **`OPENAI_API_KEY`** — if you want to use OpenAI models (GPT-5, GPT-4o, etc.)
- **`CLAUDE_API_KEY`** — if you want to use Anthropic models (Claude Opus, Sonnet, Haiku)

You can configure both and switch between providers per-lobby in the game options.

Optional but recommended:
- **`ADMIN_PASSWORD`** — set a password to enable the admin panel at `/admin/`
- **`ELEVEN_API_KEY`** — enable voice narration via ElevenLabs TTS
- **`DEV_MODE=TRUE`** — skip TTS and image generation during development to save API calls

See the full [Environment Variables](#environment-variables) table below for all options.

### 4. Start the server

For development:
```bash
npm run dev
```

For production:
```bash
npm start
```

The server starts on the port specified in your `.env` file (default: `3000`, or `3013` if using the example `.env`).

### 5. Open the game

Navigate to `http://localhost:3013` in your browser (adjust the port if you changed it).

Other players on your local network can join at `http://<your-ip>:3013`.

### Docker (alternative)

If you prefer Docker:

```bash
docker compose up -d
```

Lobby data persists in `server/data/lobbies/` and music files in `client/music/` via volume mounts.

## Environment Variables

All configuration lives in `server/.env` (copy from `server/.env.example`):

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | No | OpenAI API key (if using OpenAI as provider) |
| `OPENAI_MODEL` | No | Override the default OpenAI model |
| `CLAUDE_API_KEY` | No | Anthropic API key (if using Claude as provider) |
| `DEFAULT_LLM_PROVIDER` | No | `"openai"` or `"claude"` (default: `"claude"`) |
| `DEFAULT_LLM_MODEL` | No | Default model for the chosen provider |
| `PORT` | No | Server port (default: `3000`) |
| `ELEVEN_API_KEY` | No | ElevenLabs API key for voice narration |
| `ELEVEN_VOICE_ID` | No | Default ElevenLabs voice ID |
| `DEV_MODE` | No | Set `TRUE` to skip TTS and image generation (saves API calls) |
| `ADMIN_PASSWORD` | No | Password for the admin panel (see [Admin Panel](#admin-panel)) |
| `MUSIC_REPO` | No | GitHub `owner/repo` to auto-download music on first run |

No API key? A local stub DM narrates so you can test without any external services.

## Features

### AI Dungeon Master

Two LLM providers are supported:

- **Anthropic Claude** — Opus 4.6, Sonnet 4.6, Haiku 4.5
- **OpenAI** — GPT-5, GPT-4o, GPT-4o-mini, GPT-4-Turbo

The provider and model can be selected per-lobby in the game options. The AI DM narrates the story, resolves actions, manages combat, and responds to player choices in real time.

### Lobby Browser

The landing page shows all active games with live status:

- Adventure name, phase, and player count
- Per-player online/offline indicators and class/race/level details
- Host player marked with a crown icon
- Join running or hibernating games by reclaiming a disconnected character or creating a new one
- Password-protected lobbies display a lock icon

### Lobbies

- Create a lobby and share the join code with your group
- **Password protection** — the host can set an optional lobby password. Passwords are hashed with scrypt on the server and verified with timing-safe comparison.
- **Hibernation** — when all players disconnect from a running game, it enters a hibernating state. Rejoining any character resumes the game automatically.
- Lobby data persists to disk under `server/data/lobbies/`

### Game Options

The lobby host can configure the game before starting:

- **World Setting** — Standard Fantasy, Dark Ages, Steampunk, Pirate Age, Sci-fi
- **Campaign Tone & Theme** — loaded from flavor presets
- **Difficulty** — Casual, Standard, Hardcore, Merciless
- **Brutality Level** — slider from 0 (Kid Safe) to 10 (Ultimate Brutality)
- **Loot Generosity** — Sparse, Fair, Generous
- **Narrator Voice** — pick from available ElevenLabs voices (with preview)
- **Turn Timer** — configurable duration (1–20 min), with auto-kick after missed turns
- **AI Model** — choose provider and model per-lobby

### Character Creation

Players build characters through a guided UI:

- Race, class, alignment, background, deity, gender, age
- Name auto-generation from race/gender name pools
- **27-point buy** ability score system
- Class-based weapon and armor selection
- Standard shared loadout (backpack, bedroll, rations) plus class-specific defaults
- AI-generated character portrait (requires OpenAI API key)

### Character Export & Import

Characters can be saved to `.stchar` files and loaded back later:

- **Export** — the server RSA-signs the character data (SHA-256). The file contains the base64-encoded character sheet and a cryptographic signature.
- **Import** — upload a `.stchar` file and the server verifies the signature to detect tampering. Valid characters can be loaded into any lobby.
- **Host identity** — the host's character file also serves as proof of ownership for accessing DM tools (see [Host DM Tools](#host-dm-tools)).
- The admin panel includes a character file editor that can decrypt, edit, re-sign, and download character files.

### Initiative & Turns

- Turn order is tracked server-side with a round counter
- The active player is highlighted in the UI
- Optional turn timer with configurable duration
- Missed-turn tracking with auto-kick threshold
- Narration completion triggers the next turn timer (with a safety fallback)

### Combat & Death

- HP changes, conditions, and status are resolved by the AI DM and broadcast to all players
- 16 D&D 5e conditions (blinded, charmed, frightened, etc.) with emoji indicators and tooltip descriptions
- When a player reaches 0 HP, they are marked dead, removed from initiative, and shown a death overlay
- Dead players can still watch the game and chat but cannot take actions
- The party table shows dead players with a skull status and "Dead" condition
- If the entire party dies, the game ends with a wipe screen

### Rest Voting

Players can propose short or long rests during their turn:

- A vote is broadcast to all players with a 2-minute timeout
- Players vote yes or no; abstainers are auto-voted "no" at timeout
- If the vote passes, the AI DM narrates the rest and healing is applied

### Chat

A real-time chat system runs alongside the game:

- Chat messages are persisted with the lobby and restored on rejoin
- Chat remains functional even for dead players
- Chat history is sent to newly joining players

### Music System

Mood-based background music plays automatically during the game:

- Songs are stored in `client/music/` as `.mp3` files
- `client/config/library.json` maps each song to descriptive tags
- When the DM (or admin) sets a mood, the system scores songs by tag overlap and picks the best match
- 11 built-in moods: Lively Town, Tense Battle, Boss Fight, Peaceful Nature, Dungeon Ambient, Tavern, Mystery, Exploration, Sad Moment, Victory, Horror
- Crossfade transitions between tracks
- Avoids repeating recently played songs
- Volume control with mute toggle in the upper-right corner of the game screen

To add your own music, drop `.mp3` files into `client/music/` and add entries to `client/config/library.json` with appropriate tags.

### Voice Narration (TTS)

Optional text-to-speech narration powered by ElevenLabs:

- DM narration streams audio in real time via MediaSource API
- Smooth crossfade when narration stops
- Voice is selectable per-lobby from available ElevenLabs voices
- Disabled automatically in dev mode to save API calls
- Works without TTS — a reading delay is used before the turn timer starts

Requires `ELEVEN_API_KEY` in `.env`.

### Host DM Tools

The game host has access to admin-level DM tools for their own game without needing the admin password:

- A **DM Options** button appears in the game header for the host during a running game
- To authenticate, the host uploads their exported `.stchar` character file — the server verifies the cryptographic signature and checks that the character ID matches the lobby's recorded host
- On successful verification, the admin panel opens in a new tab, pre-connected to the host's lobby
- The host can adjust HP, XP, gold, inventory, conditions, spell slots, force dice rolls, advance turns, send DM narration, and control music
- Host identity is restored on rejoin: if the host reconnects by uploading their character file, the DM Options button reappears automatically
- A crown icon (👑) appears next to the host's name in the party table, lobby player list, and active games browser

**Security:** The host token is scoped to a single lobby. The character file's cryptographic signature prevents forgery. Only the host's specific character file is accepted — other players' files are rejected.

### Admin Panel

A password-protected admin panel for managing all games.

**Access:** Navigate to `/admin/` — you'll be prompted to log in.

**Setup:** Set `ADMIN_PASSWORD` in `server/.env`. The password is required.

**Security:** The admin login uses a challenge-response protocol so the password is never sent in plaintext — safe for HTTP networks. The client hashes the password with a one-time server nonce using SHA-256 before sending. Sessions are stored as HttpOnly cookies. All admin socket events are server-validated — even if someone bypasses the HTTP gate, every admin action checks authorization.

**Capabilities:**

- **Lobby Management** — view, connect to, and delete lobbies
- **Player Management** — view player stats, kick players, force level-ups
- **Player Events** — manually adjust XP, HP, gold, inventory, spell slots, and conditions for any player
- **Dice Rolls** — send roll-required events to specific players
- **Death Testing** — force a player's HP to 0 to trigger the death sequence
- **Game Control** — change game phase (character creation, ready check, running), advance turns
- **DM Tools** — send narration messages as the DM
- **Music Control** — change the music mood or stop playback
- **Character File Tool** — load, inspect, edit, and re-sign `.stchar` character exports

## Project Structure

```
client/                 # Browser client (vanilla JS, no build step)
  admin/                # Admin panel (password-protected)
    login.html          # Admin login screen
    login.js            # Login logic (SHA-256 challenge-response)
    admin.html          # Admin panel
    admin.js            # Admin panel logic
  components/           # UI component templates (HTML fragments)
  config/               # JSON config files
    armor.json          # Armor definitions and class restrictions
    weapons.json        # Weapon stats and class restrictions
    raceNames.json      # Name pools by race and gender
    campaignFlavors.json # Campaign tone and theme presets
    classProgression.json # Class ability unlocks per level
    library.json        # Music song list with mood tags
    voices_cache.json   # Cached ElevenLabs voice list (auto-generated, gitignored)
  music/                # Music files (.mp3)
  index.html            # Main game client
  app.js                # Client entry point and UI rendering
  charBuilder.js        # Character creation logic
  chat.js               # Chat system
  domElements.js        # Cached DOM element references
  eventHandlers.js      # UI event handler registration
  init.js               # Client initialization
  music.js              # Music manager
  sockets.js            # Socket.io event handlers
  tts.js                # Text-to-speech client
  uiComponents.js       # Reusable UI components (party table, inventory, etc.)
  style.css             # Main stylesheet
  components.css        # Component-specific styles
server/
  server.js             # Express + Socket.io server
  services/
    llmService.js       # LLM provider abstraction (OpenAI + Claude)
    lobbyStore.js       # Lobby state management and persistence
    gameUpdates.js      # Broadcast helpers for game events
    dice.js             # Dice rolling
    classProgression.js # Class ability progression data
    mapService.js       # Map system (experimental)
    utils.js            # Shared utilities
  data/
    lobbies/            # Persisted lobby JSON files
    charkey.pem         # RSA key for character file signing (auto-generated)
  .env                  # Environment variables (not committed)
  .env.example          # Template for environment variables
```

## Notes

- No API key? A local stub DM narrates so you can test the full flow.
- Lobby data persists under `server/data/lobbies/`. Character signing keys persist at `server/data/charkey.pem`.
- Music files (`.mp3`) are gitignored — add your own or set `MUSIC_REPO` to auto-download from a GitHub release.
- The admin panel is only accessible when `ADMIN_PASSWORD` is set in `.env`. The host DM tools work independently of the admin password.
- Docker files are included but gitignored — use `docker compose up -d` if you prefer containers.
