# syntax=docker/dockerfile:1
# LingXi Engine — production image (multi-stage)
#
#   docker build -t lingxi-engine .
#   docker compose up -d        # see docker-compose.yml
#
# Notes:
# - devDependencies are intentionally kept: the runtime entry is `tsx index.ts`
#   (TypeScript runner), which lives in devDependencies.
# - --omit=optional skips puppeteer / node-datachannel / bonjour-service.
#   All three are lazy-loaded with graceful degradation:
#     * node-datachannel missing -> P2P falls back to relay-only mode
#     * bonjour-service missing  -> LAN discovery falls back to UDP broadcast
#     * puppeteer missing        -> browser tool reports "not installed"
# - better-sqlite3 ships prebuilt binaries for linux-x64/node20; the build
#   toolchain below is only a fallback for source compilation.

########## Stage 1: dependencies ##########
FROM node:20-bookworm AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --no-audit --no-fund

########## Stage 2: runtime ##########
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    LINGXI_DATA_DIR=/app/data \
    PORT=3456
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3456
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./node_modules/.bin/tsx", "index.ts"]
