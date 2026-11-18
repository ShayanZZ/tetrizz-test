# syntax=docker/dockerfile:1
#
# Two images from one file (build context: the repository root):
#   --target server   the room server (apps/server): Node, no build tools, runs as the node user
#   --target web      Caddy with the built page (apps/web/dist) and deploy/Caddyfile
# compose.yaml builds both. Versions are looked up live when this file changes (docs/DOCKER.md).

ARG NODE_VERSION=26.13.1
ARG CADDY_VERSION=2.11.7

# Only the package manifests, so the dependency layers are reused until a dependency changes.
FROM node:${NODE_VERSION}-trixie-slim AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/bot/package.json packages/bot/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/

FROM manifests AS deps-all
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM manifests AS deps-prod
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace @tetrizz/server --no-audit --no-fund

FROM deps-all AS build-server
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN npm run build -w @tetrizz/server

FROM deps-all AS build-web
# Optional, for a page that should also offer Supabase or other brokers (docs/DEPLOYMENT.md).
# Not needed for the room server in this stack: Caddy hands the page its address in /config.json.
ARG TETRIZZ_SUPABASE_URL=
ARG TETRIZZ_SUPABASE_KEY=
ARG TETRIZZ_MQTT_BROKERS=
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build -w @tetrizz/web

# ---- the room server ----
FROM node:${NODE_VERSION}-trixie-slim AS server
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=deps-prod --chown=node:node /repo/node_modules ./node_modules
COPY --from=build-server --chown=node:node /repo/apps/server/dist ./dist
COPY --chown=node:node apps/server/package.json ./package.json
COPY --chown=node:node apps/server/tools ./tools
USER node
EXPOSE 8787
# /healthz answers 200 while the process runs; node itself is the only tool in the image that is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

# ---- the page and the front door ----
FROM caddy:${CADDY_VERSION}-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build-web /repo/apps/web/dist /srv
# The admin API listens on localhost inside the container only; asking it for its config proves Caddy runs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:2019/config/ || exit 1
