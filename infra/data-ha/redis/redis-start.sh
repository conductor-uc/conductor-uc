#!/bin/sh
# S4-07: starts a Redis member of the Sentinel group. It asks the sentinels who
# the primary is and replicates from it; with no sentinel answering (the first
# start), REDIS_BOOTSTRAP_PRIMARY names it. A primary that died and comes back
# therefore returns as a replica of the one Sentinel promoted, never as a
# second primary. Keyspace notifications are on for the edges' media relays,
# which follow each other's calls through them (S4-10).
set -eu
: "${REDIS_BOOTSTRAP_PRIMARY:?}" "${REDIS_SENTINELS:?}"
SELF_IP="$(hostname -i | awk '{ print $1 }')"
PRIMARY=""
for s in $(echo "$REDIS_SENTINELS" | tr ',' ' '); do
  answer=$(redis-cli -h "$s" -p 26379 --raw SENTINEL get-master-addr-by-name cuc 2>/dev/null | head -1 || true)
  if [ -n "$answer" ]; then PRIMARY="$answer"; break; fi
done
[ -n "$PRIMARY" ] || PRIMARY="$REDIS_BOOTSTRAP_PRIMARY"
PRIMARY_IP=$(getent hosts "$PRIMARY" | awk '{ print $1 }' || true)
[ -n "$PRIMARY_IP" ] || PRIMARY_IP="$PRIMARY"
if [ "$PRIMARY_IP" = "$SELF_IP" ] || [ "$PRIMARY" = "$(hostname)" ]; then
  echo "redis: starting as the primary" >&2
  exec redis-server --appendonly yes --notify-keyspace-events KEA --replica-announce-ip "$SELF_IP"
fi
echo "redis: starting as a replica of $PRIMARY" >&2
exec redis-server --appendonly yes --notify-keyspace-events KEA --replica-announce-ip "$SELF_IP" --replicaof "$PRIMARY" 6379
