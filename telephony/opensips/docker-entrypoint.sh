#!/bin/sh
# S1-11: renders opensips.cfg.template with envsubst (the plan's own words:
# "templated opensips.cfg... rendered at container start from environment
# variables" — no per-tenant edits to the file itself, 03 §2), then execs
# OpenSIPs in the foreground so Docker's PID 1 has something to supervise.
set -eu

# The explicit variable list is not optional: OpenSIPs' own script syntax
# is full of bare $identifiers (pseudo-variables like $rU, $si, $tu — every
# routing decision in opensips.cfg.template reads several). Plain `envsubst`
# with no argument treats every one of those as a shell variable too and
# silently replaces each with an empty string, which parses as a syntax
# error at best and a silent behavior change at worst. Listing only this
# image's own template variables is what keeps OpenSIPs' own syntax intact.
TEMPLATE_VARS='$OPENSIPS_LOG_LEVEL $OPENSIPS_IDENTITY $OPENSIPS_SIP_PORT $OPENSIPS_MI_PORT $OPENSIPS_DB_URL $OPENSIPS_REDIS_URL $OPENSIPS_REGISTRANT_TIMER_INTERVAL'

# SIP over TLS (07 §5). The template's `# @if-tls` ... `# @end-tls` blocks are kept or
# dropped here, before OpenSIPs reads the file. (OpenSIPs' own `#!ifdef` does not skip
# a block that holds a `socket=` line when its symbol is undefined: it is a parse error.)
#
# TLS is on when OPENSIPS_TLS_CERT_FILE is set, or when OPENSIPS_TLS_ENABLED=true. The
# certificates for the proxy hostnames are in the database (telephony-config projects
# them). A file certificate is an optional fallback for names the database has nothing
# for, and for the time before the first certificate is issued; without one, a client
# that asks for a name with no certificate yet cannot connect.
KEEP_TLS=no
KEEP_TLS_FILE=no
if [ -n "${OPENSIPS_TLS_CERT_FILE:-}" ]; then
  : "${OPENSIPS_TLS_KEY_FILE:?OPENSIPS_TLS_KEY_FILE must be set with OPENSIPS_TLS_CERT_FILE}"
  export OPENSIPS_TLS_PORT="${OPENSIPS_TLS_PORT:-5061}"

  # Development only: make a self-signed certificate when none is there yet,
  # so `make up` offers TLS without any setup. The subject alternative names
  # are the platform's domains. A real deployment does not turn this on: a
  # self-signed one is not trusted by any phone.
  if [ "${OPENSIPS_TLS_DEV_SELF_SIGNED:-}" = "true" ] && [ ! -s "$OPENSIPS_TLS_CERT_FILE" ]; then
    NAMES="${OPENSIPS_TLS_DEV_NAMES:-platform.test,*.platform.test}"
    SAN=$(echo "$NAMES" | awk -F, '{ for (i = 1; i <= NF; i++) printf "%sDNS:%s", (i > 1 ? "," : ""), $i }')
    FIRST=$(echo "$NAMES" | cut -d, -f1)
    mkdir -p "$(dirname "$OPENSIPS_TLS_CERT_FILE")" "$(dirname "$OPENSIPS_TLS_KEY_FILE")"
    # One at a time, and checked again once inside: both edges of a pair share
    # this volume and start together on a new one. Unlocked, each wrote its own
    # key and certificate over the other's, leaving a key that did not match
    # the certificate, and neither edge could start (G-131). The certificate
    # goes in place last, so one that is there always has its key.
    (
      flock 9
      if [ ! -s "$OPENSIPS_TLS_CERT_FILE" ]; then
        openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
          -subj "/CN=$FIRST" -addext "subjectAltName=$SAN" \
          -keyout "$OPENSIPS_TLS_KEY_FILE.new" -out "$OPENSIPS_TLS_CERT_FILE.new" 2>/dev/null
        mv "$OPENSIPS_TLS_KEY_FILE.new" "$OPENSIPS_TLS_KEY_FILE"
        mv "$OPENSIPS_TLS_CERT_FILE.new" "$OPENSIPS_TLS_CERT_FILE"
        echo "opensips: made a self-signed development certificate for $NAMES" >&2
      fi
    ) 9>"$OPENSIPS_TLS_CERT_FILE.lock"
  fi

  [ -s "$OPENSIPS_TLS_CERT_FILE" ] || { echo "opensips: TLS certificate $OPENSIPS_TLS_CERT_FILE is missing" >&2; exit 1; }
  [ -s "$OPENSIPS_TLS_KEY_FILE" ] || { echo "opensips: TLS key $OPENSIPS_TLS_KEY_FILE is missing" >&2; exit 1; }
  KEEP_TLS=yes
  KEEP_TLS_FILE=yes
  TEMPLATE_VARS="$TEMPLATE_VARS \$OPENSIPS_TLS_PORT \$OPENSIPS_TLS_CERT_FILE \$OPENSIPS_TLS_KEY_FILE"
elif [ "${OPENSIPS_TLS_ENABLED:-}" = "true" ]; then
  export OPENSIPS_TLS_PORT="${OPENSIPS_TLS_PORT:-5061}"
  KEEP_TLS=yes
  TEMPLATE_VARS="$TEMPLATE_VARS \$OPENSIPS_TLS_PORT"
fi

# S4-06: a pair of edges behind a floating address (OPENSIPS_VIP), replicating
# registrations and dialogs over `bin` (opensips.cfg.template's `@if-cluster`
# blocks). Without OPENSIPS_VIP this is one edge on every address, as before.
if [ -n "${OPENSIPS_VIP:-}" ]; then
  : "${OPENSIPS_NODE_ID:?OPENSIPS_NODE_ID must be set with OPENSIPS_VIP}"
  : "${OPENSIPS_PEER_NODE_ID:?OPENSIPS_PEER_NODE_ID must be set with OPENSIPS_VIP}"
  : "${OPENSIPS_PEER_IP:?OPENSIPS_PEER_IP must be set with OPENSIPS_VIP}"
  export OPENSIPS_OWN_IP="${OPENSIPS_OWN_IP:-$(hostname -i | awk '{ print $1 }')}"
  export OPENSIPS_BIN_PORT="${OPENSIPS_BIN_PORT:-5566}"
  # The seed node (one per pair) is where a restarted edge copies its data from.
  if [ "${OPENSIPS_SEED:-}" = "true" ]; then
    export OPENSIPS_NODE_FLAGS=",flags=seed"
  else
    export OPENSIPS_NODE_FLAGS=""
  fi
  TEMPLATE_VARS="$TEMPLATE_VARS \$OPENSIPS_VIP \$OPENSIPS_OWN_IP \$OPENSIPS_BIN_PORT \$OPENSIPS_NODE_ID \$OPENSIPS_PEER_NODE_ID \$OPENSIPS_PEER_IP \$OPENSIPS_NODE_FLAGS"
  CLUSTER_DROP='/^[[:space:]]*# @if-single$/,/^[[:space:]]*# @end-single$/d; /^[[:space:]]*# @if-cluster$/d; /^[[:space:]]*# @end-cluster$/d'
else
  CLUSTER_DROP='/^[[:space:]]*# @if-cluster$/,/^[[:space:]]*# @end-cluster$/d; /^[[:space:]]*# @if-single$/d; /^[[:space:]]*# @end-single$/d'
fi

# S4-10 (O-7): media anchored by RTPengine next to this proxy
# (opensips.cfg.template's `@if-rtpengine` blocks). Its `internal` side faces
# the media nodes (this edge's private address), its `external` side phones
# and carriers: the floating address of an edge pair, or this edge's own. A
# deployment whose public address is NATed onto the host sets
# RTPENGINE_EXTERNAL_ADVERTISED to the public one.
if [ "${OPENSIPS_RTPENGINE:-}" = "true" ]; then
  export RTPENGINE_NG_PORT="${RTPENGINE_NG_PORT:-2223}"
  TEMPLATE_VARS="$TEMPLATE_VARS \$RTPENGINE_NG_PORT"
  RTPENGINE_DROP='/^[[:space:]]*# @if-rtpengine$/d; /^[[:space:]]*# @end-rtpengine$/d'
else
  RTPENGINE_DROP='/^[[:space:]]*# @if-rtpengine$/,/^[[:space:]]*# @end-rtpengine$/d'
fi

if [ "$KEEP_TLS" = yes ]; then
  DROP='/^# @if-tls$/d; /^# @end-tls$/d'
else
  DROP='/^# @if-tls$/,/^# @end-tls$/d'
fi
if [ "$KEEP_TLS_FILE" = yes ]; then
  DROP="$DROP; /^# @if-tls-file\$/d; /^# @end-tls-file\$/d"
else
  DROP="$DROP; /^# @if-tls-file\$/,/^# @end-tls-file\$/d"
fi
sed "$DROP; $CLUSTER_DROP; $RTPENGINE_DROP" /etc/opensips/opensips.cfg.template | envsubst "$TEMPLATE_VARS" \
  > /etc/opensips/opensips.cfg

# S1-14 (G-18): must run before opensips starts — the dispatcher module
# loads its table into memory once, at init, with no cache-mode indirection
# the way `domain`/`db_mode=1` has.
python3 /seed-dispatcher.py

# S4-06: the floating address, when this container runs keepalived itself
# (it needs NET_ADMIN and, like OpenSIPs' own non-local bind, the address in
# OPENSIPS_VIP). Its lifetime is this container's: the edge dies as one.
if [ -n "${OPENSIPS_VIP:-}" ] && [ "${OPENSIPS_KEEPALIVED:-}" = "true" ]; then
  /keepalived.sh &
fi

# S4-10: RTPengine, in userspace (no kernel module inside a container). Like
# keepalived, it lives and dies with this container.
if [ "${OPENSIPS_RTPENGINE:-}" = "true" ]; then
  /rtpengine.sh &
fi

exec /usr/sbin/opensips -F -f /etc/opensips/opensips.cfg
