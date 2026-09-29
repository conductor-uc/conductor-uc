#!/bin/sh
# HAProxy external check (S4-07): a Galera member takes writes only when it is
# Synced (wsrep_local_state 4) and ready. HAProxy passes the server's address
# and port as $3 and $4.
# The credentials are in the options file haproxy-start.sh writes: HAProxy runs
# this with an empty environment.
out=$(mariadb --defaults-extra-file=/tmp/galera-check.cnf -h "$3" -P "$4" \
  --connect-timeout=1 -N -B -e "SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_local_state','wsrep_ready')" 2>/dev/null) || exit 1
echo "$out" | grep -q "^wsrep_local_state[[:space:]]4$" || exit 1
echo "$out" | grep -q "^wsrep_ready[[:space:]]ON$" || exit 1
exit 0
