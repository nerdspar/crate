# syntax=docker/dockerfile:1
#
# Crate server image: builds the shelf + admin bundles and serves them alongside the
# Fastify API. Multi-arch friendly (x64 + arm64 / Raspberry Pi) — better-sqlite3 and
# sharp ship prebuilt binaries for both; build tools are kept as a fallback.

# ---------- builder: install deps + build the front-ends ----------
FROM node:22-bookworm AS builder
WORKDIR /app

# Fallback toolchain for any arch without a native prebuild.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Manifests first so `npm ci` caches unless dependencies change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/providers/package.json packages/providers/
COPY apps/server/package.json apps/server/
COPY apps/shelf/package.json apps/shelf/
COPY apps/admin/package.json apps/admin/
RUN npm ci

# Sources, then build the shelf + admin bundles the server serves.
COPY . .
RUN npm run build

# ---------- runtime: server + built bundles ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CRATE_HOST=0.0.0.0 \
    CRATE_PORT=8080 \
    CRATE_DATA_DIR=/data

# node_modules carries the native binaries + tsx; apps/* now include shelf/dist + admin/dist.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps

VOLUME ["/data"]
EXPOSE 8080

# Run from the server workspace so config.ts resolves ../shelf/dist + ../admin/dist.
# `node --import tsx` execs node as PID 1 (clean SIGTERM) with tsx running the TS entry.
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
