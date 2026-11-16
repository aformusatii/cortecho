# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: install all dependencies and build the web app.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

# Copy only the manifests first, so the `npm ci` layer is cached until a
# dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# better-sqlite3 ships prebuilt binaries for linux-x64/arm64 (glibc), so no
# compiler toolchain is needed here (see "allowScripts" in package.json).
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: the runtime image. Only production dependencies, the API source
# (Node runs the .ts files directly) and the built web app.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/app.db
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist
# The `cortecho` command (doctor), available as `docker compose exec app cortecho doctor`.
COPY --from=build /app/bin ./bin
RUN ln -s /app/bin/cortecho.mjs /usr/local/bin/cortecho

# The SQLite file lives in /app/data, which docker-compose mounts as a volume.
# Run as the unprivileged `node` user that the official image provides.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000

# Uses Node's built-in fetch, so the slim image needs no curl.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# server.ts runs pending migrations before it starts listening.
CMD ["node", "apps/api/src/server.ts"]
