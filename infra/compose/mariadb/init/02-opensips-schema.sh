#!/bin/sh
# Runs once, on a fresh data volume only (same rule as 01-schemas.sh). Loads
# OpenSIPs' own vendored table-creation scripts (S1-11;
# telephony/opensips/db-schema/README.md) into the `opensips` schema
# 01-schemas.sh just created. A separate script because these come from an
# external source (mounted read-only below) rather than being written here.
set -eu

# standard-create.sql first, always: it creates the `version` bookkeeping
# table every other file's own first line (an INSERT into it) depends on —
# confirmed by watching every other file silently fail to create its real
# table when this ran in plain alphabetical order instead (mariadb's CLI
# aborts a piped script on its first error, and that INSERT was it).
mariadb -u root -p"${MARIADB_ROOT_PASSWORD}" opensips < /opensips-schema/standard-create.sql

for f in /opensips-schema/*.sql; do
  [ "$(basename "$f")" = "standard-create.sql" ] && continue
  mariadb -u root -p"${MARIADB_ROOT_PASSWORD}" opensips < "$f"
done
