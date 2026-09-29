#!/bin/sh
# S4-07: the container's health: this member is Synced with its cluster. Not the
# image's healthcheck.sh: that reads a file the image writes into the data
# directory at first start, which a joining member's state transfer replaces.
mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" -N -B \
  -e "SHOW GLOBAL STATUS LIKE 'wsrep_local_state'" 2>/dev/null | grep -q "[[:space:]]4$"
