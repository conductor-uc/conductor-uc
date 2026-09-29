#!/usr/bin/env bash
# S4-11: rehearses infra/deploy on one machine. Each server of the reference
# layout (10-production-topology.md) is a Docker-in-Docker container with its
# own address on one private network, running its role's compose file exactly
# as a real server would, with host networking inside it: two edges, two app
# servers, three data servers, one media server. A local registry stands in for
# ghcr.io, MinIO for object storage, Mailpit for email.
#
#   rehearse.sh images   build the images at this commit and push them to the
#                        rehearsal's registry
#   rehearse.sh up       start the servers and deploy every role, in order
#   rehearse.sh test     the live check (tests/sip/rehearsal): calls through the
#                        edge's floating address, then a whole edge, app and
#                        data server killed in turn, a call after each
#   rehearse.sh down     remove the servers (the registry and its images stay)
#   rehearse.sh purge    remove everything it made
#
# Needs about 20 GB of disk and 8 GB of memory; stop the development stack
# first (`docker compose stop` in infra/compose) if the machine is small.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(dirname "$HERE")"
REPO="$(cd "$DEPLOY/../.." && pwd)"
NET=cuc-rehearsal
SUBNET=10.10.0.0/24
REGISTRY_IP=10.10.0.5
# The host pushes through a published port (a localhost registry needs no TLS);
# the servers pull on the private network.
PUSH=127.0.0.1:15000/cuc
PULL=${REGISTRY_IP}:5000/cuc
RELEASE=rehearsal

# name address role
SERVERS=(
  "data1 10.10.0.31 data"
  "data2 10.10.0.32 data"
  "data3 10.10.0.33 data"
  "app1 10.10.0.21 app"
  "app2 10.10.0.22 app"
  "media1 10.10.0.41 media"
  "edge1 10.10.0.11 edge"
  "edge2 10.10.0.12 edge"
)

# local image -> released name
IMAGES=(
  "conductor-uc-identity-service identity-service"
  "conductor-uc-org-service org-service"
  "conductor-uc-pbx-config-service pbx-config-service"
  "conductor-uc-trunk-service trunk-service"
  "conductor-uc-callflow-service callflow-service"
  "conductor-uc-voicemail-service voicemail-service"
  "conductor-uc-recording-service recording-service"
  "conductor-uc-cdr-service cdr-service"
  "conductor-uc-telephony-config telephony-config"
  "conductor-uc-call-control call-control"
  "conductor-uc-media-worker media-worker"
  "conductor-uc-notification-service notification-service"
  "conductor-uc-opensips opensips"
  "conductor-uc-freeswitch freeswitch"
  "cuc-data-ha-galera-1 galera"
  "cuc-data-ha-redis-1 redis-ha"
  "cuc-data-ha-haproxy internal-lb"
)

log() { printf '\n==> %s\n' "$*"; }
in_server() { local server="$1"; shift; docker exec "rh-$server" "$@"; }

cmd_images() {
  log "building images at $(git -C "$REPO" rev-parse --short HEAD)"
  (cd "$REPO/infra/compose" && docker compose build)
  (cd "$REPO/infra/data-ha" && docker compose -f compose.yml build galera-1 redis-1 haproxy)
  # The released gateway carries the console (O-5); a stub stands in for
  # `flutter build web` here.
  local console; console="$(mktemp -d)"
  echo '<!doctype html><title>console</title>' > "$console/index.html"
  docker build --build-arg BASE=conductor-uc-api-gateway \
    -f "$REPO/services/api-gateway/Dockerfile.release" -t conductor-uc-api-gateway-release "$console"
  rm -rf "$console"
  IMAGES+=("conductor-uc-api-gateway-release api-gateway")

  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
  docker inspect rh-registry >/dev/null 2>&1 || docker run -d --name rh-registry --network "$NET" \
    --ip "$REGISTRY_IP" -p 127.0.0.1:15000:5000 -v rh-registry:/var/lib/registry registry:2 >/dev/null
  for pair in "${IMAGES[@]}"; do
    read -r local name <<<"$pair"
    docker tag "$local" "$PUSH/$name:$RELEASE"
    docker push -q "$PUSH/$name:$RELEASE"
  done
}

platform_env() {
  sed \
    -e "s|^IMAGE_REGISTRY=.*|IMAGE_REGISTRY=${PULL}|" \
    -e "s|^RELEASE=.*|RELEASE=${RELEASE}|" \
    -e "s|^PLATFORM_BASE_DOMAIN=.*|PLATFORM_BASE_DOMAIN=platform.test|" \
    -e "s|^STORAGE_ENDPOINT=.*|STORAGE_ENDPOINT=http://10.10.0.6:9000|" \
    -e "s|^STORAGE_ORIGIN=.*|STORAGE_ORIGIN=http://10.10.0.6:9000|" \
    -e "s|^STORAGE_FORCE_PATH_STYLE=.*|STORAGE_FORCE_PATH_STYLE=true|" \
    -e "s|^STORAGE_ACCESS_KEY_ID=.*|STORAGE_ACCESS_KEY_ID=rehearsal|" \
    -e "s|^STORAGE_SECRET_ACCESS_KEY=.*|STORAGE_SECRET_ACCESS_KEY=rehearsal-secret|" \
    -e "s|^SMTP_HOST=.*|SMTP_HOST=10.10.0.7|" \
    -e "s|^SMTP_PORT=.*|SMTP_PORT=1025|" \
    -e "s|^SMTP_USER=.*|SMTP_USER=|" \
    -e "s|^SMTP_PASSWORD=.*|SMTP_PASSWORD=|" \
    "$DEPLOY/platform.env.example" |
    # The development stack's secrets, which the SIP test harness assumes.
    sed \
      -e "s|^INTERNAL_SERVICE_TOKEN=.*|INTERNAL_SERVICE_TOKEN=dev-internal-service-token|" \
      -e "s|^INTERNAL_HEADER_SIGNING_SECRET=.*|INTERNAL_HEADER_SIGNING_SECRET=dev-internal-header-signing-secret|" \
      -e "s|^CRYPTO_KEKS=.*|CRYPTO_KEKS=1:u4SpMlDTAL6cVMC2rzCxhoKCRAJxpgoc7h+hX3OfdfY=|" \
      -e "s|^ORG_SERVICE_DB_PASSWORD=.*|ORG_SERVICE_DB_PASSWORD=dev-org-password|" \
      -e "s|^PBX_CONFIG_SERVICE_DB_PASSWORD=.*|PBX_CONFIG_SERVICE_DB_PASSWORD=dev-pbx-config-password|" \
      -e "s|^IDENTITY_SERVICE_DB_PASSWORD=.*|IDENTITY_SERVICE_DB_PASSWORD=dev-identity-password|" \
      -e "s|^MARIADB_ROOT_PASSWORD=.*|MARIADB_ROOT_PASSWORD=dev-root-password|" \
      -e "s|^FS_EVENT_SOCKET_PASSWORD=.*|FS_EVENT_SOCKET_PASSWORD=dev-event-socket-password|" \
      -e "s|=change-me$|=rehearsal-secret|"
}

server_env() {
  local name="$1" ip="$2"
  echo "SELF_IP=$ip"
  case "$name" in
    edge1) printf 'EDGE_NODE_ID=1\nEDGE_PEER_NODE_ID=2\nEDGE_PEER_IP=10.10.0.12\nEDGE_SEED=true\nEDGE_PRIORITY=110\n' ;;
    edge2) printf 'EDGE_NODE_ID=2\nEDGE_PEER_NODE_ID=1\nEDGE_PEER_IP=10.10.0.11\nEDGE_SEED=false\nEDGE_PRIORITY=100\n' ;;
    app1) printf 'APP_PEER_IP=10.10.0.22\nLB_PRIORITY=110\n' ;;
    app2) printf 'APP_PEER_IP=10.10.0.21\nLB_PRIORITY=100\n' ;;
    data1) printf 'DATA_NODE_NAME=data-1\nGALERA_BOOTSTRAP=true\n' ;;
    data2) printf 'DATA_NODE_NAME=data-2\n' ;;
    data3) printf 'DATA_NODE_NAME=data-3\n' ;;
    media1) printf 'MEDIA_NODE_ID=fs1\n' ;;
  esac
}

wait_healthy() {
  local server="$1" role="$2" deadline=$((SECONDS + 600))
  log "waiting for $server ($role) to be healthy"
  until [ "$SECONDS" -gt "$deadline" ]; do
    local states
    states="$(in_server "$server" docker compose -f "/opt/voice/$role/compose.yml" ps --format '{{.Service}} {{.Health}} {{.State}}' 2>/dev/null || true)"
    if [ -n "$states" ] && ! echo "$states" | grep -qE ' (starting|unhealthy) | (created|restarting|exited)$'; then
      echo "$states"
      return 0
    fi
    sleep 5
  done
  echo "$states"
  echo "$server did not become healthy" >&2
  return 1
}

cmd_up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
  log "object storage and email"
  docker inspect rh-minio >/dev/null 2>&1 || docker run -d --name rh-minio --network "$NET" --ip 10.10.0.6 \
    -e MINIO_ROOT_USER=rehearsal -e MINIO_ROOT_PASSWORD=rehearsal-secret \
    pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data >/dev/null
  docker inspect rh-mailpit >/dev/null 2>&1 || docker run -d --name rh-mailpit --network "$NET" --ip 10.10.0.7 \
    axllent/mailpit:latest >/dev/null

  local env_file; env_file="$(mktemp)"
  platform_env > "$env_file"
  local tls; tls="$(mktemp -d)"
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=platform.test" \
    -keyout "$tls/privkey.pem" -out "$tls/fullchain.pem" 2>/dev/null
  # The gateway runs as a non-root user: the directory and files must be readable.
  chmod 755 "$tls"
  chmod 644 "$tls"/*.pem

  for entry in "${SERVERS[@]}"; do
    read -r name ip role <<<"$entry"
    log "server $name ($ip, $role)"
    docker inspect "rh-$name" >/dev/null 2>&1 || docker run -d --privileged --name "rh-$name" --hostname "$name" \
      --network "$NET" --ip "$ip" -e DOCKER_TLS_CERTDIR= -v "rh-$name-docker:/var/lib/docker" \
      docker:27-dind --insecure-registry "${REGISTRY_IP}:5000" >/dev/null
    until in_server "$name" docker info >/dev/null 2>&1; do sleep 1; done
    # Edges and app servers listen on floating addresses they may not hold.
    in_server "$name" sysctl -qw net.ipv4.ip_nonlocal_bind=1
    in_server "$name" rm -rf /opt/voice
    in_server "$name" mkdir -p /opt/voice
    docker cp "$DEPLOY/$role" "rh-$name:/opt/voice/$role"
    docker cp "$env_file" "rh-$name:/opt/voice/platform.env"
    server_env "$name" "$ip" | docker exec -i "rh-$name" sh -c "cat > /opt/voice/$role/.env"
    if [ "$role" = edge ]; then docker cp "$tls" "rh-$name:/opt/voice/edge/bootstrap-tls"; fi
    local profile=""
    [ "$name" = data1 ] && profile="--profile prometheus"
    # shellcheck disable=SC2086
    in_server "$name" sh -c "cd /opt/voice/$role && docker compose --env-file ../platform.env --env-file .env $profile up -d --quiet-pull"
    # Each role needs the one before it; a data member waits for the first.
    case "$name" in
      data3 | app2 | media1 | edge2) wait_healthy "$name" "$role" || exit 1 ;;
      data1) sleep 20 ;;
    esac
  done
  wait_healthy app1 app || exit 1
  wait_healthy edge1 edge || exit 1
  rm -rf "$env_file" "$tls"
  log "rehearsal deployment is up"
}

cmd_test() {
  docker run --rm --network host \
    -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro \
    -v "$REPO:$REPO" -v /tmp:/tmp -w "$REPO/tests/sip" \
    -e REQUIRE_SIP_TESTS=1 \
    -e SIP_TEST_NETWORK="$NET" \
    -e SIP_TEST_OPENSIPS_TARGET=10.10.0.100:5060 \
    -e SIP_TEST_DB_HOST=10.10.0.102 \
    -e SIP_TEST_ORG_SERVICE_URL=http://10.10.0.102:8102 \
    node:22-bookworm bash -c \
    'npx tsc --build tsconfig.build.json && npx vitest run -c vitest.rehearsal.config.ts --reporter=verbose'
}

cmd_down() {
  for entry in "${SERVERS[@]}"; do
    read -r name _ _ <<<"$entry"
    docker rm -f "rh-$name" >/dev/null 2>&1 || true
    docker volume rm "rh-$name-docker" >/dev/null 2>&1 || true
  done
  docker rm -f rh-minio rh-mailpit >/dev/null 2>&1 || true
}

# down, and the registry with its images and the network too.
cmd_purge() {
  cmd_down
  docker rm -f rh-registry >/dev/null 2>&1 || true
  docker volume rm rh-registry >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

case "${1:-}" in
  images) cmd_images ;;
  up) cmd_up ;;
  test) cmd_test ;;
  down) cmd_down ;;
  purge) cmd_purge ;;
  *) echo "usage: $0 images|up|test|down|purge" >&2; exit 2 ;;
esac
