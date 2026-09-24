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
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -subj "/CN=$FIRST" -addext "subjectAltName=$SAN" \
      -keyout "$OPENSIPS_TLS_KEY_FILE" -out "$OPENSIPS_TLS_CERT_FILE" 2>/dev/null
    echo "opensips: made a self-signed development certificate for $NAMES" >&2
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
sed "$DROP" /etc/opensips/opensips.cfg.template | envsubst "$TEMPLATE_VARS" \
  > /etc/opensips/opensips.cfg

# S1-14 (G-18): must run before opensips starts — the dispatcher module
# loads its table into memory once, at init, with no cache-mode indirection
# the way `domain`/`db_mode=1` has.
python3 /seed-dispatcher.py

exec /usr/sbin/opensips -F -f /etc/opensips/opensips.cfg
