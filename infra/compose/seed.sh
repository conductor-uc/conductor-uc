#!/bin/sh
# Applies every service's migrations against the compose MariaDB, then
# bootstraps the single master org (02 §1). Safe to re-run: migrations are
# idempotent and bootstrap-master no-ops once the master exists.
#
# Requires the stack to be up (`make up`) and each service already built
# (`pnpm build`) — migrations run from `dist/migrations`, the same layout
# used in production, not from TypeScript sources.
set -eu
cd "$(dirname "$0")"
compose_dir=$(pwd)
cd ../..

env_file="$compose_dir/.env"
if [ ! -f "$env_file" ]; then
  echo "$env_file not found — run 'make up' first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

migrate() {
  service_dir="$1"
  db_name="$2"
  db_user="$3"
  db_password="$4"

  if [ ! -d "$service_dir/dist/migrations" ]; then
    echo "Skipping $service_dir: run 'pnpm build' first." >&2
    return 0
  fi

  echo "Migrating $db_name..."
  DB_HOST=127.0.0.1 DB_PORT="${MARIADB_PORT:-3306}" \
    DB_USER="$db_user" DB_PASSWORD="$db_password" DB_NAME="$db_name" \
    pnpm --filter "./$service_dir" run migrate
}

migrate services/identity-service identity_service identity_service "$IDENTITY_SERVICE_DB_PASSWORD"
migrate services/org-service org_service org_service "$ORG_SERVICE_DB_PASSWORD"
migrate services/example-service example_service example_service "$EXAMPLE_SERVICE_DB_PASSWORD"

if [ -d services/org-service/dist/migrations ]; then
  echo "Bootstrapping the master org..."
  # bootstrap-master loads org-service's full config schema (S1-02/S1-03/S1-04
  # added IDENTITY_SERVICE_URL, INTERNAL_SERVICE_TOKEN, PLATFORM_BASE_DOMAIN,
  # and STORAGE_*), even though creating the master touches none of them — it
  # never calls identity-service, assigns a domain, or touches storage. Local
  # placeholders are enough.
  SERVICE_NAME=org-service-bootstrap \
    DB_HOST=127.0.0.1 DB_PORT="${MARIADB_PORT:-3306}" \
    DB_USER=org_service DB_PASSWORD="$ORG_SERVICE_DB_PASSWORD" DB_NAME=org_service \
    IDENTITY_SERVICE_URL="http://127.0.0.1:1" INTERNAL_SERVICE_TOKEN="unused-by-bootstrap" \
    PLATFORM_BASE_DOMAIN="local.test" \
    STORAGE_BUCKET_PREFIX="cuc-dev" STORAGE_ACCESS_KEY_ID="unused-by-bootstrap" \
    STORAGE_SECRET_ACCESS_KEY="unused-by-bootstrap" \
    pnpm --filter ./services/org-service run bootstrap-master
fi
