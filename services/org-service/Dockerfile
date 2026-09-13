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
COPY services/org-service ./services/org-service

RUN pnpm install --frozen-lockfile --filter @cuc/org-service...
RUN pnpm --filter @cuc/org-service... build

# Drop dev dependencies from what gets copied into the runtime image.
RUN pnpm --filter @cuc/org-service... --prod deploy /app

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
