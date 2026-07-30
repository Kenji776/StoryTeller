# --------------------------------------------------
#  StoryTeller AI Powered D&D Like Game
# --------------------------------------------------
FROM node:20-alpine

# unzip is needed to extract asset packs downloaded at first startup
RUN apk add --no-cache unzip

# Create working directory
WORKDIR /app/

# Copy only package files first (cache-friendly)
COPY package*.json ./

# Install dependencies (prod only)
RUN npm install --production

# Copy the rest of your project
COPY . .

# A seed copy of the audio, outside the volume mount path. The entrypoint copies it into
# /app/client/music on first start when the mounted directory is empty, so the files end up
# visible on the host.
#
# Tolerant of the assets being absent, which is the default: `.dockerignore` excludes
# client/music and client/sfx, because carrying them made the image 641 MB — the same audio
# twice, once in client/ and once here. Without them the image is a fraction of that and the
# server downloads the packs on first run instead, which takes a few seconds and is the same
# path a fresh clone already takes.
#
# Delete those two lines from `.dockerignore` to get an image that needs no network on first
# start; this step then seeds from them exactly as before.
RUN mkdir -p /app/music-seed /app/sfx-seed && \
    (cp -r /app/client/music/. /app/music-seed/ 2>/dev/null || true) && \
    (cp -r /app/client/sfx/. /app/sfx-seed/ 2>/dev/null || true)

# Optional metadata (just documentation, not functional)
LABEL maintainer="Kenji776 <dev@kenji776-labs.org>"
LABEL description="StoryTeller AI Powered D&D"

# Default environment (overridden by .env via docker-compose)
ENV NODE_ENV=production

# Entrypoint seeds volume directories before starting the server
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "./server/server.js"]
