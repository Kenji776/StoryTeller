#!/bin/sh
# Seed the music and sfx volumes from the image's bundled copies if the host
# directories are empty. This runs on every container start but only copies
# when needed. Music and SFX live in game/ and menu/ (or ui/) subfolders.

# Seed game music
GAME_MUSIC_DIR=/app/client/music/game
SEED_GAME_MUSIC=/app/music-seed/game
mkdir -p "$GAME_MUSIC_DIR"
if [ -d "$SEED_GAME_MUSIC" ] && [ "$(ls -A "$SEED_GAME_MUSIC"/*.mp3 2>/dev/null)" ] && [ ! "$(ls -A "$GAME_MUSIC_DIR"/*.mp3 2>/dev/null)" ]; then
  echo "🎵 Seeding game music from image defaults..."
  cp "$SEED_GAME_MUSIC"/*.mp3 "$GAME_MUSIC_DIR"/ 2>/dev/null
  echo "🎵 Game music seeded: $(ls "$GAME_MUSIC_DIR"/*.mp3 2>/dev/null | wc -l) mp3 files"
fi

# Seed menu music
MENU_MUSIC_DIR=/app/client/music/menu
SEED_MENU_MUSIC=/app/music-seed/menu
mkdir -p "$MENU_MUSIC_DIR"
if [ -d "$SEED_MENU_MUSIC" ] && [ "$(ls -A "$SEED_MENU_MUSIC"/*.mp3 2>/dev/null)" ] && [ ! "$(ls -A "$MENU_MUSIC_DIR"/*.mp3 2>/dev/null)" ]; then
  echo "🎵 Seeding menu music from image defaults..."
  cp "$SEED_MENU_MUSIC"/*.mp3 "$MENU_MUSIC_DIR"/ 2>/dev/null
  echo "🎵 Menu music seeded: $(ls "$MENU_MUSIC_DIR"/*.mp3 2>/dev/null | wc -l) mp3 files"
fi

# Seed game SFX
GAME_SFX_DIR=/app/client/sfx/game
SEED_GAME_SFX=/app/sfx-seed/game
mkdir -p "$GAME_SFX_DIR"
if [ -d "$SEED_GAME_SFX" ] && [ "$(ls -A "$SEED_GAME_SFX"/*.mp3 2>/dev/null)" ] && [ ! "$(ls -A "$GAME_SFX_DIR"/*.mp3 2>/dev/null)" ]; then
  echo "🔊 Seeding game SFX from image defaults..."
  cp "$SEED_GAME_SFX"/*.mp3 "$GAME_SFX_DIR"/ 2>/dev/null
  echo "🔊 Game SFX seeded: $(ls "$GAME_SFX_DIR"/*.mp3 2>/dev/null | wc -l) mp3 files"
fi

# Seed UI SFX
UI_SFX_DIR=/app/client/sfx/ui
SEED_UI_SFX=/app/sfx-seed/ui
mkdir -p "$UI_SFX_DIR"
if [ -d "$SEED_UI_SFX" ] && [ "$(ls -A "$SEED_UI_SFX"/*.mp3 2>/dev/null)" ] && [ ! "$(ls -A "$UI_SFX_DIR"/*.mp3 2>/dev/null)" ]; then
  echo "🔊 Seeding UI SFX from image defaults..."
  cp "$SEED_UI_SFX"/*.mp3 "$UI_SFX_DIR"/ 2>/dev/null
  echo "🔊 UI SFX seeded: $(ls "$UI_SFX_DIR"/*.mp3 2>/dev/null | wc -l) mp3 files"
fi

# Seed the lobbies directory if it doesn't exist
mkdir -p /app/server/data/lobbies

exec "$@"
