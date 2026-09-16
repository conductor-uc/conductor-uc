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

# DEBIAN_FRONTEND=noninteractive: without it, ffmpeg's own dependency tree
# (tzdata, pulled in transitively) can prompt for a timezone during its
# postinst script — `-y` only auto-answers apt's own "continue? [Y/n]", not
# debconf prompts a package's *own* postinst raises, and with no TTY in a
# `docker build` that hangs the build indefinitely rather than failing
# loudly (a well-documented Debian/Docker interaction, not specific to this
# package). `TZ` gives debconf's own noninteractive path a concrete answer
# rather than an arbitrary default. --no-install-recommends: ffmpeg's own
# recommended set pulls in X11/font packages this headless transcode path
# never uses.
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC
RUN apt-get update && \
    apt-get install --no-install-recommends -y ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --no-create-home --uid 10001 worker

COPY --from=build --chown=worker:worker /app /app

ENV NODE_ENV=production
EXPOSE 8080
USER worker

# `GET /healthz` is liveness and `GET /readyz` is readiness; the orchestrator
# probes those rather than anything defined here (06).
CMD ["node", "dist/src/main.js"]
