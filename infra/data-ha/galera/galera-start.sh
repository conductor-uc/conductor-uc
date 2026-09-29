#!/bin/bash
# S4-07: starts a Galera member. It joins the cluster when any peer answers on
# the replication port; otherwise the bootstrap member (GALERA_BOOTSTRAP=true)
# starts a new cluster, but only on an empty data directory: after all members
# have stopped, which one holds the latest writes is an operator's decision
# (https://mariadb.com/kb/en/getting-started-with-mariadb-galera-cluster/,
# "Restarting the cluster"), made by setting GALERA_FORCE_BOOTSTRAP=true on it.
set -euo pipefail

: "${GALERA_PEERS:?comma-separated peer host names}"
: "${MARIADB_ROOT_PASSWORD:?}"
SELF="$(hostname)"
ARGS=(
  "--wsrep-cluster-address=gcomm://${GALERA_PEERS}"
  "--wsrep-node-name=${SELF}"
  "--wsrep-node-address=$(hostname -i | awk '{ print $1 }')"
  "--wsrep-sst-auth=root:${MARIADB_ROOT_PASSWORD}"
)

peer_up() {
  local peer
  for peer in ${GALERA_PEERS//,/ }; do
    [ "$peer" = "$SELF" ] && continue
    if timeout 1 bash -c "</dev/tcp/${peer}/4567" 2>/dev/null; then return 0; fi
  done
  return 1
}

if ! peer_up; then
  if [ "${GALERA_FORCE_BOOTSTRAP:-}" = "true" ] ||
    { [ "${GALERA_BOOTSTRAP:-}" = "true" ] && [ ! -e /var/lib/mysql/grastate.dat ]; }; then
    if [ -e /var/lib/mysql/grastate.dat ]; then
      sed -i 's/^safe_to_bootstrap: 0/safe_to_bootstrap: 1/' /var/lib/mysql/grastate.dat
    fi
    echo "galera: no peer answers; starting a new cluster on ${SELF}" >&2
    exec docker-entrypoint.sh mariadbd "${ARGS[@]}" --wsrep-new-cluster "$@"
  fi
  echo "galera: waiting for a peer to join" >&2
  until peer_up; do sleep 2; done
fi
echo "galera: joining the cluster" >&2
exec docker-entrypoint.sh mariadbd "${ARGS[@]}" "$@"
