# syntax=docker/dockerfile:1.7
#
# Production images for OrderLoop. One file, one target per image, built from the REPOSITORY ROOT:
#
#   docker build -f deploy/Dockerfile --target api     -t orderloop-api     .
#   docker build -f deploy/Dockerfile --target worker  -t orderloop-worker  .
#   docker build -f deploy/Dockerfile --target migrate -t orderloop-migrate .
#   docker build -f deploy/Dockerfile --target web     -t orderloop-web     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
#   docker build -f deploy/Dockerfile --target ops     -t orderloop-ops     .
#
# (deploy/docker-compose.yml does exactly this.) Why one multi-target file: api, worker and migrate share the install and the
# build of the workspace packages, so building all of them costs one install and one compile, and cannot drift apart.
#
# Monorepo handling (the equivalent of `turbo prune`, justified): `pnpm install --filter <app>...` installs only what the app and
# its workspace dependencies need, from a layer that depends ONLY on package manifests + the lockfile (so a source change does
# not reinstall); `pnpm deploy --prod` then copies the app and its production dependencies into a standalone directory, which is
# all the runtime image contains. No dev dependencies, no source, no tests, no build tooling reach a runtime image.

# Exact Node version, same major as .nvmrc (checked by scripts/check-deploy.test.mjs). Update both together, deliberately.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
# Same as "packageManager" in package.json (checked by the same test).
ARG PNPM_VERSION=11.28.6
# Same major as the postgres service in docker-compose.yml (pg_dump must not be older than the server).
ARG POSTGRES_IMAGE=postgres:16.15-bookworm

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /repo

# Only the manifests, so the install layer is reused until a dependency changes.
FROM base AS manifests
COPY . /src
RUN mkdir /out \
 && cd /src \
 && find . \( -name node_modules -o -name .next -o -name dist \) -prune -o -name package.json -print \
    | xargs -I{} cp --parents {} /out \
 && cp pnpm-lock.yaml pnpm-workspace.yaml /out/

# ---------------------------------------------------------------------------------------------------------------------
# api, worker, migrate: install, compile, deploy
FROM base AS server-deps
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter "@orderloop/api..." --filter "@orderloop/worker..." --filter "@orderloop/db..."

FROM server-deps AS server-build
COPY . .
# Topological build of the packages the three need (prisma generate + tsc). The mobile and web workspaces are not touched.
RUN pnpm --filter "@orderloop/api..." --filter "@orderloop/worker..." --filter "@orderloop/db..." run build

# The Prisma CLI and its studio/dev tooling arrive as an automatic peer of @prisma/client; the runtime uses only the client and
# the pg driver adapter (checked: `new Database(...)` works without them). Dropping them removes ~180 MB and a toolchain.
ENV PRUNE_PRISMA_CLI="prisma@* @prisma+studio-core* @prisma+dev@* @electric-sql+pglite* @prisma+engines@* @prisma+fetch-engine* @prisma+get-platform@7.2.0 @prisma+query-plan-executor* @prisma+streams-local* effect@*"

# `pnpm deploy --prod --legacy` writes <app> + its production node_modules (workspace packages copied in) into one directory.
FROM server-build AS api-deploy
RUN pnpm --filter @orderloop/api deploy --prod --legacy /out \
 && cd /out && rm -rf src test vitest*.ts eslint.config.mjs tsconfig*.json nest-cli.json \
 && cd node_modules/.pnpm && rm -rf ${PRUNE_PRISMA_CLI}

FROM server-build AS worker-deploy
RUN pnpm --filter @orderloop/worker deploy --prod --legacy /out \
 && cd /out && rm -rf src vitest*.ts eslint.config.mjs tsconfig*.json \
 && cd node_modules/.pnpm && rm -rf ${PRUNE_PRISMA_CLI}

# The migrate job needs the Prisma CLI, which `@orderloop/db` lists as a dev dependency: install it WITH dev dependencies, once,
# in this one-shot image (it never serves traffic). The cost is size, not exposure: the image has no listening port.
FROM server-build AS migrate-deploy
# With OpenSSL present, Prisma's postinstall downloads the schema engine built for it (openssl-3.0.x); without, it picks the wrong one.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pnpm --filter @orderloop/db deploy --legacy /out \
 && cd /out && rm -rf src eslint.config.mjs tsconfig.json

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
# Non-root: the image's built-in unprivileged `node` user (uid 1000).
USER node
WORKDIR /app

FROM runtime-base AS api
COPY --from=api-deploy --chown=node:node /out/ /app/
ENV API_PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=4s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM runtime-base AS worker
COPY --from=worker-deploy --chown=node:node /out/ /app/
ENV WORKER_HEALTH_PORT=4010
EXPOSE 4010
# Ready = Redis, PostgreSQL and the heartbeat loop all fine (apps/worker/src/health-server.ts).
HEALTHCHECK --interval=15s --timeout=4s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4010)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM runtime-base AS migrate
# Prisma's schema engine needs OpenSSL, which the slim Node image does not ship.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
USER node
COPY --from=migrate-deploy --chown=node:node /out/ /app/
COPY --chown=node:node deploy/migrate.mjs deploy/setup-ops-roles.mjs /app/deploy/
# One-shot: roles (idempotent), then `prisma migrate deploy` as the owner role, then a status check. Exit code says whether it worked.
CMD ["node", "deploy/migrate.mjs"]

# ---------------------------------------------------------------------------------------------------------------------
# web: Next.js standalone output. NEXT_PUBLIC_* values are compiled into the browser bundle, so they are BUILD arguments:
# changing the public API address means building this image again.
FROM base AS web-deps
COPY --from=manifests /out/ ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@orderloop/web..."

FROM web-deps AS web-build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_ENV=production
# Shown on the public /data-deletion page; blank means "use the page's placeholder" (set a real address before launch).
ARG NEXT_PUBLIC_PRIVACY_CONTACT=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV} \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
COPY . .
# A build without a public API address would ship a bundle that calls http://localhost:4000 from every browser.
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "NEXT_PUBLIC_API_URL build argument is required" >&2; exit 1)
RUN if [ -z "$NEXT_PUBLIC_PRIVACY_CONTACT" ]; then unset NEXT_PUBLIC_PRIVACY_CONTACT; fi; \
    pnpm --filter "@orderloop/web^..." run build && pnpm --filter @orderloop/web exec next build

FROM runtime-base AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
# The standalone server (traced node_modules included), then the static files and public assets it expects beside it.
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone/ /app/
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static /app/apps/web/.next/static
COPY --from=web-build --chown=node:node /repo/apps/web/public /app/apps/web/public
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------------------------------------------------
# ops: backups and the restore drill. PostgreSQL's own image (same major as the server) plus age (encryption), rclone (optional
# S3-compatible upload), redis-cli (reports the last backup time to the API's /metrics) and jq. Runs as the `postgres` user.
FROM ${POSTGRES_IMAGE} AS ops
RUN apt-get update \
 && apt-get install -y --no-install-recommends age rclone redis-tools jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root ops/*.sh /opt/orderloop/ops/
RUN chmod 0755 /opt/orderloop/ops/*.sh && mkdir -p /backups && chown postgres:postgres /backups
USER postgres
WORKDIR /opt/orderloop/ops
ENV PATH="/opt/orderloop/ops:${PATH}"
VOLUME ["/backups"]
CMD ["backup-loop.sh"]
