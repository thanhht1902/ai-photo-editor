# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends imagemagick ghostscript \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS checks
RUN npm run lint && npm test

FROM base AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    SRGB_PROFILE=/usr/share/color/icc/ghostscript/srgb.icc

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && mkdir -p /app/data \
    && chown node:node /app/data
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node server ./server

USER node
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/main.ts"]
