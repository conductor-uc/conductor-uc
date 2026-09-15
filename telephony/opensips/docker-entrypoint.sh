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
TEMPLATE_VARS='$OPENSIPS_LOG_LEVEL $OPENSIPS_IDENTITY $OPENSIPS_SIP_PORT $OPENSIPS_MI_PORT $OPENSIPS_DB_URL $OPENSIPS_REDIS_URL'

envsubst "$TEMPLATE_VARS" \
  < /etc/opensips/opensips.cfg.template > /etc/opensips/opensips.cfg

exec /usr/sbin/opensips -F -f /etc/opensips/opensips.cfg
