# Configuration reference

Every setting of every component. The Node.js services read only environment variables. FreeSWITCH and OpenSIPs read environment variables too, through their startup configuration.

## 1. How the services read their settings

The rules below apply to all Node.js services, from `packages/config`.

- A service reads only the variables it declares. It checks them all at startup and, if any is missing or invalid, **refuses to start and lists every problem at once**.
- An **empty value counts as unset**, so the default applies.
- Booleans accept `true`, `false`, `1`, `0` (any case). Lists are comma-separated and trimmed. URLs must be absolute (`http://host:port`).
- "Required" below means there is no default: the service will not start without it.
- **Secret** variables are masked as `[redacted]` in the configuration each service logs at startup.
- **Any variable can be read from a file** instead: set `<NAME>_FILE` to the file's path (for example `DB_PASSWORD_FILE=/run/secrets/db_password`, the way Docker and Kubernetes secrets are mounted). The file is read as UTF-8 at startup and trailing whitespace, such as the final newline, is removed. It is meant for secrets, but works for every variable in this reference, including the recording uploader's. A value read from a file is masked in the startup log like any other secret. The service refuses to start if both `<NAME>` and `<NAME>_FILE` are set, or if the file cannot be read or is empty; the error names the variable and the path, never the contents. Variables whose own name ends in `_FILE` (api-gateway's `TLS_CERT_FILE` and `TLS_KEY_FILE`) keep their meaning.
- Changes take effect only on restart.

## 2. Secrets to generate

Generate every one of these per installation. The development values in `infra/compose/.env.example` and `docker-compose.yml` are public and must never be used on a real server.

| Secret | Used by | Must be identical in | Generate with |
|---|---|---|---|
| `CRYPTO_KEKS` (and `CRYPTO_KEK_CURRENT`) | org, identity, pbx-config, trunk, voicemail services | **All five services** | `printf '1:%s' "$(openssl rand -base64 32)"`, with `CRYPTO_KEK_CURRENT=1` ([§3.5](#35-crypto_keks-the-master-encryption-key)) |
| `INTERNAL_HEADER_SIGNING_SECRET` | api-gateway, and every service with `TRUST_INTERNAL_HEADERS=true` | api-gateway and identity, org, pbx-config, trunk, callflow, voicemail, recording, cdr services | `openssl rand -hex 32` |
| `INTERNAL_SERVICE_TOKEN` | every application service, api-gateway, recording-uploader | **Every one of them** (one shared token) | `openssl rand -hex 32` |
| `FS_XML_CURL_TOKEN` | FreeSWITCH (every node), telephony-config | Those | `openssl rand -hex 32` |
| `FS_CDR_INGEST_TOKEN` | FreeSWITCH (every node), cdr-service | Those | `openssl rand -hex 32` |
| `FS_EVENT_SOCKET_PASSWORD` | FreeSWITCH (every node), call-control | Those (call-control uses one password for all nodes) | `openssl rand -hex 24` |
| One database password per service, plus `OPENSIPS_DB_PASSWORD` and the MariaDB root password | MariaDB and each service | The service and the MariaDB user it logs in as | `openssl rand -hex 24` each |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | services using storage | All of them (one key pair) | From your S3 provider, or MinIO's root or a MinIO user |
| `NATS_PASSWORD` (optional) | every service with NATS; the NATS server | All of them | `openssl rand -hex 24` |
| `SMTP_PASSWORD` | notification-service | — | From your mail provider |
| `PROVISIONING_PASSWORD` (optional) | pbx-config-service | — (typed into phones or your provisioning redirect) | `openssl rand -hex 16` |

Avoid `$`, quotes and spaces in generated values if they will pass through shell scripts or `.env` files. Hex output avoids all of them.

## 3. Shared variable groups

Most services include one or more of these groups. The per-service tables in §4 say which.

### 3.1 Base (every service)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `SERVICE_NAME` | — | **yes** | The name in logs and on `/healthz`. Keep it functional (for example `pbx-config-service`); it is visible on the public health endpoints. |
| `SERVICE_VERSION` | `0.0.0` | no | Shown on `/healthz` and `/readyz`. Set it to the release you deploy. |
| `LOG_LEVEL` | `info` | no | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `HTTP_HOST` | `0.0.0.0` | no | Listen address |
| `HTTP_PORT` | `8080` | no | Listen port |
| `SHUTDOWN_GRACE_MS` | `10000` | no | How long in-flight requests may finish after SIGTERM |
| `NODE_ENV` | `development` | no | Accepted but **not used** by any code |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | no | Accepted but **not used**: tracing is not wired |

### 3.2 Database (every service except api-gateway)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `DB_HOST` | `127.0.0.1` | no | MariaDB host |
| `DB_PORT` | `3306` | no | |
| `DB_USER` | — | **yes** | The service's own user ([§4](#4-per-service-settings) lists the conventional names) |
| `DB_PASSWORD` | — | **yes** (secret) | |
| `DB_NAME` | — | **yes** | The service's own schema |
| `DB_POOL_SIZE` | `10` | no | Connections per copy of the service (1–200). Total connections = sum over services and copies. Check MariaDB's `max_connections` (default 151). |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | no | |

There is no TLS option for the database connection.

### 3.3 Events (every service except api-gateway)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `NATS_SERVERS` | `127.0.0.1:4222` | no | Comma-separated, for example `nats://10.10.0.41:4222` |
| `NATS_USER` | — | no | NATS username |
| `NATS_PASSWORD` | — | no (secret) | NATS password |
| `NATS_NKEY_SEED` | — | no | Accepted but **ignored**: only username and password work |
| `OUTBOX_BATCH_SIZE` | `100` | no | Events published per pass |
| `OUTBOX_POLL_INTERVAL_MS` | `250` | no | Wait after an empty pass |
| `OUTBOX_MAX_ATTEMPTS` | `10` | no | After this many failed publishes an event is set aside for an operator |

media-worker and notification-service accept the `OUTBOX_*` variables but do not publish events.

### 3.4 Signed identity headers (services behind the gateway)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `TRUST_INTERNAL_HEADERS` | `false` | no | **Set `true`** on identity, org, pbx-config, trunk, callflow, voicemail, recording and cdr services. With `false`, requests from the gateway arrive with no user and are refused ("Sign in to continue"). |
| `INTERNAL_HEADER_SIGNING_SECRET` | — | **yes when the above is `true`** (secret) | Same value as the gateway's |

The signed context carries who is calling (six identity headers) and the client's address as the gateway saw it (`x-internal-client-ip`), which services record in audit events and sessions instead of the gateway's own address. The signature is an HMAC-SHA256 over those seven values plus a millisecond timestamp. A signature more than 60 seconds old or from the future is rejected (`internal_headers_forged`), so **server clocks must agree**.

With `TRUST_INTERNAL_HEADERS=true`, a request that carries neither a valid signed context nor `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` is refused (401 `authentication_required`) on every route except sign-in, the public routes and health checks. The token is how one service or tool calls another's API directly: it is accepted as a trusted machine caller, not as a person, so routes that act for a person (revealing a credential, recordings) still refuse it.

call-control, media-worker and telephony-config accept these variables but ignore them. notification-service never trusts them.

### 3.5 CRYPTO_KEKS, the master encryption key

Included by org, identity, pbx-config, trunk and voicemail services.

| Variable | Required | Meaning |
|---|---|---|
| `CRYPTO_KEKS` | **yes** (secret) | Comma-separated `version:base64key` pairs. Each key must decode to **exactly 32 bytes** (44 base64 characters). Shape: `1:<44 base64 characters>`; generate it as shown in [§2](#2-secrets-to-generate), never copy one from a document. |
| `CRYPTO_KEK_CURRENT` | **yes** | The version new data is encrypted with. Must be one of the listed versions. |

What it protects: SIP passwords, trunk credentials, voicemail PINs, TLS private keys and ACME account keys issued by org-service, and **identity-service's login-token signing keys**. Each record is encrypted with its own data key, which is encrypted with this key (AES-256-GCM).

**If you lose `CRYPTO_KEKS`, every one of those becomes unreadable. Nobody can sign in, phones cannot register, trunks cannot authenticate, and TLS certificates cannot be served.** Store it outside the servers: a password manager, a secrets vault, or a sealed offline copy. Include it in your disaster-recovery plan ([operations §4](operations.md#4-backups-and-restore)).

To introduce a new key, add it with a new version and make it current: `CRYPTO_KEKS=1:<old>,2:<new>` and `CRYPTO_KEK_CURRENT=2`, identically in all five services, and restart them. Each of the five then **re-wraps existing records in the background**: at startup and every 10 minutes it moves records still under an older version to the current one, 100 at a time. Only each record's data key is re-encrypted, so this is quick and a record stays readable throughout. Several copies of a service can run it at once.

**Keep the old version listed until every record has moved.** Each service reports how many of its records are still under an older version in `GET /readyz`, as the `kek_rewrap` check (`"detail": "N values under older key versions"`; it always passes), and logs the count after every pass while it is above 0, then once when it reaches 0. When all five services report `0 values under older key versions`, remove the old version from `CRYPTO_KEKS` and restart them. A record that cannot be moved (its version is already missing from `CRYPTO_KEKS`) is logged with its table and row and keeps being counted. Backups taken before the change still need the old key to be restored ([operations §6](operations.md#6-rotating-secrets)).

There is no KMS integration: the Vault provider in `packages/crypto` throws "not implemented" (deferred, G-116).

### 3.6 Object storage (org, pbx-config, voicemail, recording, cdr, telephony-config, media-worker)

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `STORAGE_MODE` | `bucket-per-tenant` | no | Or `prefix-per-tenant` (one shared bucket; for providers that cap bucket counts). **Choose once**: changing it later does not move existing objects. |
| `STORAGE_BUCKET_PREFIX` | — | **yes** | At most 28 characters. Buckets are `{prefix}-t-{tenant id}`, `{prefix}-shared`, `{prefix}-platform`. Bucket names appear in presigned URLs, so do not put a product or company name in it (brand rule). Example: `v1prod`. |
| `STORAGE_ENDPOINT` | — (AWS S3) | no | Your S3-compatible endpoint, for example `https://s3.voice.example.net` or `https://s3.eu-central-1.wasabisys.com`. **Presigned URLs are signed for this exact host**, so it must be reachable by the services, by every FreeSWITCH server and uploader, **and by browsers over HTTPS**. There is no separate "public endpoint" setting. |
| `STORAGE_REGION` | `us-east-1` | no | |
| `STORAGE_ACCESS_KEY_ID` | — | **yes** (secret) | |
| `STORAGE_SECRET_ACCESS_KEY` | — | **yes** (secret) | |
| `STORAGE_FORCE_PATH_STYLE` | `false` | no | `true` for MinIO and most self-hosted stores |

Permissions the key needs: create buckets, put and get objects, delete objects, head objects, put bucket encryption and public-access block (attempted, not required), and get, put and delete bucket lifecycle configuration (used for recording retention).

## 4. Per-service settings

Each table lists the service's own variables. The groups from §3 it includes are named under the heading. The database user and schema names are the ones the development stack creates; any names work if they match the grants.

### 4.1 api-gateway

Groups: base only. No database, no NATS, no storage.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_HEADER_SIGNING_SECRET` | — | **yes** (secret) | Signs the identity headers it forwards |
| `IDENTITY_SERVICE_URL` | — | **yes** | Also where it fetches `/.well-known/jwks.json` |
| `ORG_SERVICE_URL` | — | **yes** | Also used for certificates and ACME challenges |
| `PBX_CONFIG_SERVICE_URL`, `CALLFLOW_SERVICE_URL`, `VOICEMAIL_SERVICE_URL`, `CDR_SERVICE_URL`, `TRUNK_SERVICE_URL`, `RECORDING_SERVICE_URL` | — | **yes** | Where each service is. `/v1/platform/health` probes each one's `/readyz`. |
| `INTERNAL_SERVICE_TOKEN` | — | no (secret) | **Set it.** Without it the gateway cannot fetch certificates from org-service or answer ACME challenges. |
| `TRUSTED_PROXIES` | empty | no | Addresses or CIDRs of the reverse proxies or load balancers in front of the gateway, comma-separated (for example `10.10.0.5,10.20.0.0/24`). Only their `X-Forwarded-For` and `X-Forwarded-Proto` are believed. **Leave empty when the gateway faces the internet directly**: the client address is then the connection's own. The address found here is what the per-IP rate limit counts and what audit events record. A malformed entry stops the gateway at startup. See [network §6.3](network-and-firewall.md#63-client-addresses-and-x-forwarded-headers). |
| `REDIS_URL` | — | **yes** | Rate-limit counters, for example `redis://10.10.0.41:6379`. Keys are `rl:ip:*` and `rl:actor:*` with no prefix: do not share the Redis database with another platform instance. |
| `RATE_LIMIT_IP_MAX` / `RATE_LIMIT_IP_WINDOW_MS` | `300` / `60000` | no | Requests per IP per window. Phones behind one NAT that reboot together share this. |
| `RATE_LIMIT_ACTOR_MAX` / `RATE_LIMIT_ACTOR_WINDOW_MS` | `600` / `60000` | no | Per signed-in user |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | no | Default certificate (PEM chain, PEM key). Both or neither. Read at startup: a missing file stops the gateway. |
| `TLS_CERT_DIR` | — | no | Certificates by hostname: `<dir>/<host>/fullchain.pem` and `privkey.pem`; a wildcard lives in `_.<domain>/`. Rechecked every 60 s; no restart needed. |
| `TLS_FROM_ORG_SERVICE` | `false` | no | **Set `true`** to serve the console certificates org-service issues. Needs `INTERNAL_SERVICE_TOKEN`. |
| `HTTP_REDIRECT_PORT` | — | no | Opens a plain-HTTP listener (use `80`) for ACME HTTP-01 and HTTP-to-HTTPS redirects. **Required** for automatic certificates. |
| `HSTS_MAX_AGE_SECONDS` | `31536000` | no | `0` disables HSTS. HSTS is sent only over HTTPS, with `includeSubDomains`. |
| `REQUIRE_HTTPS_FOR_PROVISIONING` | `true` | no | Refuse phone provisioning over plain HTTP |
| `CONSOLE_DIR` | — | no | Directory holding the built web console (`flutter build web`). Without it, the gateway serves no console. |
| `CONSOLE_CONNECT_SOURCES` | — | no | Extra origins the console may connect to. **Add your object-storage origin** (for example `https://s3.voice.example.net`), or uploads and playback from the browser are blocked by the content security policy. |
| `CONSOLE_HOSTNAMES` | — | no | Hostnames allowed for cross-origin requests with credentials. Not needed when the console is served by this gateway (same origin). |
| `ROUTE_TABLE` | built-in table | no | Path-to-service map. **Leave unset**: the default matches the services. |
| `PUBLIC_ROUTE_PREFIXES` | `/v1/auth,/v1/public` | no | Paths reachable without a token. Leave unset. |
| `ACCESS_TOKEN_ALGORITHM` | `EdDSA` | no | Leave unset |
| `JWKS_CACHE_MAX_AGE_MS` / `JWKS_COOLDOWN_MS` | `600000` / `30000` | no | Signing-key cache. Keep the cache age shorter than identity-service's `SIGNING_KEY_PUBLISH_AHEAD_MINUTES` (15 minutes), so a new signing key is fetched before it signs. |
| `PROXY_TIMEOUT_MS` | `15000` | no | Upstream timeout |

Certificate lookup order for each TLS connection: `TLS_CERT_DIR`, then org-service, then the default file. The gateway never presents SIP certificates.

### 4.2 identity-service

Groups: base, database (`identity_service`), events, signed headers, crypto.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `ORG_SERVICE_URL` | — | **yes** | |
| `ACCESS_TOKEN_TTL_SECONDS` | `600` | no | Access-token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | no | Sliding session lifetime |
| `MFA_TICKET_TTL_SECONDS` | `300` | no | Time to enter a two-step code |
| `SIGNING_KEY_OVERLAP_DAYS` | `7` | no | How long a retired signing key stays published, so tokens it signed keep verifying. Keep it longer than `ACCESS_TOKEN_TTL_SECONDS`. |
| `SIGNING_KEY_ROTATION_DAYS` | `90` | no | Start rotating the signing key once it has signed for this many days: a new key is published, then promoted after `SIGNING_KEY_PUBLISH_AHEAD_MINUTES`. Every copy checks every 5 minutes and 30 s after startup; exactly one acts. `0` turns automatic rotation off (a key published by `rotate-signing-key` is still promoted on time). |
| `SIGNING_KEY_PUBLISH_AHEAD_MINUTES` | `15` | no | How long a new signing key is published in the key set before it signs anything. **Must be longer than api-gateway's `JWKS_CACHE_MAX_AGE_MS`** (10 minutes by default), so every gateway has refetched the key set, and holds the new key, before the first token it signed arrives. Raise both together. |
| `PASSWORD_RESET_TTL_MINUTES` | `60` | no | |
| `INVITATION_TTL_DAYS` | `7` | no | |
| `COOKIE_SECURE` | `true` | no | `Secure` flag on the refresh cookie. **Keep `true`** in production (HTTPS only). |
| `DEV_EXPOSE_TOKENS` | `false` | no | Logs reset and invitation tokens. **Never in production.** |

Signing keys (Ed25519) are generated at first start and stored in its database, encrypted with `CRYPTO_KEKS`. Rotation is published ahead, in two steps: the next key is first added to the key set (`/.well-known/jwks.json`) without signing anything, and only after `SIGNING_KEY_PUBLISH_AHEAD_MINUTES` does it become the key that signs; the previous key stays published for `SIGNING_KEY_OVERLAP_DAYS`. So the gateway never sees a token signed with a key it has not fetched. This happens automatically (`SIGNING_KEY_ROTATION_DAYS`), and an operator can start it at any time with the `rotate-signing-key` command, or switch at once with `--now` or, if a key may have leaked, `--revoke-previous` ([operations §6](operations.md#6-rotating-secrets)). Every copy signs with the new key from its next token after the switch; nothing needs a restart.

### 4.3 org-service

Groups: base, database (`org_service`), events, signed headers, crypto, storage.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `IDENTITY_SERVICE_URL` | — | **yes** | Creates each new organisation's first administrator |
| `PLATFORM_BASE_DOMAIN` | — | **yes** | Your platform domain, for example `voice.example.net`. The master console is `console.<it>`, the platform SIP proxy is `sip.<it>`, and tenants without a reseller domain get `<slug>.<it>`. **Choose it once**: tenant domains and certificates are derived from it. |
| `ACME_DIRECTORY_URL` | — | no | Overrides the ACME server (for example a test CA). Leave unset in production; the administrator chooses Let's Encrypt production or staging in the console. |

### 4.4 pbx-config-service

Groups: base, database (`pbx_config_service`), events, signed headers, crypto, storage.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `ORG_SERVICE_URL`, `IDENTITY_SERVICE_URL`, `TRUNK_SERVICE_URL` | — | **yes** | |
| `PROVISIONING_BASE_URL` | — | no | The gateway's public HTTPS address phones use, for example `https://console.voice.example.net`. Unset means provisioning URLs are reported as not configured. |
| `PROVISIONING_USERNAME`, `PROVISIONING_PASSWORD` | — | no (password secret) | One platform-wide HTTP Basic login accepted for every phone. Both or neither. It gives no isolation between tenants (G-103); per-phone credentials are the alternative. |
| `SIP_PUBLIC_PORT` | `5060` | no | Port written into phone configuration and shown in the console |
| `SIP_PUBLIC_TLS_PORT` | `5061` | no | |
| `SIP_PUBLIC_TRANSPORTS` | `udp,tcp` | no | Order of preference offered to phones. Use `tls,tcp,udp` once SIP TLS certificates are active. |

### 4.5 trunk-service

Groups: base, database (`trunk_service`), events, signed headers, crypto.

| Variable | Required | Meaning |
|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | **yes** (secret) | |
| `ORG_SERVICE_URL`, `IDENTITY_SERVICE_URL` | **yes** | |
| `TELEPHONY_CONFIG_URL` | **yes** | Live trunk registration status |

### 4.6 callflow-service

Groups: base, database (`callflow_service`), events, signed headers. Own variables: `INTERNAL_SERVICE_TOKEN` (**required**, secret) and `IDENTITY_SERVICE_URL` (**required**).

### 4.7 voicemail-service

Groups: base, database (`voicemail_service`), events, signed headers, crypto, storage. Own variables: `INTERNAL_SERVICE_TOKEN` (**required**, secret), `PBX_CONFIG_SERVICE_URL` and `IDENTITY_SERVICE_URL` (**required**).

### 4.8 recording-service

Groups: base, database (`recording_service`), events, signed headers, storage.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `IDENTITY_SERVICE_URL` | — | **yes** | Roles and grants of the signed-in person, per request |
| `ACCESS_CACHE_TTL_MS` | `5000` | no | How long a revoked grant can keep working |
| `RECORDING_DEFAULT_RETENTION_DAYS` | `90` | no | For tenants that have not set their own; `0` keeps forever |
| `RETENTION_SWEEP_INTERVAL_MS` | `3600000` | no | First sweep runs one interval after startup |
| `RETENTION_SWEEP_BATCH` | `200` | no | |
| `PENDING_RECORDING_MAX_AGE_HOURS` | `72` | no | A recording never uploaded is marked failed after this |

### 4.9 cdr-service

Groups: base, database (`cdr_service`), events, signed headers, storage.

| Variable | Required | Meaning |
|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | **yes** (secret) | Sent to other services (it has no internal routes of its own) |
| `ORG_SERVICE_URL`, `PBX_CONFIG_SERVICE_URL`, `IDENTITY_SERVICE_URL` | **yes** | |
| `FS_CDR_INGEST_TOKEN` | **yes** (secret) | Password FreeSWITCH uses on `POST /ingest/json-cdr` (any username is accepted) |

### 4.10 telephony-config

Groups: base, database (`telephony_config`), events, storage. It accepts the signed-header variables but ignores them.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `FS_XML_CURL_TOKEN` | — | **yes** (secret) | What FreeSWITCH presents on `/fs/*` (Basic `fs-node:<token>` or header `X-Fs-Node-Token`). There is no source-IP check in the code. |
| `OPENSIPS_DB_HOST` | `127.0.0.1` | no | A second database connection, to the `opensips` schema |
| `OPENSIPS_DB_PORT` | `3306` | no | |
| `OPENSIPS_DB_USER` | — | **yes** | Usually `opensips` |
| `OPENSIPS_DB_PASSWORD` | — | **yes** (secret) | |
| `OPENSIPS_DB_NAME` | `opensips` | no | |
| `OPENSIPS_DB_POOL_SIZE` | `10` | no | |
| `OPENSIPS_MI_URL` | — | **yes** | OpenSIPs' management interface, for example `http://10.10.0.10:8888/mi`. Only one OpenSIPs is supported. |
| `OPENSIPS_SIP_URI` | — | **yes** | `host:port` of OpenSIPs, without `sip:`. **Used two ways:** FreeSWITCH sends every outbound leg there, and it is the contact address OpenSIPs gives carriers when it registers a trunk. **It must be reachable by FreeSWITCH and by carriers**: use OpenSIPs' public IP or `sip.<domain>`, with port 5060, for example `203.0.113.10:5060`. |
| `SELF_URL` | — | **yes** | This service's address **as FreeSWITCH reaches it**. Must equal FreeSWITCH's `TELEPHONY_CONFIG_URL`. Written into prompt URLs. |
| `PBX_CONFIG_SERVICE_URL`, `TRUNK_SERVICE_URL`, `ORG_SERVICE_URL`, `VOICEMAIL_SERVICE_URL`, `CALLFLOW_SERVICE_URL`, `CALL_CONTROL_URL`, `RECORDING_SERVICE_URL` | — | **yes** | |
| `RECORDING_SPOOL_DIR` | `/var/spool/cuc/rec` | no | Must match the uploader's `SPOOL_DIR` and FreeSWITCH's (fixed) recordings directory |
| `RECORDING_POLICY_TIMEOUT_MS` | `800` | no | After this, a call proceeds unrecorded and flagged |
| `RECORDING_POLICY_CACHE_TTL_MS` | `30000` | no | A recording-rule change takes effect within this |
| `REDIS_URL` | — | **yes** | |
| `REDIS_KEY_PREFIX` | `cuc:dev:` | no | **Must equal call-control's.** Use one per environment, for example `v1:prod:`. |
| `RECONCILE_INTERVAL_MS` | `900000` | no | How often it re-checks the OpenSIPs tables and pushes certificates |

### 4.11 call-control

Groups: base, database (`call_control`), events. Run **exactly one copy**.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `REDIS_URL` | — | **yes** | |
| `REDIS_KEY_PREFIX` | `cuc:dev:` | no | **Must equal telephony-config's** |
| `FS_NODES` | `freeswitch:freeswitch:8021` | no | Every FreeSWITCH node as `id:host:port`, comma-separated, for example `fs1:203.0.113.21:8021,fs2:203.0.113.22:8021` (or private addresses, since ESL listens on every interface). `id` must equal that node's `FS_NODE_ID`. Read only at startup. |
| `FS_EVENT_SOCKET_PASSWORD` | — | **yes** (secret) | Same on every node |
| `HEARTBEAT_TTL_MS` / `HEARTBEAT_INTERVAL_MS` | `10000` / `3000` | no | Node liveness in Redis |
| `CALL_SAFETY_TTL_MS` | `21600000` | no | Six hours: longest a call record lives in Redis |
| `ESL_RECONNECT_MIN_DELAY_MS` / `ESL_RECONNECT_MAX_DELAY_MS` | `500` / `15000` | no | Reconnect backoff |
| `AFFINITY_LEASE_TTL_MS` / `AFFINITY_RENEW_INTERVAL_MS` | `30000` / `10000` | no | Queue, parking and conference pinning |

### 4.12 media-worker

Groups: base, database (`media_worker`), events, storage.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `PBX_CONFIG_SERVICE_URL` | — | **yes** | |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | no | Installed in its image |

### 4.13 notification-service

Groups: base, database (`notification_service`), events.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `ORG_SERVICE_URL`, `IDENTITY_SERVICE_URL`, `VOICEMAIL_SERVICE_URL` | — | **yes** | identity-service lists an org's admins for the two-step reset notice (G-100) |
| `SMTP_HOST` | — | **yes** | Your mail relay |
| `SMTP_PORT` | `587` | no | |
| `SMTP_SECURE` | `false` | no | `true` for implicit TLS (port 465). With `false`, STARTTLS is used if the server offers it; it is not required. |
| `SMTP_USER`, `SMTP_PASSWORD` | — | no | |
| `PLATFORM_NOREPLY_ADDRESS` | — | **yes** | Sender of every email, for example `noreply@voice.example.net`. Must be allowed by your relay and covered by SPF and DKIM for that domain. Keep brand names out of it unless it is a reseller's own domain. |
| `PLATFORM_BASE_DOMAIN` | — | **yes** | Same value as org-service. Links default to `https://console.<it>`. |
| `CONSOLE_LINK_SCHEME` | `https` | no | |
| `CONSOLE_URL_OVERRIDE` | — | no | Development only |
| `VOICEMAIL_MAX_ATTACHMENT_BYTES` | `10000000` | no | Bigger voicemails are emailed without the audio |

## 5. FreeSWITCH

Set as environment variables on the FreeSWITCH container. `vars.xml` reads them at startup.

| Variable | Default | Meaning |
|---|---|---|
| `FS_NODE_ID` | `change-me-FS_NODE_ID` | **Set it.** Unique per node. Must match the node's `id` in call-control's `FS_NODES`. |
| `FS_OPENSIPS_CIDR` | `127.0.0.1/32` | The **one** CIDR allowed to send SIP to this node: OpenSIPs' address as this node sees it |
| `FS_CLUSTER_CIDR` | `127.0.0.1/32` | The **one** CIDR (plus 127.0.0.1) allowed on the event socket: call-control's address |
| `FS_EVENT_SOCKET_PASSWORD` | `change-me-…` | Same as call-control's |
| `FS_EVENT_SOCKET_BIND_IP` | `0.0.0.0` | Where the event socket listens (port fixed at 8021) |
| `TELEPHONY_CONFIG_URL` | `http://telephony-config:8080` | telephony-config's address as this node reaches it. Equal to telephony-config's `SELF_URL`. |
| `FS_XML_CURL_TOKEN` | `change-me-…` | Same as telephony-config's |
| `CDR_SERVICE_URL` | `http://cdr-service:8080` | |
| `FS_CDR_INGEST_TOKEN` | `change-me-…` | Same as cdr-service's |
| `FS_REDIS_HOST` / `FS_REDIS_PORT` | `redis` / `6379` | The shared Redis (no password possible) |
| `FS_EXTERNAL_RTP_IP` | — (the interface address) | The address advertised in SDP for audio. Set it to the public IPv4 when the server sits behind 1:1 NAT (the public address is not on its interface). Signalling is unaffected. ([network §4](network-and-firewall.md#4-media-rtp-and-why-freeswitch-needs-a-public-address)) |
| `FS_SIP_PORT` | `5060` | SIP port. Change it only if OpenSIPs runs on the same address ([all-in-one](deploy-all-in-one.md#73-freeswitch)). |
| `FS_RTP_START_PORT` / `FS_RTP_END_PORT` | `16384` / `32768` | RTP range to open in the firewall |
| `FS_SIP_IDENTITY` | `SIP Media Server` | SIP `User-Agent`. Keep it neutral (brand rule). |
| `FS_SDP_IDENTITY` | `SIP-Media-Server` | SDP `o=`/`s=` name. Neutral, no spaces. |
| `FS_LOG_LEVEL` | `info` | |

Fixed in the configuration files, with no variable: SIP binds to the detected interface address only; signalling (`ext-sip-ip`) is always that same address; codecs are Opus, G.722, PCMU, PCMA; at most 1,000 sessions and 30 new sessions per second; recordings go to `/var/spool/cuc/rec`; the event socket port is 8021.

Directories: `/var/spool/cuc/rec` (recording spool, shared with the uploader), `/var/cache/cuc/flow` and `/var/cache/cuc/http` (caches). Mount all three on tmpfs or disposable storage; nothing in them is durable.

## 6. OpenSIPs

| Variable | Default in the development stack | Meaning |
|---|---|---|
| `OPENSIPS_SIP_PORT` | `5060` | UDP and TCP listen port on all interfaces |
| `OPENSIPS_MI_PORT` | `8888` | Management interface port (all interfaces, no authentication) |
| `OPENSIPS_DB_URL` | `mysql://opensips:<password>@mariadb/opensips` | The `opensips` schema. Special characters in the password must be URL-encoded. |
| `OPENSIPS_REDIS_URL` | `redis:cuc://redis:6379/0` | Format `redis:<group>://host:port/db`. Loaded but not used yet. |
| `OPENSIPS_FS_DESTINATION` | `sip:freeswitch:5060,sip:freeswitch-2:5060` | Every FreeSWITCH node as a SIP URI, comma-separated. **Replaced in the database at every start** and read only then. Each entry must be the exact address and port the node sends from ([network](network-and-firewall.md#21-public-ports): OpenSIPs recognises a node by source IP and port). |
| `OPENSIPS_IDENTITY` | `SIP Media Server` | SIP `Server` and `User-Agent`. Keep it neutral. |
| `OPENSIPS_LOG_LEVEL` | `3` | 1 (errors) to 4 (debug) |
| `OPENSIPS_REGISTRANT_TIMER_INTERVAL` | `10` (module default 100) | Seconds between checks of outbound trunk registrations |
| `OPENSIPS_TLS_ENABLED` | `true` | Open the TLS listener. Certificates come from the database (issued by org-service). |
| `OPENSIPS_TLS_CERT_FILE`, `OPENSIPS_TLS_KEY_FILE` | `/etc/opensips/tls/cert.pem`, `key.pem` | Optional fallback certificate from files. If `…_CERT_FILE` is set, both files must exist. |
| `OPENSIPS_TLS_PORT` | `5061` | TLS port |
| `OPENSIPS_TLS_DEV_SELF_SIGNED` | `true` | Generates a self-signed fallback certificate. **Set `false` in production.** |
| `OPENSIPS_TLS_DEV_NAMES` | `platform.test,*.platform.test` | Names for that self-signed certificate |

The entrypoint substitutes only these variables into `opensips.cfg.template`. Anything else (flood limits, timers, workers) means editing the template and rebuilding the image.

## 7. recording-uploader

One per FreeSWITCH node, on the same server, sharing the spool directory. It does not use the shared variable groups.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `RECORDING_SERVICE_URL` | — | **yes** | |
| `INTERNAL_SERVICE_TOKEN` | — | **yes** (secret) | |
| `SERVICE_NAME` | `recording-uploader` | no | Name it after its node, for example `recording-uploader-fs1` |
| `SPOOL_DIR` | `/var/spool/cuc/rec` | no | |
| `SCAN_INTERVAL_MS` | `5000` | no | |
| `SETTLE_SECONDS` | `30` | no | A file must be unchanged this long before upload |
| `ABANDONED_AFTER_SECONDS` | `600` | no | Upload even if the WAV header never closed (FreeSWITCH died mid-call) |
| `STUCK_AFTER_SECONDS` | `3600` | no | Raise the stuck alert after this |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | `2000` / `300000` | no | Retry backoff |
| `CONCURRENCY` | `2` | no | Up to 16 |
| `METRICS_PORT` / `METRICS_HOST` | `9464` / `0.0.0.0` | no | `/metrics`, `/healthz` |
| `LOG_LEVEL` | `info` | no | |

The spool directory must be writable by FreeSWITCH (root) and deletable by the uploader (uid 65532): mode `0777` **without** the sticky bit. With `1777` the uploader uploads but cannot delete, and audio stays on the server.

## 8. Values that must agree

| Value | Must be the same in |
|---|---|
| `CRYPTO_KEKS`, `CRYPTO_KEK_CURRENT` | org, identity, pbx-config, trunk, voicemail services |
| `INTERNAL_HEADER_SIGNING_SECRET` | api-gateway; identity, org, pbx-config, trunk, callflow, voicemail, recording, cdr services |
| `INTERNAL_SERVICE_TOKEN` | Every service, api-gateway, every uploader |
| `FS_XML_CURL_TOKEN` | telephony-config, every FreeSWITCH node |
| `FS_CDR_INGEST_TOKEN` | cdr-service, every FreeSWITCH node |
| `FS_EVENT_SOCKET_PASSWORD` | call-control, every FreeSWITCH node |
| `REDIS_KEY_PREFIX` | telephony-config, call-control |
| `PLATFORM_BASE_DOMAIN` | org-service, notification-service |
| telephony-config `SELF_URL` | Every FreeSWITCH node's `TELEPHONY_CONFIG_URL` (and it must be reachable from them) |
| telephony-config `RECORDING_SPOOL_DIR` | Every uploader's `SPOOL_DIR` (and FreeSWITCH's fixed `/var/spool/cuc/rec`) |
| Each node's `FS_NODE_ID` | That node's `id` in call-control's `FS_NODES` |
| Each node's SIP address and port | Its entry in OpenSIPs' `OPENSIPS_FS_DESTINATION` |
| OpenSIPs' source address toward a node | That node's `FS_OPENSIPS_CIDR` |
| call-control's source address toward a node | That node's `FS_CLUSTER_CIDR` |
| `STORAGE_*` | Every service that uses storage (one store, one key pair) |
| `SIP_PUBLIC_PORT`, `SIP_PUBLIC_TLS_PORT` | OpenSIPs' real public ports |
