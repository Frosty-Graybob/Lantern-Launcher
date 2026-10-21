# Game Launcher server
#
#   docker build -t game-launcher-server .
#   docker run -d -p 5155:5155 -v /path/to/your/games:/games:ro game-launcher-server
#
# Each game goes in its own folder inside /games, with its installer (and any .bin
# files) in that folder. The server only ever reads it, so mount it read-only.

FROM node:20-alpine

LABEL org.opencontainers.image.title="Game Launcher server" \
      org.opencontainers.image.description="Serves a library of game installers to the Game Launcher app"

ENV NODE_ENV=production \
    PORT=5155 \
    HOST=0.0.0.0 \
    LIBRARY_ROOT=/games \
    RUNNING_IN_DOCKER=1

WORKDIR /app

# The same package.json also describes the Windows app. Here only the server's own
# two dependencies are wanted, so drop everything else before installing.
COPY package.json ./
RUN npm pkg delete devDependencies build scripts.app scripts.dist \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY src ./src

# The server never writes anything, so it doesn't need to run as root.
# (On TrueNAS, run it as the user that can read your games dataset: see the README.)
USER node

EXPOSE 5155
VOLUME ["/games"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/cli.js"]
