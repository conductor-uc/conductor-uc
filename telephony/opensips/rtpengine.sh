#!/bin/sh
# S4-10 (O-7): the edge's media relay. Two sides: `internal` on the pair's
# private floating address, or this edge's private address (the media nodes
# send and receive there) and `external`
# where phones and carriers do: the pair's floating address, bound whether or
# not this edge holds it (as OpenSIPs does), or this edge's own address. The
# SDP names RTPENGINE_EXTERNAL_ADVERTISED when set (a public address NATed
# onto the host). OpenSIPs drives it over the ng protocol on loopback; its
# HTTP listener on the private address serves Prometheus metrics (`/metrics`).
set -eu
OWN_IP="${OPENSIPS_OWN_IP:-$(hostname -i | awk '{ print $1 }')}"
INTERNAL_IP="${RTPENGINE_INTERNAL_IP:-${OPENSIPS_INTERNAL_VIP:-$OWN_IP}}"
EXTERNAL_IP="${RTPENGINE_EXTERNAL_IP:-${OPENSIPS_VIP:-$OWN_IP}}"
EXTERNAL="external/${EXTERNAL_IP}"
if [ -n "${RTPENGINE_EXTERNAL_ADVERTISED:-}" ]; then
  EXTERNAL="${EXTERNAL}!${RTPENGINE_EXTERNAL_ADVERTISED}"
fi
# An edge pair keeps each call's media on both edges (S4-10): each relay
# writes its calls to Redis and follows the other's (`foreign` calls, bound on
# the same floating addresses), so the survivor already has every call when
# the addresses move to it. rtpengine wants the Redis address as an IP.
REDIS_ARGS=""
if [ -n "${RTPENGINE_REDIS:-}" ]; then
  REDIS_HOST="${RTPENGINE_REDIS%%:*}"
  REDIS_REST="${RTPENGINE_REDIS#*:}"
  REDIS_DB="${REDIS_REST#*/}"
  # An address as it is; a name resolved (getent answers nothing for a bare
  # address with no hosts entry, found in the S4-11 rehearsal).
  if echo "$REDIS_HOST" | grep -qE '^[0-9]+(\.[0-9]+){3}$'; then
    REDIS_IP="$REDIS_HOST"
  else
    REDIS_IP="$(getent hosts "$REDIS_HOST" | awk '{ print $1; exit }')"
  fi
  if [ -z "$REDIS_IP" ]; then
    echo "rtpengine: cannot resolve $REDIS_HOST" >&2
    exit 1
  fi
  REDIS_ARGS="--redis=${REDIS_IP}:${REDIS_REST} --redis-write=${REDIS_IP}:${REDIS_REST} --subscribe-keyspace=${REDIS_DB}"
fi

# shellcheck disable=SC2086
exec rtpengine $REDIS_ARGS \
  --foreground \
  --table=-1 \
  --interface="internal/${INTERNAL_IP}" \
  --interface="${EXTERNAL}" \
  --listen-ng="127.0.0.1:${RTPENGINE_NG_PORT:-2223}" \
  --listen-http="${OWN_IP}:${RTPENGINE_HTTP_PORT:-9101}" \
  --listen-cli="127.0.0.1:${RTPENGINE_CLI_PORT:-9900}" \
  --port-min="${RTPENGINE_PORT_MIN:-30000}" \
  --port-max="${RTPENGINE_PORT_MAX:-39999}" \
  --timeout=60 \
  --delete-delay="${RTPENGINE_DELETE_DELAY:-5}" \
  --silent-timeout=3600 \
  --log-stderr \
  --log-level="${RTPENGINE_LOG_LEVEL:-5}" \
  --pidfile=/tmp/rtpengine.pid
