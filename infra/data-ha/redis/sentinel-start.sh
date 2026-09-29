#!/bin/sh
# S4-07: one of three sentinels watching the Redis group `cuc`; two must agree
# before a failover. Sentinel rewrites its own file, so it is written fresh here.
set -eu
: "${REDIS_BOOTSTRAP_PRIMARY:?}"
# A sentinel restarted after a failover watches the primary the others know.
PRIMARY=""
for s in $(echo "${REDIS_SENTINELS:-}" | tr ',' ' '); do
  [ "$s" = "$(hostname)" ] || [ "$s" = "${SENTINEL_SELF_IP:-}" ] && continue
  PRIMARY=$(redis-cli -h "$s" -p 26379 --raw SENTINEL get-master-addr-by-name cuc 2>/dev/null | head -1 || true)
  [ -n "$PRIMARY" ] && break
done
[ -n "$PRIMARY" ] || PRIMARY="$REDIS_BOOTSTRAP_PRIMARY"
until getent hosts "$PRIMARY" >/dev/null || echo "$PRIMARY" | grep -qE '^[0-9.]+$'; do sleep 1; done
cat > /tmp/sentinel.conf <<CONF
port 26379
sentinel resolve-hostnames yes
sentinel announce-hostnames no
sentinel monitor cuc ${PRIMARY} 6379 2
sentinel down-after-milliseconds cuc 2000
sentinel failover-timeout cuc 10000
sentinel parallel-syncs cuc 1
CONF
# On a data server (host networking, S4-11) the sentinel says which address
# the others reach it on.
if [ -n "${SENTINEL_SELF_IP:-}" ]; then
  echo "sentinel announce-ip ${SENTINEL_SELF_IP}" >> /tmp/sentinel.conf
fi
exec redis-server /tmp/sentinel.conf --sentinel
