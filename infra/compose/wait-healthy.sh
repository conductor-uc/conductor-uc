#!/bin/sh
# Polls `docker compose ps` until every service in this stack reports
# healthy, or bails out after $1 seconds (default 60, matching S0-05's done
# criterion). Run from anywhere; always operates on this stack.
set -eu
cd "$(dirname "$0")"

timeout=${1:-60}
elapsed=0

while :; do
  unhealthy=$(docker compose ps --format '{{.Name}} {{.Health}}' | awk '$2 != "healthy" { print }')
  if [ -z "$unhealthy" ]; then
    echo "All services healthy after ${elapsed}s."
    exit 0
  fi
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "Timed out after ${timeout}s waiting for:" >&2
    echo "$unhealthy" >&2
    docker compose ps >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
