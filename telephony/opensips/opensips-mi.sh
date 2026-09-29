#!/bin/sh
# One MI command to the local OpenSIPs (keepalived's health check and its
# failover action). `--retry`: keep trying for up to 30 s, for an OpenSIPs
# that is still starting when its edge becomes master.
set -u
TRIES=1
if [ "${1:-}" = "--retry" ]; then TRIES=30; shift; fi
i=0
while [ "$i" -lt "$TRIES" ]; do
  if opensips-cli -o communication_type=http -o "url=http://127.0.0.1:${OPENSIPS_MI_PORT:-8888}/mi" -x mi "$@" >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  [ "$i" -lt "$TRIES" ] && sleep 1
done
exit 1
