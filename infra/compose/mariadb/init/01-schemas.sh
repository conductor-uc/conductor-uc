#!/bin/sh
# Runs once, on a fresh data volume only (the image's own convention for
# /docker-entrypoint-initdb.d). Provisions one schema and one DB user per
# service, matching 05 §1.1: each user is granted only on its own schema, no
# cross-schema joins are possible even by accident.
#
# Add a new service by adding one call below, a matching
# `<NAME>_DB_PASSWORD` in .env.example, and the same variable passed through
# in docker-compose.yml's mariadb.environment block.
set -eu

create_service_db() {
  schema="$1"
  user="$2"
  password="$3"

  mariadb -u root -p"${MARIADB_ROOT_PASSWORD}" <<-SQL
    CREATE DATABASE IF NOT EXISTS \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}';
    GRANT ALL PRIVILEGES ON \`${schema}\`.* TO '${user}'@'%';
SQL
}

create_service_db identity_service identity_service "${IDENTITY_SERVICE_DB_PASSWORD}"
create_service_db org_service org_service "${ORG_SERVICE_DB_PASSWORD}"
create_service_db pbx_config_service pbx_config_service "${PBX_CONFIG_SERVICE_DB_PASSWORD}"
create_service_db example_service example_service "${EXAMPLE_SERVICE_DB_PASSWORD}"
# S1-12 added this service but never its own compose schema/user — every
# S1-12/S1-13 test instead ran against a `startTestDatabase()`-provisioned
# temp schema, so the omission went unnoticed until S1-13's own real-FS
# verification needed the full compose stack.
create_service_db telephony_config telephony_config "${TELEPHONY_CONFIG_SERVICE_DB_PASSWORD}"
create_service_db trunk_service trunk_service "${TRUNK_SERVICE_DB_PASSWORD}"
# S2-07: outbox/consumed_events only (`services/media-worker/src/schema.ts`'s
# own doc comment on why this service has no business tables) — still its
# own schema/user, same 05 §1.1 rule as every other service, not an
# exception to the pattern above.
create_service_db media_worker media_worker "${MEDIA_WORKER_DB_PASSWORD}"
# S2-11: same as media_worker above — outbox/consumed_events only
# (`services/call-control/src/schema.ts`'s own doc comment); call ownership
# itself lives in Redis (04 §3), not here.
create_service_db call_control call_control "${CALL_CONTROL_DB_PASSWORD}"
create_service_db callflow_service callflow_service "${CALLFLOW_SERVICE_DB_PASSWORD}"
create_service_db voicemail_service voicemail_service "${VOICEMAIL_SERVICE_DB_PASSWORD}"
create_service_db cdr_service cdr_service "${CDR_SERVICE_DB_PASSWORD}"
# S3-03: outbox/consumed_events plus its own sent_emails log.
create_service_db notification_service notification_service "${NOTIFICATION_SERVICE_DB_PASSWORD}"

# `opensips` is the one schema not owned by a Node service (05 §1.1's rule
# still applies — one schema, one user, granted only on its own schema):
# OpenSIPs itself reads and caches it, and only telephony-config (S1-12)
# ever writes to it. Its tables are provisioned separately, by
# 02-opensips-schema.sh, since they come from OpenSIPs' own vendored SQL
# files rather than this function's generic empty-schema shape.
create_service_db opensips opensips "${OPENSIPS_DB_PASSWORD}"

mariadb -u root -p"${MARIADB_ROOT_PASSWORD}" -e "FLUSH PRIVILEGES;"
