# Dalio api — Phase 7 (DEPLOYMENT.md). Multi-stage: the build stage compiles
# the pnpm workspace; `pnpm deploy` then produces a self-contained production
# node_modules for @dalio/api only, so the runtime image carries no dev
# toolchain and no sibling apps. Entrypoint applies migrations, then boots.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo

# Manifests first: dependency layers cache until a lockfile change.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @dalio/shared --filter @dalio/api

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @dalio/shared build && pnpm --filter @dalio/api build
# Self-contained prod bundle (workspace deps inlined, dev deps dropped).
RUN pnpm --filter @dalio/api deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S dalio && adduser -S dalio -G dalio
COPY --from=build --chown=dalio:dalio /out/node_modules ./node_modules
COPY --from=build --chown=dalio:dalio /out/package.json ./
COPY --from=build --chown=dalio:dalio /repo/apps/api/dist ./dist
COPY --from=build --chown=dalio:dalio /repo/apps/api/drizzle ./drizzle
USER dalio
EXPOSE 3000
# Migrations are forward-only and journal-idempotent — safe on every boot.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/main.js"]
