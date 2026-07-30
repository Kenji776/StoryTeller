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

# Store a seed copy of the music outside the volume mount path.
# The entrypoint copies this to /app/client/music on first start when the
# host volume directory is empty, making the files visible on the host.
RUN cp -r /app/client/music /app/music-seed && \
    cp -r /app/client/sfx /app/sfx-seed

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
