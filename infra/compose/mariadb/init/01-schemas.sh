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
create_service_db example_service example_service "${EXAMPLE_SERVICE_DB_PASSWORD}"

mariadb -u root -p"${MARIADB_ROOT_PASSWORD}" -e "FLUSH PRIVILEGES;"
