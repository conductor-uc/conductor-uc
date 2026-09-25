#!/bin/sh
# Bootstraps the dev stack (G-115): creates the single master org (02 §1) and
# a master administrator to sign in with, from DEV_ADMIN_EMAIL, DEV_ADMIN_NAME
# and DEV_ADMIN_PASSWORD in .env. Safe to re-run: bootstrap-master keeps an
# existing master and creates the administrator only while the master has no
# users at all.
#
# Requires the stack to be up and healthy (`make up`). Nothing runs on the
# host: the services migrate their own schemas when they start, and
# bootstrap-master runs in a one-off org-service container on the compose
# network (`docker compose run`), with org-service's own settings (database,
# CRYPTO_KEKS, ...) and the only route to identity-service, which is not
# published to the host. No host `pnpm build` is needed, but the images must
# be current: `make up` builds them.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "infra/compose/.env not found: run 'make up' first." >&2
  exit 1
fi

# One value from .env, the last assignment winning as in compose, without
# sourcing the file (compose's .env syntax is not shell: values may contain
# spaces, e.g. OPENSIPS_IDENTITY).
env_value() {
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

admin_email=$(env_value DEV_ADMIN_EMAIL)
admin_name=$(env_value DEV_ADMIN_NAME)
admin_password=$(env_value DEV_ADMIN_PASSWORD)
# An .env copied before these existed still gets a working administrator.
: "${admin_email:=admin@local.test}"
: "${admin_name:=Development administrator}"
: "${admin_password:=dev-admin-password}"

for service in org-service identity-service; do
  health=$(docker compose ps --format '{{.Health}}' "$service" 2>/dev/null || true)
  if [ "$health" != "healthy" ]; then
    echo "$service is not running and healthy (${health:-not running}): run 'make up' first." >&2
    exit 1
  fi
done

echo "Bootstrapping the master org and its administrator ($admin_email)..."
BOOTSTRAP_ADMIN_PASSWORD=$admin_password docker compose run --rm --no-deps -T \
  -e BOOTSTRAP_ADMIN_PASSWORD \
  org-service dist/src/cli/bootstrap-master.js \
  --slug master --name Master \
  --admin-email "$admin_email" --admin-name "$admin_name"

gateway_port=$(env_value GATEWAY_PORT)
cat <<EOF

Done. Sign in as $admin_email with DEV_ADMIN_PASSWORD from infra/compose/.env:
  POST http://localhost:${gateway_port:-8080}/v1/auth/login  {"orgId": "<master orgId above>", "email": ..., "password": ...}
A master administrator must set up two-step verification (TOTP) at the first sign-in.
EOF
