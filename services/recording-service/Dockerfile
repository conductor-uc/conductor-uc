# syntax=docker/dockerfile:1

# Build in a full Node image, run in distroless as a non-root user.
FROM node:22-bookworm-slim AS build
WORKDIR /repo

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Copy only what the install needs first, so a source edit does not invalidate
# the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/recording-service ./services/recording-service

RUN pnpm install --frozen-lockfile --filter @cuc/recording-service...
RUN pnpm --filter @cuc/recording-service... build

# Drop dev dependencies from what gets copied into the runtime image.
# No `...` here (unlike the two steps above): `pnpm deploy`'s own
# `--filter` names exactly one target project and resolves its dependency
# tree itself — passing the "include dependencies" filter modifier trips
# `ERR_PNPM_CANNOT_DEPLOY_MANY` since it (correctly) matches this workspace's
# other packages too. `--legacy`: pnpm 10's default deploy mode needs
# `inject-workspace-packages=true` in .npmrc, which would switch every
# workspace package (not just this deploy step) from symlinked to copied
# dependencies — exactly what root .npmrc's own comment says not to relax.
# `--legacy` keeps that policy untouched and deploys by copying instead
# (the same effect, scoped to this one build step). Both of these deploy
# bugs were confirmed directly: never caught before S1-14, the first task
# to actually build one of these images.
RUN pnpm --filter @cuc/recording-service --prod deploy --legacy /app

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

# Distroless nonroot is uid 65532. No shell, no package manager, nothing to
# exec into — which is the point.
COPY --from=build --chown=nonroot:nonroot /app /app

ENV NODE_ENV=production
EXPOSE 8080
USER nonroot

# `GET /healthz` is liveness and `GET /readyz` is readiness; the orchestrator
# probes those rather than anything defined here (06).
CMD ["dist/src/main.js"]
