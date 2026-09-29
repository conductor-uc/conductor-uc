#!/bin/sh
# HAProxy runs external checks with an empty environment, so the Galera check's
# credentials go into a MariaDB client options file it reads instead.
set -eu
umask 077
printf '[client]\nuser=%s\npassword=%s\n' "${GALERA_CHECK_USER:-monitor}" "${GALERA_CHECK_PASSWORD:-}" \
  > /tmp/galera-check.cnf
exec docker-entrypoint.sh "$@"
