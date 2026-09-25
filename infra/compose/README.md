# Local dev stack (S0-05)

The infra every service needs locally (MariaDB 11.4, Redis, NATS with JetStream,
MinIO, Mailpit), the telephony tier (two FreeSWITCH nodes and OpenSIPs), and the
Node services the SIP scenarios and the console need, behind api-gateway.

## Quickstart

From the repo root:

```sh
make up      # creates infra/compose/.env from .env.example if missing, then
             # brings every container up and waits for it to report healthy
make seed    # applies each service's migrations and bootstraps the master org
             # (needs `pnpm build` to have run at least once)
make down    # stops the stack, keeps the data volumes
make reset   # stops the stack, deletes the data volumes, brings it back up clean
make ps      # docker compose ps for this stack
make logs    # follow every container's logs
```

`make up` is the S0-05 acceptance check: every container healthy in under 60
seconds on a laptop.

## What's running

Infrastructure:

| Service | Purpose | Default host port(s) |
|---|---|---|
| MariaDB 11.4 | System of record (05 §1) | `3306` (`MARIADB_PORT`) |
| Redis | Rate limits, call-ownership registry, affinity leases, FreeSWITCH `limit` backend | `6379` (`REDIS_PORT`) |
| NATS (JetStream) | Domain event bus + outbox relay target (D-004) | `4222` (`NATS_PORT`), `8222` (`NATS_MONITOR_PORT`) |
| MinIO | S3-compatible object store for `@cuc/storage` | `9000` (`MINIO_API_PORT`), `9001` (`MINIO_CONSOLE_PORT`) |
| Mailpit | SMTP catcher + web UI, for `notification-service` | `1025` (`MAILPIT_SMTP_PORT`), `8025` (`MAILPIT_UI_PORT`) |

Telephony and edge:

| Service | Purpose | Default host port(s) |
|---|---|---|
| OpenSIPs | SIP edge: registrar, trunks, load balancing (03 §2) | `5060/udp`, `5060/tcp` (`OPENSIPS_SIP_PORT`), `5061/tcp` SIP over TLS (`OPENSIPS_TLS_PORT`); MI HTTP on `8888` inside the network only |
| FreeSWITCH, FreeSWITCH-2 | Two identical stateless media nodes (`FS_NODE_ID`, `FS_NODE_ID_2`) | none published: reached only through OpenSIPs' dispatcher |
| api-gateway | The one public HTTP entry point: token check, routing, rate limits | `8080` (`GATEWAY_PORT`), plain HTTP |

Node services (each on `8080` inside the network, none published; reach them through the gateway): `org-service`, `identity-service`, `pbx-config-service`, `trunk-service`, `telephony-config`, `media-worker`, `call-control`, `callflow-service`, `voicemail-service`, `cdr-service`, `notification-service`, `recording-service`. Each FreeSWITCH node has a `recording-uploader` sidecar (no published ports) that watches the node's spool and uploads finished recordings through recording-service.

Named volumes: `mariadb-data`, `redis-data`, `nats-data`, `minio-data`, `mailpit-data`, `opensips-tls`, and `recording-spool` / `recording-spool-2` (tmpfs-backed, so nothing survives a restart: they exist only to share a node's spool with its uploader) (the development self-signed certificate).

Override any port in `.env` if something on your machine already owns it —
`docker-compose.yml` reads every value through a `${VAR:-default}` fallback.

## Environment variables

Every variable below has a development default in `docker-compose.yml`; those
marked "in `.env.example`" are also listed there. Others can be added to `.env`.
The defaults are for a laptop only.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `INTERNAL_HEADER_SIGNING_SECRET` | dev value (in `.env.example`) | gateway, services | The gateway signs who is calling; every service verifies with the same secret |
| `INTERNAL_SERVICE_TOKEN` | dev value | services, gateway | Service-to-service token for internal routes (the gateway uses it only to fetch ACME challenge answers from org-service; telephony-config uses it to fetch certificates) |
| `CRYPTO_KEKS`, `CRYPTO_KEK_CURRENT` | dev key, `1` | org, pbx-config, trunk, identity, ... | Envelope-encryption key set. Dev-only key: production uses a KMS. org-service uses it for certificate private keys and the ACME account key |
| `PLATFORM_BASE_DOMAIN` | `platform.test` (org-service), `local.test` (notification-service) | org-service, notification-service | The platform base domain. Determines `sip.<domain>` and the console hostname |
| `PLATFORM_NOREPLY_ADDRESS`, `CONSOLE_LINK_SCHEME`, `CONSOLE_URL_OVERRIDE` | `noreply@local.test`, `http`, empty | notification-service | Email sender and where links in emails point (`CONSOLE_URL_OVERRIDE` in `.env.example`, commented) |
| `OPENSIPS_TLS_ENABLED` | `true` | opensips | Turn on the 5061 listener; certificates come from the `tls_mgm` table (kept there by telephony-config) |
| `OPENSIPS_TLS_CERT_FILE`, `OPENSIPS_TLS_KEY_FILE` | `/etc/opensips/tls/cert.pem`, `.../key.pem` | opensips | Fallback default certificate for names the database has none for. Setting the cert also turns TLS on |
| `OPENSIPS_TLS_DEV_SELF_SIGNED` | `true` | opensips | Make a self-signed certificate at first start if the file is missing. Leave off in production |
| `OPENSIPS_TLS_DEV_NAMES` | `platform.test,*.platform.test` | opensips | Names on that self-signed certificate |
| `OPENSIPS_TLS_PORT` | `5061` | opensips | TLS listen port (host and container) |
| `SIP_PUBLIC_TRANSPORTS` | `udp,tcp,tls` | pbx-config-service | Transports offered to phones, most preferred first. TLS is last in dev because its certificate is self-signed; production puts `tls` first. (`SIP_PUBLIC_PORT` 5060 and `SIP_PUBLIC_TLS_PORT` 5061 are code defaults, not set here.) |
| `PROVISIONING_BASE_URL` | `http://localhost:8080` | pbx-config-service | Address phones fetch their settings from (the gateway's public address). Unset means provisioning URLs are reported as null |
| `PROVISIONING_USERNAME`, `PROVISIONING_PASSWORD` | `phones`, `dev-provisioning-password` | pbx-config-service | Platform-wide HTTP Basic credential for phone provisioning (set together) |
| `REQUIRE_HTTPS_FOR_PROVISIONING` | `false` | api-gateway | Refuse provisioning over plain HTTP. Code default is `true`; dev turns it off |
| `HSTS_MAX_AGE_SECONDS` | `0` | api-gateway | HSTS off in dev (code default one year) |
| `FS_*`, `TELEPHONY_CONFIG_URL`, `CDR_SERVICE_URL`, `FS_CDR_INGEST_TOKEN`, `OPENSIPS_*` (other) | see `.env.example` | freeswitch, opensips | Node identity, ACLs, event-socket and xml_curl tokens, dispatcher destinations |

**Not set by this compose file**, all api-gateway settings that production needs:
`TLS_CERT_FILE`/`TLS_KEY_FILE`, `TLS_CERT_DIR`, `TLS_FROM_ORG_SERVICE`,
`HTTP_REDIRECT_PORT` (port 80, ACME HTTP-01 and HTTP-to-HTTPS redirect),
`CONSOLE_DIR`, `CONSOLE_CONNECT_SOURCES`, `CONSOLE_HOSTNAMES`. The dev gateway
speaks plain HTTP only, publishes only `8080`, and does not host the console
(development uses `tests/e2e`). org-service's `ACME_DIRECTORY_URL`
is also unset, so nothing issues a certificate in this stack until the ACME
settings are saved in the console; the dev OpenSIPs certificate is self-signed.

### Certificates in this stack

OpenSIPs starts with a self-signed file certificate. Real ones reach it from
the database: org-service issues them, publishes `org.certificate.issued`,
telephony-config writes `tls_mgm` rows and calls `tls_reload`. Nothing needs a
restart. `*.platform.test` is not publicly resolvable, so a real ACME request
for it cannot succeed here; tests use Pebble instead (`services/org-service`,
skipped without Docker).

## Database bootstrap

`mariadb/init/01-schemas.sh` runs once, automatically, the first time the
`mariadb` container starts against an empty data volume (the official
image's own convention for `/docker-entrypoint-initdb.d`). It creates one
schema and one DB user per service, each granted only on its own schema —
05 §1.1's database-per-service rule, enforced at the DB level as well as in
`@cuc/db`. Editing it after the stack has already initialized needs
`make reset` (or `docker compose down -v`) to take effect, since it only runs
against a fresh volume.

Adding a new service (for example, one generated by `pnpm gen:service`)
needs three edits:
1. A `<NAME>_DB_PASSWORD` line in `.env.example`.
2. A matching `<NAME>_DB_PASSWORD` entry in `docker-compose.yml`'s
   `mariadb.environment` block.
3. A `create_service_db` call in `mariadb/init/01-schemas.sh`.

## Seeding

`make seed` (or `infra/compose/seed.sh` directly) applies every service's
built migrations (`dist/migrations`, the same layout used in production —
run `pnpm build` first) against the compose MariaDB, then runs org-service's
`bootstrap-master` CLI to create the single master org. Both steps are
idempotent: re-running `make seed` after the stack already has data is safe.

The master org has no admin user yet — creating one through identity-service
is wired up in a later task (S1-02), not here.

## Troubleshooting

- **A container never goes healthy.** `make logs` to see why, or
  `docker compose --project-directory infra/compose -f infra/compose/docker-compose.yml logs <service>`
  for one container.
- **Port already in use.** Something else on the laptop (often a local
  MariaDB or Redis install) owns the default port. Change it in `.env` and
  re-run `make up`.
- **Migrations fail with "Access denied".** `.env`'s port values and the
  running containers' ports have to match — if you edited `.env` after
  `make up` already started the stack with the old values, run `make reset`.
