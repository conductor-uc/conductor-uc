# syntax=docker/dockerfile:1

# Build in a full Node image, run in distroless as a non-root user.
FROM node:22-bookworm-slim AS build
WORKDIR /repo

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/cdr-service ./services/cdr-service

RUN pnpm install --frozen-lockfile --filter @cuc/cdr-service...
RUN pnpm --filter @cuc/cdr-service... build

RUN pnpm --filter @cuc/cdr-service --prod deploy --legacy /app

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /app /app

ENV NODE_ENV=production
EXPOSE 8080
USER nonroot

CMD ["dist/src/main.js"]
