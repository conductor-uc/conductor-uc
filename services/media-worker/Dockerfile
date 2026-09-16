# syntax=docker/dockerfile:1

# Build in a full Node image. Unlike every other service here, the runtime
# stage below is NOT distroless — this service exists specifically to run
# `ffmpeg` against tenant-uploaded, untrusted audio (S2-07's own scope
# decision: that parsing happens here, isolated from pbx-config-service's
# database and tenant secrets, rather than adding a native-binary attack
# surface to a service that holds both). A real package manager to install
# `ffmpeg` is a prerequisite for that isolation, not an oversight.
FROM node:22-bookworm-slim AS build
WORKDIR /repo

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/media-worker ./services/media-worker

RUN pnpm install --frozen-lockfile --filter @cuc/media-worker...
RUN pnpm --filter @cuc/media-worker... build
RUN pnpm --filter @cuc/media-worker --prod deploy --legacy /app

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# --no-install-recommends: ffmpeg's own recommended set pulls in X11/font
# packages this headless transcode path never uses.
RUN apt-get update && \
    apt-get install --no-install-recommends -y ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home=false --uid 10001 worker

COPY --from=build --chown=worker:worker /app /app

ENV NODE_ENV=production
EXPOSE 8080
USER worker

# `GET /healthz` is liveness and `GET /readyz` is readiness; the orchestrator
# probes those rather than anything defined here (06).
CMD ["node", "dist/src/main.js"]
