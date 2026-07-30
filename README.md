# StoryTeller — AI-Powered D&D

A multiplayer, browser-based D&D experience powered by AI. Create or join a lobby, build a character, and play a rules-light one-shot with an AI Dungeon Master. The server handles turns, dice rolls, initiative, and broadcasts everything live over WebSockets.

## Prerequisites

- **Node.js** v20 or later — the test suite uses Node's built-in runner (`node --test`)
- **npm** (comes with Node.js)
- Something to play the Dungeon Master. Any one of: an OpenAI key, an Anthropic key, a Google Gemini key, or a locally-hosted model (Ollama, or anything with an OpenAI-compatible endpoint). Players can also bring their own key per lobby, so the server does not have to hold one at all. Without any of them a stub DM narrates, which is enough to test the flow but not much of a game.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/Kenji776/StoryTeller.git
cd StoryTeller
```

### 2. Install dependencies

```bash
npm install
```

Express, Socket.io, and a short list of others. **No vendor AI SDKs** — every provider adapter is plain `fetch` against the documented HTTP API, which is what makes adding a provider a single file and keeps the whole layer testable without a network ([ADR 0002](docs/decisions/0002-fetch-based-provider-adapters.md)). There is no client build step either; the client is vanilla JS served as static files.

### 3. Set up the environment file

Copy the example environment file and fill in your API keys:

```bash
cp server/.env.example server/.env
```

Open `server/.env` in a text editor. At minimum, set one of these:

- **`OPENAI_API_KEY`** — OpenAI models (GPT-5, GPT-4o, GPT-4o-mini…)
- **`ANTHROPIC_API_KEY`** — Anthropic models (Claude Opus, Sonnet, Haiku). `CLAUDE_API_KEY` is still accepted.

You can configure several and switch provider and model per-lobby in the game options.

**Keys in `.env` are imported into an encrypted vault on first run** and are then managed from the admin panel — you do not have to keep editing `.env` to change them.

Set `STORYTELLER_SECRET` or that vault is memory-only, and every key is gone on restart:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Keep it somewhere safe. Changing it later makes the existing vault unreadable — the server refuses to overwrite a vault it cannot open, so a typo costs you access rather than your keys. It never falls back to storing them in plaintext.

Optional but recommended:
- **`STORYTELLER_SECRET`** — encrypts the credential vault so keys survive a restart
- **`ADMIN_PASSWORD`** — enables the admin panel at `/admin/`
- **`ELEVEN_API_KEY`** — voice narration via ElevenLabs
- **`LOCAL_TTS_URL`** — a self-hosted narration server instead (free; seeds the first run only)
- **`DEV_MODE=TRUE`** — skip narration and image generation during development to save API calls

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

## Docker (alternative to steps 4–5)

A published image is on Docker Hub:

```
kenji776/storyteller:latest      # or :1.0.0 to pin a version
```

526 MB to download. You can also build it yourself from the `Dockerfile` here — the build is
self-contained (Node 20 Alpine, `npm install --production`, no compiler toolchain).

You need Docker Engine 20.10+ with the Compose plugin (`docker compose`, not the old
`docker-compose`). Verify with `docker compose version`.

**The image contains no credentials and no game data.** Keys, saved lobbies, portraits and the
character-signing key are all supplied at run time through the environment and volumes below.

### 1. Create your `.env` first

Docker reads the same `server/.env` as `npm start`, so do step 3 above before continuing. The
image never contains it — `.dockerignore` excludes `**/.env` at every depth, so keys are supplied
at run time and are not baked into a layer you might later push somewhere.

### 2. Copy the example compose file

```bash
cp docker-compose.example.yml docker-compose.yml
```

`docker-compose.example.yml` is tracked and holds no secrets. It pulls everything from
`server/.env` through `env_file`, which is why it is safe to commit and why you should keep your
keys out of it. `docker-compose.yml` itself is gitignored, so anything you add there stays local.

Open it if you want to change the port or the volume locations. The defaults work as-is.

### 3. Start it

To use the published image, change `build: .` to `image: kenji776/storyteller:latest` in your
compose file, then:

```bash
docker compose up -d
```

Or build from source instead — no edit needed, the example is set up for it:

```bash
docker compose up -d --build     # first build takes a few minutes
```

Either way:

```bash
docker compose logs -f          # watch it boot; it reports which providers it found
docker compose ps               # confirm it is up
```

The game is at `http://localhost:3013`, or `http://<host-ip>:3013` from other machines.

### Updating

```bash
git pull
docker compose up -d --build
```

The container is replaced; everything under the mounted volumes survives.

### What the volumes hold

Anything **not** mounted lives inside the image and is destroyed on every rebuild. The example
mounts three paths:

| Volume | Holds |
|---|---|
| `server/data` | Saved games; the encrypted key vault and provider policy; generated portraits and their galleries; the narration server address; and `charkey.pem`. |
| `client/music`, `client/sfx` | Downloaded asset packs. Without these, every rebuild re-downloads them. |

`server/data` is mounted whole rather than as four separate paths because of `charkey.pem` —
the RSA key that signs exported character files, and therefore what authenticates the host's
DM tools. It is deliberately **not** in the image, so if it is not persisted the container
generates a new one on every rebuild and every previously exported character silently stops
verifying.

The vault also needs `STORYTELLER_SECRET` set, or it is memory-only and you re-enter keys
after each restart regardless of the mount.

### Things that surprise people

- **The image is large — 641 MB unpacked, 526 MB to pull.** Music and sound effects are copied in deliberately, so a
  container can seed an empty volume on first start (see `docker-entrypoint.sh`). If you have
  already downloaded the asset packs locally, they are in the build context and go into the image.
  Add `client/music` and `client/sfx` to `.dockerignore` if you would rather keep it small and let
  the running container download them into the volume instead.
- **`PORT` appears twice**, in `environment:` and in `ports:`. Change both together or the game
  listens on a port nothing forwards to. The `environment:` value wins over `server/.env`.
- **Self-hosted narration or image servers on your LAN work fine** through the default bridge
  network. You only need `network_mode: host` if such a service is bound to the host's own
  loopback address — and that is Linux-only; on Docker Desktop it will not behave as expected.
  If you switch to it, delete the `ports:` block.
- **No API keys?** It still starts. A stub Dungeon Master narrates, so you can confirm the whole
  stack works before spending anything.

## Environment Variables

All configuration lives in `server/.env` (copy from `server/.env.example`):

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | No | OpenAI key. Imported into the vault on first run. |
| `ANTHROPIC_API_KEY` | No | Anthropic key. `CLAUDE_API_KEY` is accepted as an alias. |
| `ELEVEN_API_KEY` | No | ElevenLabs key for narration. `ELEVENLABS_API_KEY` also accepted. |
| `LOCAL_IMAGE_API_KEY` | No | Key for a self-hosted image server, if it wants one. |
| `STORYTELLER_SECRET` | No | Encrypts the credential vault (`server/data/credentials/`). Without it the vault is memory-only and keys do not survive a restart. |
| `STORYTELLER_SECRET_FILE` | No | Path to a file holding that secret, for Docker/systemd secret mounts. |
| `OPENAI_MODEL` | No | Legacy fallback for `DEFAULT_LLM_MODEL`. |
| `DEFAULT_LLM_PROVIDER` | No | `openai`, `anthropic`, `google`, `ollama`, or `openai-compatible`. `claude` is accepted and stored as `anthropic`. Falls back to `openai`. |
| `DEFAULT_LLM_MODEL` | No | Default model. Falls back to a screened recommendation, then `gpt-4o-mini`. |
| `LLM_TIMEOUT_MS` | No | LLM response timeout, ms (default: `120000`). Reasoning models need the headroom. |
| `PORT` | No | Server port (default: `3000`; the example `.env` uses `3013`). |
| `ELEVEN_VOICE_ID` | No | Default ElevenLabs voice ID. |
| `LOCAL_TTS_URL` | No | Seeds the self-hosted narration server address on first run. After that the host sets it per lobby in the settings window and it is stored in `server/data/tts-config.json`. |
| `DEV_MODE` | No | `TRUE` skips narration and image generation, and unlocks the canned-response test provider. |
| `ADMIN_PASSWORD` | No | Password for the admin panel (see [Admin Panel](#admin-panel)). |
| `FEASIBILITY_MODE` | No | `judge` lets the action gate actually refuse impossible actions. Unset means observe-only: it logs what it would have refused and allows everything. |
| `APP_VERSION` | No | Reported by `/api/features`; the deploy script bumps it. |
| `HISTORY_SUMMARIZE_THRESHOLD` | No | Unsummarized messages before auto-summarization triggers (default: `20`). |
| `MAX_SUMMARY_LENGTH` | No | Max characters in the recent arc before it is promoted to ancient history (default: `60000`). |

No key at all? A local stub DM narrates so you can test the whole flow without any external service. A host can also supply their own key for one lobby without the server ever holding one.

## Features

### AI Dungeon Master

Five providers, behind one adapter interface:

| Provider | Notes |
|---|---|
| **OpenAI** | GPT-5, GPT-4o, GPT-4o-mini and the rest; models listed live from the API |
| **Anthropic** | Claude Opus, Sonnet and Haiku |
| **Google** | Gemini |
| **Ollama** | Self-hosted, free, no key — just an address |
| **OpenAI-compatible** | Anything speaking that API: a gateway, a local runtime, a hosted proxy |

The DM narrates, resolves actions, manages combat, and returns structured JSON that drives HP, XP, inventory, music and sound effects.

**The host picks provider and model in the lobby options,** and the panel shows what is running now. Each provider is labelled with where its key comes from — this server's, your own, or a local install that needs none. A provider the server has no key for is still listed, so you can discover that supplying your own is an option; enter it there and it is held in memory for that lobby only, never written to disk. Whatever model is already in force is always offered even if the shipped catalogue has not heard of it, so opening the panel cannot silently downgrade a lobby.

The server refuses a provider/model pair that cannot work — asking OpenAI for a Claude model gets an explanation rather than a mid-game failure.

**Anything with a right answer is computed by the server, not narrated.** Dice, hit points, XP, loot values, spell slots, whether an attack is in reach — all resolved in code and handed to the model as settled fact. The model writes prose and makes judgement calls; it does not decide numbers. See [`docs/modules/combat.md`](docs/modules/combat.md).

### Adventure Board

The landing page shows all games (active and completed) in a tabbed, searchable list:

- Adventure name, world setting, tone, and player count at a glance
- Per-player online/offline indicators with host crown icon
- Search by adventure name
- Scrollable list (400px) with tabs: Starting, Active, Hibernating, Finished
- **Read Story** button on non-password-protected games lets anyone read the full story log, summary, and pinned moments
- Join running or hibernating games by reclaiming a disconnected character or creating a new one
- Password-protected lobbies display a lock icon
- **Quick Start** button randomizes all game options and character, shows a summary modal, and jumps straight into a solo game

### Lobbies

- Create a lobby and share the join code with your group
- **Password protection** — the host can set an optional lobby password. Passwords are hashed with scrypt on the server and verified with timing-safe comparison.
- **Hibernation** — when all players disconnect from a running game, it enters a hibernating state. Rejoining any character resumes the game automatically.
- Lobby data persists to disk under `server/data/lobbies/`

### Game Options

The lobby host can configure the game before starting:

- **World Setting** — Standard Fantasy, Dark Ages, Steampunk, Pirate Age, Sci-fi
- **Campaign Tone** — Heroic, Dark & Gritty, Horror, Comedy, Mystery, Political Intrigue, Survival, Swashbuckling, Tragic, Mythic
- **Campaign Theme** — Redemption, Corruption, Ancient Evil, Heist, War, Exploration, Chosen Destiny, Freeform/Sandbox, Exodus, Tournament
- **Difficulty** — Casual, Standard, Hardcore, Merciless
- **Content Intensity** — slider from 0 (Kid Safe) to 10 (Ultimate Brutality)
- **Starting Level** — begin above level 1, with the abilities and HP that implies
- **Ability Uses at Level 1** — how many ability/spell uses a fresh character gets, up to unlimited
- **Loot Generosity** — Sparse, Fair, Generous
- **Narrator Voice** — pick from the voices your narration engine offers, with preview
- **Turn Timer** — configurable duration (1–20 min), with auto-kick after missed turns
- **Combat Style** — narrated, or on a [tactical battle map](#tactical-battle-map)
- **AI Services** — provider, model, and whose API key pays (see [AI Dungeon Master](#ai-dungeon-master))
- **Illustrations** — off, key moments only, or generous

### Character Creation

Players build characters through a guided UI:

- Race, class, alignment, background, deity, gender, age
- Name auto-generation from race/gender name pools
- **Point-buy ability scores**, with a pool that scales to the lobby's starting level — 10 points at level 1, up to 125 at level 25
- Class-based weapon and armor selection
- Standard shared loadout (backpack, bedroll, rations) plus class-specific defaults
- Known spells for casters, filtered to what the class and level allow
- AI-generated character portrait, drawn from a prompt you can edit before generating (see [Portraits and Illustrations](#portraits-and-illustrations))

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

### Spellcasting

Casters have a real spell list rather than improvised magic:

- **52 spells** in `client/config/spells.json`, each with a level, school, the classes that may take it, a range, a damage expression, and how it resolves
- Casters choose their known spells during character creation, filtered to what their class and level allow
- Casting spends a slot, and the server tracks the count — the DM cannot grant a spell you have no slots for, or one you never learned
- Damage, saves and healing are rolled server-side from the spell's own definition
- The in-game panel lists what you know and what it costs, so a caster can see their options on their turn

`docs/modules/spells.md` covers what a caster knows; `docs/modules/spell-resolution.md` covers what casting does.

### Tactical Battle Map

**Off by default.** Turn it on under *Combat Style* in the game options.

Normally combat is narrated, and nobody has a position — which makes taking cover, guarding an ally, or staying out of reach into flavour text rather than decisions. With the map on, every creature stands somewhere:

- An arena is generated per encounter — a grid of 5-ft cells with walls, pillars, low walls, rubble and water, sized to the party and seeded so it is reproducible
- On your turn the squares you can actually reach are tinted green; click one and the move rides along with the action you type. An illegal move is never offered rather than refused after the fact
- **The server measures everything.** Distance, line of sight, cover and reach are computed and handed to the narrator as settled fact — a wall really blocks a spell, and you cannot strike something thirty feet away
- **Cover grants AC**, and standing between a monster and the party's healer actually works, because monsters target by proximity rather than in rotation
- The narrator chooses an enemy's *intent* — close, hold, take a shot, seek cover, withdraw, regroup — and the server turns that into a route. It never picks coordinates, and every monster has a deterministic fallback, so a fight never depends on a working language model
- The map opens in its own movable window when a fight starts, and closes when it ends. It also renders in the game view, so a blocked popup costs nothing; **Pop out map** in the Battlefield heading reopens it

Design and reasoning: [`docs/modules/tactical-map.md`](docs/modules/tactical-map.md), with the browser side in `tactical-ui.md` and the geometry in `tactical-geometry.md`.

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

Mood-based background music plays automatically during the game. Tracks are organised by folder — the path *is* the catalogue, so adding music needs no manifest:

```
client/music/
  menu/                       # played on the landing page
  game/
    default/                  # used for any world without its own set
      tense_battle/*.mp3
      tavern/*.mp3
      …
    ancient_egypt/            # world-specific sets, same mood folders
    ancient_rome/
    warring_states_japan/
```

- 11 moods: Lively Town, Tense Battle, Boss Fight, Peaceful Nature, Dungeon Ambient, Tavern, Mystery, Exploration, Sad Moment, Victory, Horror — the labels live in `client/config/music_moods.json`
- When the DM (or admin) sets a mood, the client asks the server for that world's folder and falls back to `default/` when the world has nothing for it
- Crossfade between tracks, no immediate repeats, and a volume/mute control in the upper right

To add your own, drop `.mp3` files into the matching `client/music/game/<world>/<mood>/` folder. Nothing else to edit.

On first startup, if `client/music/` is empty, the server offers to download a standard music pack from the GitHub releases.

### Sound Effects (SFX)

Contextual sound effects triggered by the AI DM during gameplay:

- The DM includes SFX descriptions in its response (e.g. "sword clash", "dragon roar")
- The server matches descriptions against a local SFX library (`client/sfx/`)
- If no match exists and ElevenLabs is configured, effects can be generated on the fly
- On first startup, if the `client/sfx/` directory is empty, the server will prompt you to download a standard SFX pack from the GitHub releases

### Story History & Summarization

The game maintains a permanent, append-only history log. Nothing is ever deleted — the full story is always available for reading. To keep the LLM context lean, a tiered summarization system runs in the background:

- **Full History** — every DM narration and player action, stored permanently
- **Recent Arc** (`storyContext`) — a detailed, structured ~800-word summary of recent events, updated every `HISTORY_SUMMARIZE_THRESHOLD` messages (default: 20)
- **Campaign Backstory** (`ancientHistory`) — a heavily compressed ~300-word overview of older events, populated when the recent arc exceeds `MAX_SUMMARY_LENGTH` (default: 60,000 chars)

On each turn, the LLM receives: the campaign backstory (if any) + the recent arc summary + the last 10 verbatim messages + the new player action. This keeps total input around ~7-8K tokens regardless of campaign length.

Summarization runs asynchronously after each turn and uses a structured format (current goal, setting, key characters, party status, story beats, open threads) to maximize information density. A `_summarizing` flag and snapshot-based bookmarking ensure race safety when turns arrive during summarization.

### Pinned Moments

Players can pin important story moments during gameplay to protect them from summary drift:

- Every story log entry has a pin button (appears on hover)
- Pinned moments are explicitly fed to the LLM during summarization and on every turn: *"Player-pinned important moments — do NOT forget or contradict these"*
- Pins survive all compression tiers, including promotion to ancient history
- Maximum 12 pins per campaign — players are warned as they approach the limit
- Pinned moments are visible in the Story Reader modal under a dedicated "Pinned" tab

### Story Reader

A modal accessible from both the Adventure Board and the in-game toolbar:

- **Full Story** tab — the complete, unabridged history log with pinned moments marked
- **Summary** tab — the campaign backstory and recent arc side by side
- **Pinned** tab — all player-pinned moments with who pinned them

### Voice Narration (TTS)

Optional spoken narration, from either of two engines:

- **A self-hosted TTS server** — free, stays on your network, no key. Point the lobby settings window at any machine and port and press **Test**: it checks the connection, loads that server's voices, and saves the address. `LOCAL_TTS_URL` only seeds the first run.
- **ElevenLabs** — requires `ELEVEN_API_KEY`.

Both are probed at boot. A new lobby prefers whichever is up, local first, and the host can switch per lobby. Neither is required — without one the game plays silently, using a reading delay before the turn timer starts.

- Narration streams in real time via the MediaSource API, with a crossfade when it stops
- Voice is chosen per lobby from whatever the active engine offers, with preview
- Word timings are estimated so narration can drive the turn timer accurately
- Suppressed in dev mode to save API calls

An address you enter is checked to be on a private network before the server will dial it, so this cannot be turned into a way to make the server fetch arbitrary URLs.

### Portraits and Illustrations

Image generation runs through the same two-provider arrangement as narration:

- **A self-hosted image server** on your network — free, no per-image cost. Configured in the admin panel; `LOCAL_IMAGE_API_KEY` if yours wants a key.
- **OpenAI Images** — requires an OpenAI key.

Both are probed at boot, and the game runs perfectly well with neither.

**Character portraits** are generated from a text prompt built out of your character sheet, which you can read and edit before generating — so if the picture is wrong, you can say why rather than reroll and hope. Portraits are saved under `server/data/images/`.

**Illustrations** are pictures of the story as it happens, controlled by the *Illustrations* setting: off, key moments only, or often. The DM marks a moment worth drawing and describes the shot; the server generates it and files it in the lobby's gallery, browsable in-game. Galleries persist under `server/data/galleries/`.

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
- **SFX Testing** — test the SFX pipeline with custom descriptions
- **AI Model Switching** — change the LLM provider and model mid-game (useful if one provider stops responding)
- **Credential Vault** — add, replace and validate the operator's API keys. Stored AES-256-GCM encrypted; the panel only ever shows the last four characters.
- **Provider Policy** — per capability and provider, decide who pays: this server's key (`shared`, with an optional model allowlist and per-lobby call cap), the player's own (`byok`), a self-hosted install (`local`), or not offered at all (`off`)
- **Self-hosted service addresses** — point the narration and image servers at a machine on your network, with a connection test. The address is checked to be private before the server will dial it.
- **Character File Tool** — load, inspect, edit, and re-sign `.stchar` character exports

## Project Structure

```
client/                 # Browser client (vanilla JS, no build step)
  admin/                # Admin console (password-protected) - see docs/modules/admin-console.md
    login.html          # Admin login screen
    login.js            # Login logic (SHA-256 challenge-response)
    admin.html          # Shell the console builds itself into
    admin.css           # Console design system
    app.js              # Boot, routing, chrome, section mounting
    nav.js              # Section registry
    core/               # State, routing, permissions, selectors (unit tested)
    ui/                 # DOM helpers and shared components
    sections/           # One renderer per section
  components/           # UI component templates (HTML fragments)
  config/               # JSON config files
    armor.json          # Armor definitions and class restrictions
    weapons.json        # Weapon stats and class restrictions
    raceNames.json      # Name pools by race and gender
    campaignFlavors.json # Campaign tone and theme presets
    classProgression.json # Class ability unlocks per level
    spells.json         # 52 spells: level, school, classes, range, damage, resolution
    sfx-library.json    # Story SFX file-to-description mapping
    ui-sfx-library.json # Interface sounds
    music_moods.json    # The mood labels (tracks are catalogued by folder)
    llm_models.json     # Models the pickers offer, by provider
    model_ratings.json  # Which models are recommended, warned about, or unfit
    voices_cache.json   # Cached voice list (auto-generated, gitignored)
  music/                # Music, by world and mood (see Music System) — auto-downloaded
  sfx/                  # Sound effect files (.mp3, auto-downloaded on first run)
  index.html            # Main game client
  app.js                # Client entry point and UI rendering
  sockets.js            # Socket.io event handlers
  charBuilder.js        # Character creation logic
  uiComponents.js       # Reusable UI components (party table, inventory, battle map)
  eventHandlers.js      # UI event handler registration
  domElements.js        # Cached DOM element references
  init.js               # Client initialization
  chat.js               # Chat system
  music.js              # Music manager
  tts.js                # Narration playback
  sfx.js                # Story sound effects
  uiSounds.js           # Interface sounds
  errorLog.js           # Client-side error capture
  # Pure modules, unit tested, attached to `window` for the classic scripts above
  aiPanel.js            # AI settings rows, the Start gate, the narrator model picker
  tacticalMap.js        # Battle map view model (what is clickable, what is pending)
  battleMapWindow.js    # When the map's pop-out window opens and closes
  itemSlots.js          # Which inventory items are equippable, and where
  knownSpells.js        # Describing what a caster knows
  portraitPrompt.js     # Building an editable portrait prompt
  galleryView.js        # Illustration gallery
  difficulty.js         # Difficulty labels and effects
  modelRatings.js       # Model recommendation badges
  style.css             # Main stylesheet
  components.css        # Component-specific styles
server/
  server.js             # Express + Socket.io server, and the turn pipeline
  routes/               # Socket and HTTP surfaces
    aiSetup.js          # Credential and model configuration (host-gated)
    adminEvents.js      # Admin console socket events
    adminAuth.js        # Challenge-response admin login
    chatEvents.js       # Chat
    sessionEvents.js    # Reconnect, replay, durable sessions
    turnTimer.js        # Turn timers and the DM call
    providerAdmin.js    # Operator provider/policy management
    ttsService.js       # Narration endpoints
  services/
    llm/                # Provider registry + adapters (openai, anthropic, google,
                        #   ollama, openai-compatible, canned test provider)
    llmGateway.js       # Chooses a credential and calls a provider
    credentials/        # Encrypted operator vault, provider policy, host keys
    tactical/           # Battle map: grid, sight, movement, arena, enemy tactics
    tts/                # Narration registry: ElevenLabs + self-hosted
    images/             # Portraits, illustrations, galleries; two providers
    lobby/              # Lobby state split by concern (combat, players, settings…)
    bakeoff/            # Measuring which models can actually run a game
    net/                # Private-network URL validation for self-hosted services
    spellbook.js        # What a caster knows and what casting costs
    spellAttacks.js     # Resolving a cast spell
    playerAttacks.js    # Resolving a weapon attack
    enemyTurns.js       # The monsters' round
    loot.js             # Server-rolled treasure
    experience.js       # XP and levelling
    actionGate.js       # Refusing impossible actions
    eventTaxonomy.js    # Which events may be replayed to a reconnecting client
    lobbyStore.js       # Lobby persistence
    gameUpdates.js      # Broadcast helpers for game events
    sfxService.js       # Sound effect matching and generation
    mapService.js       # An older, simpler map (character list + terrain type). Still
                        #   written on every DM reply; its viewer is disabled in the UI.
                        #   Superseded by tactical/ and kept only for its own data.
  helpers/
    dice.js             # Dice rolling
    parseDMJson.js      # Salvaging structured JSON out of a model's reply
    classProgression.js # Class ability progression data
    assetDownloads.js   # First-run music/SFX pack downloads
    utils.js            # Shared utilities
  config/               # loot-tables.json
  test-integration/     # Live probes and simulations; not part of `npm test`
  tools/                # One-off operator scripts
  data/
    lobbies/            # Persisted lobby JSON files
    credentials/        # Everything secret, and a README about locking it down
      README.md         #   what is in here, and the permissions for your platform
      charkey.pem       #   RSA key signing character files (auto-generated)
      credentials.enc   #   API keys, encrypted under STORYTELLER_SECRET
      provider-policy.json  # who pays for what — no secrets, hand-editable
    images/             # Generated portraits and illustrations
    galleries/          # Per-lobby illustration galleries
    tts-config.json     # Self-hosted narration server address
  .env                  # Environment variables (not committed)
  .env.example          # Template for environment variables
docs/                   # Architecture, module docs, ADRs, testing, worklog
```

Almost every `.js` above has a `.test.js` beside it. `npm test` runs the unit tier —
no network, no clock, no disk — and `docs/testing.md` explains the tiers.

## Documentation

`docs/` is the durable record and goes deeper than this file:

- [`docs/README.md`](docs/README.md) — index, and how to run each test tier
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit and where the boundaries are
- [`docs/modules/`](docs/modules/) — one document per subsystem
- [`docs/decisions/`](docs/decisions/) — ADRs: what was chosen, what was rejected, and why. The rejected paths are the useful part.
- [`docs/testing.md`](docs/testing.md) — tiers, conventions, and what is deliberately untested

## Notes

- No API key? A local stub DM narrates so you can test the full flow.
- **What persists:** lobbies (`server/data/lobbies/`), everything secret (`server/data/credentials/` — the encrypted vault, the provider policy, and `charkey.pem`), portraits and galleries (`server/data/images/`, `galleries/`), and the narration server address (`tts-config.json`). Set `STORYTELLER_SECRET` or the vault is memory-only.
- **`server/data/credentials/` has its own [README](server/data/credentials/README.md)** covering what each file is, what losing it costs, and the permissions to set on Linux, macOS, Docker, Windows and a network share. The server warns at startup if that folder is readable beyond its owner, and never refuses to boot over it.
- A host's own API key is held **in memory only**, never written to disk, and dropped when they disconnect or the lobby ends.
- Music and SFX (`.mp3`) are gitignored — on first startup the server offers to download standard packs from GitHub releases, or add your own.
- The admin panel needs `ADMIN_PASSWORD`. The host DM tools work independently of it, authenticating with the host's signed character file instead.
- `docker-compose.yml` is gitignored so your local one can hold whatever it needs. Start from `docker-compose.example.yml`, which is tracked and keeps every secret in `server/.env` — see [Docker](#docker-alternative-to-steps-45).
- The tactical battle map is off by default and changes nothing when off — no generation, no prompt additions, no map. Existing games play exactly as before.
