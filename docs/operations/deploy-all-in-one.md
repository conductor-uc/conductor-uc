# Scenario A: all-in-one deployment

Every component on one server. It suits a pilot, a small operator, or a staging copy of a larger installation. Read [components](components.md) and [network and firewall](network-and-firewall.md) first.

> **Status.** This guide and its compose file are a reference built from the code and the development stack. Every value was checked against the source, but **the whole procedure has not been run end to end on a real server.** Items that were never observed working are marked *not verified*. Do the first installation on a server you can rebuild, and test every step in §10.

## 1. What you get and what you give up

One server runs everything: api-gateway, OpenSIPs, one FreeSWITCH node and its recording uploader, the twelve application services, MariaDB, Redis and NATS. Object storage is either a hosted S3 service (recommended) or MinIO on the same server.

What an all-in-one server cannot do:

- **No redundancy.** If the server stops, calls stop. Plan for restore time ([operations §4](operations.md#4-backups-and-restore)).
- **One FreeSWITCH node**, so one server's call capacity. That is also the configuration in which queues, parking and conferences work reliably ([components §6](components.md#6-running-more-than-one-copy)).
- **Capacity is not measured.** Capacity benchmarks are plan task S4-09 and have not been run. A starting point for a pilot of a few hundred extensions and a few dozen simultaneous calls is 4 vCPU, 8 GB RAM and 60 GB SSD, with recordings in hosted object storage. Watch CPU during busy hours, especially with recording and conferences, and grow from there.

## 2. Server requirements

| Requirement | Detail |
|---|---|
| Operating system | Any current Linux that runs Docker Engine 24+ and the Compose v2 plugin. Examples use Ubuntu 24.04 LTS. |
| **Public IPv4 on the server's own network interface** | FreeSWITCH advertises the address of its default-route interface for audio ([network §4](network-and-firewall.md#4-media-rtp-and-why-freeswitch-needs-a-public-address)). Bare metal and most VPS providers give you this. **AWS, Google Cloud, Azure and anything behind 1:1 NAT do not.** There you must apply the `vars.xml` edit in network §4 (not verified), or use a provider that puts the address on the interface. Check with `ip -4 route get 1.1.1.1`: the `src` address must be the public one. |
| Free ports | Nothing else may use TCP 80, 443, 5060, 5061, 5080, 8021, 8888, 18080, 18081 or UDP 5060, 5080, 16384–32768 |
| Clock | NTP or chrony running (`timedatectl` shows `System clock synchronized: yes`) |
| DNS | The records in [DNS, TLS and certificates §2](dns-tls-and-certificates.md#2-dns-records), all pointing at the server's public IP |
| Outbound access | TCP 443 (Let's Encrypt, object storage, image builds), your SMTP relay's port, UDP 123 (NTP), your carriers |
| Build tools (on this server or a build machine) | Git; Docker with Buildx; the Flutter SDK 3.47.5 (stable) to build the web console |

Reference values used below: platform domain `voice.example.net`, public IP `203.0.113.10`, install directory `/opt/voice`.

## 3. Layout

```
                     Internet
   TCP 80/443 │   SIP 5060 udp/tcp, 5061 tcp │   RTP 16384-32768/udp
┌─────────────┼──────────────────────────────┼─────────────────────────────┐
│ server 203.0.113.10                        │                             │
│             │                              │                             │
│  ┌──────────▼─────────┐   host network:  ┌─▼────────────┐  ┌───────────┐ │
│  │ api-gateway        │   ──────────────  │ OpenSIPs     │  │FreeSWITCH │ │
│  │ (published 80,443) │                   │ :5060 :5061  │◀▶│ SIP :5080 │ │
│  └──────────┬─────────┘                   │ MI :8888     │  │ ESL :8021 │ │
│             │                             └──▲───────────┘  │ RTP range │ │
│  Docker network "backplane" 172.30.0.0/24    │ MI           └──▲──┬─────┘ │
│  ┌──────────▼───────────────────────────┐    │                 │  │xml_curl│
│  │ identity org pbx-config trunk ...    │────┘   ESL           │  │CDR     │
│  │ telephony-config (127.0.0.1:18080) ◀─┼────────────────────────┼──┘       │
│  │ cdr-service      (127.0.0.1:18081) ◀─┼────────────────────────┘          │
│  │ call-control ────────────────────────┼──▶ host.docker.internal:8021      │
│  │ recording-uploader ── spool (tmpfs, shared with FreeSWITCH)            │
│  │ MariaDB (127.0.0.1:3306)  Redis (127.0.0.1:6379)  NATS                  │
│  └──────────────────────────────────────┘                                │
└──────────────────────────────────────────────────────────────────────────┘
```

Design choices, and why:

- **OpenSIPs and FreeSWITCH use host networking.** FreeSWITCH must see the public address to advertise it, and publishing 16,385 UDP ports through Docker is impractical. OpenSIPs is host-networked so that FreeSWITCH and OpenSIPs see each other's real addresses (OpenSIPs recognises a node by source IP and port).
- **FreeSWITCH's SIP port moves to 5080** because OpenSIPs already holds 5060 on every address. FreeSWITCH binds SIP only to the public address, and the firewall keeps 5080 closed to the outside.
- **Everything else is on a private Docker network** with a fixed subnet (`172.30.0.0/24`), so firewall rules and the FreeSWITCH event-socket ACL can name it.
- **The host-networked processes reach the containers through ports published on 127.0.0.1 only**: MariaDB, Redis, telephony-config (as 18080) and cdr-service (as 18081). **The containers reach the host-networked ones through `host.docker.internal`**: OpenSIPs MI 8888, FreeSWITCH ESL 8021.
- **Only the gateway's 80 and 443 are published on the public address.** Docker-published ports bypass the host firewall ([network §7](network-and-firewall.md#7-docker-networking-rules-that-affect-the-firewall)), so nothing else is published publicly.

Port bindings on the server:

| Port | Protocol | Process | Bound to | Open to the internet? |
|---|---|---|---|---|
| 80, 443 | TCP | api-gateway (Docker-published) | 0.0.0.0 | **Yes** |
| 5060 | UDP, TCP | OpenSIPs | all addresses | **Yes** |
| 5061 | TCP | OpenSIPs (TLS) | all addresses | **Yes** |
| 16384–32768 | UDP | FreeSWITCH RTP | 203.0.113.10 | **Yes** |
| 5080 | UDP, TCP | FreeSWITCH SIP | 203.0.113.10 | No: reached by OpenSIPs locally |
| 8021 | TCP | FreeSWITCH ESL | 0.0.0.0 | No: Docker network only |
| 8888 | TCP | OpenSIPs MI | all addresses | No: Docker network only |
| 3306, 6379 | TCP | MariaDB, Redis (Docker-published) | 127.0.0.1 | No |
| 18080, 18081 | TCP | telephony-config, cdr-service (Docker-published) | 127.0.0.1 | No |
| 22 | TCP | SSH | — | Your administrators' addresses only |

## 4. Host firewall

UFW example. Adjust the SSH rule to your administrators' addresses.

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 198.51.100.0/24 to any port 22 proto tcp     # your admin network

# Public services (80 and 443 are Docker-published and bypass UFW anyway;
# the rules document intent and cover a later move to host networking).
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 5060/udp
sudo ufw allow 5060/tcp
sudo ufw allow 5061/tcp
sudo ufw allow 16384:32768/udp

# Containers on the private Docker network reach the host-networked
# FreeSWITCH event socket (call-control) and OpenSIPs MI (telephony-config).
sudo ufw allow from 172.30.0.0/24 to any port 8021 proto tcp
sudo ufw allow from 172.30.0.0/24 to any port 8888 proto tcp

sudo ufw enable
```

What must stay closed from outside, and is, by the default deny: 5080 (FreeSWITCH SIP), 8021 (ESL), 8888 (OpenSIPs MI, no authentication), and 9464 (uploader metrics, not published). Loopback traffic (OpenSIPs to FreeSWITCH on the public address, host processes to 127.0.0.1) is allowed by UFW's built-in loopback rules.

Check from **another** machine after start-up:

```sh
nmap -Pn -p 80,443,5060,5061,5080,8021,8888,3306,6379,4222 203.0.113.10
nmap -Pn -sU -p 5060,5080 203.0.113.10
```

Only 80, 443, 5060 and 5061 may show `open` (UDP 5060 shows `open|filtered`).

## 5. Prepare MariaDB

The MariaDB container runs `infra/compose/mariadb/init/*.sh` **once, on an empty data directory**. It creates one schema and one user per service, plus the `opensips` schema with OpenSIPs' tables. The scripts stop on any unset password variable, so set every one in `.env` (§7.1), including `EXAMPLE_SERVICE_DB_PASSWORD`. That last one creates an `example_service` schema and user no deployment uses; you may drop them afterwards:

```sh
docker compose exec mariadb mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" \
  -e "DROP USER 'example_service'@'%'; DROP DATABASE example_service;"
```

Each service user is granted all privileges on its own schema only, from any host (`'user'@'%'`). The MariaDB port is published on 127.0.0.1 only.

Connection count: 13 connection pools of 10 (telephony-config has two), plus OpenSIPs' workers, comes close to MariaDB's default `max_connections` of 151. The compose file raises it to 500.

## 6. Get the code and build

```sh
sudo mkdir -p /opt/voice && sudo chown "$USER" /opt/voice
cd /opt/voice
git clone <your repository URL> src
cd src && git checkout <release tag or commit> && cd ..
```

**Web console.** It is not in any image. Build it once per release:

```sh
cd /opt/voice/src/apps/console
flutter pub get
flutter build web --release --no-web-resources-cdn
# output: /opt/voice/src/apps/console/build/web
```

`--no-web-resources-cdn` matters: without it the console loads its rendering engine from a Google CDN, which the gateway's content security policy blocks. The console calls the API on its own origin, so no API address is compiled in.

**Images** are built by `docker compose build` from the compose file below (contexts under `./src`). Every Node.js image builds from the repository root and installs its dependencies with pnpm inside the build, so the first build takes a while. To build elsewhere, run `docker compose build` on a build machine, push the images to your registry, and set `image:` accordingly.

## 7. Configuration

Two files in `/opt/voice`: `.env` (values and secrets) and `compose.yml` (the services). Keep `.env` readable by root only (`chmod 600`).

### 7.1 `.env`

Generate every secret as shown in [configuration §2](configuration-reference.md#2-secrets-to-generate). Hex strings avoid quoting problems.

```sh
# /opt/voice/.env
RELEASE=2026.09.25
PUBLIC_IP=203.0.113.10
PLATFORM_BASE_DOMAIN=voice.example.net

# Master encryption key: store a copy OFF this server (configuration §3.5)
CRYPTO_KEKS=1:<base64 of 32 random bytes>
CRYPTO_KEK_CURRENT=1

INTERNAL_HEADER_SIGNING_SECRET=<hex>
INTERNAL_SERVICE_TOKEN=<hex>
FS_XML_CURL_TOKEN=<hex>
FS_CDR_INGEST_TOKEN=<hex>
FS_EVENT_SOCKET_PASSWORD=<hex>
NATS_USER=platform
NATS_PASSWORD=<hex>

MARIADB_ROOT_PASSWORD=<hex>
IDENTITY_SERVICE_DB_PASSWORD=<hex>
ORG_SERVICE_DB_PASSWORD=<hex>
PBX_CONFIG_SERVICE_DB_PASSWORD=<hex>
EXAMPLE_SERVICE_DB_PASSWORD=<hex>
TELEPHONY_CONFIG_SERVICE_DB_PASSWORD=<hex>
TRUNK_SERVICE_DB_PASSWORD=<hex>
MEDIA_WORKER_DB_PASSWORD=<hex>
CALL_CONTROL_DB_PASSWORD=<hex>
CALLFLOW_SERVICE_DB_PASSWORD=<hex>
VOICEMAIL_SERVICE_DB_PASSWORD=<hex>
CDR_SERVICE_DB_PASSWORD=<hex>
NOTIFICATION_SERVICE_DB_PASSWORD=<hex>
RECORDING_SERVICE_DB_PASSWORD=<hex>
OPENSIPS_DB_PASSWORD=<hex>

# Object storage (hosted S3 example). Must be HTTPS and reachable by browsers.
STORAGE_BUCKET_PREFIX=v1prod
STORAGE_ENDPOINT=https://s3.eu-central-1.wasabisys.com
STORAGE_REGION=eu-central-1
STORAGE_ACCESS_KEY_ID=<key id>
STORAGE_SECRET_ACCESS_KEY=<secret>
STORAGE_FORCE_PATH_STYLE=false
STORAGE_ORIGIN=https://s3.eu-central-1.wasabisys.com

# Email
SMTP_HOST=smtp.example.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<user>
SMTP_PASSWORD=<password>
PLATFORM_NOREPLY_ADDRESS=noreply@voice.example.net

# Phone provisioning (optional platform-wide login; G-103)
PROVISIONING_USERNAME=phones
PROVISIONING_PASSWORD=<hex>
```

`STORAGE_ORIGIN` is not read by any service; the compose file passes it to the gateway's `CONSOLE_CONNECT_SOURCES`. It is the scheme and host of `STORAGE_ENDPOINT`. For AWS S3 (no `STORAGE_ENDPOINT`), use `https://*.s3.<region>.amazonaws.com`.

### 7.2 `compose.yml`

```yaml
# /opt/voice/compose.yml: all-in-one reference (not verified end to end)
name: voice

x-service: &service
  restart: unless-stopped
  networks: [backplane]
  logging:
    driver: json-file
    options: { max-size: '50m', max-file: '5' }

# Distroless images keep node at /nodejs/bin/node and have no shell or curl.
x-healthcheck: &healthcheck
  test:
    - CMD
    - /nodejs/bin/node
    - -e
    - "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
  interval: 10s
  timeout: 5s
  retries: 12
  start_period: 20s

x-db: &db
  DB_HOST: mariadb
  DB_PORT: '3306'
x-nats: &nats
  NATS_SERVERS: nats://nats:4222
  NATS_USER: ${NATS_USER}
  NATS_PASSWORD: ${NATS_PASSWORD}
x-trust: &trust
  TRUST_INTERNAL_HEADERS: 'true'
  INTERNAL_HEADER_SIGNING_SECRET: ${INTERNAL_HEADER_SIGNING_SECRET}
x-crypto: &crypto
  CRYPTO_KEKS: ${CRYPTO_KEKS}
  CRYPTO_KEK_CURRENT: ${CRYPTO_KEK_CURRENT}
x-storage: &storage
  STORAGE_MODE: bucket-per-tenant
  STORAGE_BUCKET_PREFIX: ${STORAGE_BUCKET_PREFIX}
  STORAGE_ENDPOINT: ${STORAGE_ENDPOINT}
  STORAGE_REGION: ${STORAGE_REGION}
  STORAGE_ACCESS_KEY_ID: ${STORAGE_ACCESS_KEY_ID}
  STORAGE_SECRET_ACCESS_KEY: ${STORAGE_SECRET_ACCESS_KEY}
  STORAGE_FORCE_PATH_STYLE: ${STORAGE_FORCE_PATH_STYLE}
x-common: &common
  SERVICE_VERSION: ${RELEASE}
  LOG_LEVEL: info
  HTTP_HOST: 0.0.0.0
  HTTP_PORT: '8080'
  INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN}

x-urls: &urls
  IDENTITY_SERVICE_URL: http://identity-service:8080
  ORG_SERVICE_URL: http://org-service:8080
  PBX_CONFIG_SERVICE_URL: http://pbx-config-service:8080
  TRUNK_SERVICE_URL: http://trunk-service:8080
  CALLFLOW_SERVICE_URL: http://callflow-service:8080
  VOICEMAIL_SERVICE_URL: http://voicemail-service:8080
  RECORDING_SERVICE_URL: http://recording-service:8080
  CDR_SERVICE_URL: http://cdr-service:8080
  TELEPHONY_CONFIG_URL: http://telephony-config:8080
  CALL_CONTROL_URL: http://call-control:8080

networks:
  backplane:
    driver: bridge
    ipam:
      config: [{ subnet: 172.30.0.0/24 }]

volumes:
  mariadb-data:
  nats-data:
  # FreeSWITCH writes recordings here (as root); the uploader (uid 65532) uploads
  # and deletes them. tmpfs: nothing durable on the media server. 0777, NOT 1777.
  recording-spool:
    driver: local
    driver_opts: { type: tmpfs, device: tmpfs, o: 'size=2g,mode=0777' }

services:
  # ---------------------------------------------------------------- data
  mariadb:
    <<: *service
    image: mariadb:11.4
    command: ['--max-connections=500']
    environment:
      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD}
      IDENTITY_SERVICE_DB_PASSWORD: ${IDENTITY_SERVICE_DB_PASSWORD}
      ORG_SERVICE_DB_PASSWORD: ${ORG_SERVICE_DB_PASSWORD}
      PBX_CONFIG_SERVICE_DB_PASSWORD: ${PBX_CONFIG_SERVICE_DB_PASSWORD}
      EXAMPLE_SERVICE_DB_PASSWORD: ${EXAMPLE_SERVICE_DB_PASSWORD}
      TELEPHONY_CONFIG_SERVICE_DB_PASSWORD: ${TELEPHONY_CONFIG_SERVICE_DB_PASSWORD}
      TRUNK_SERVICE_DB_PASSWORD: ${TRUNK_SERVICE_DB_PASSWORD}
      MEDIA_WORKER_DB_PASSWORD: ${MEDIA_WORKER_DB_PASSWORD}
      CALL_CONTROL_DB_PASSWORD: ${CALL_CONTROL_DB_PASSWORD}
      CALLFLOW_SERVICE_DB_PASSWORD: ${CALLFLOW_SERVICE_DB_PASSWORD}
      VOICEMAIL_SERVICE_DB_PASSWORD: ${VOICEMAIL_SERVICE_DB_PASSWORD}
      CDR_SERVICE_DB_PASSWORD: ${CDR_SERVICE_DB_PASSWORD}
      NOTIFICATION_SERVICE_DB_PASSWORD: ${NOTIFICATION_SERVICE_DB_PASSWORD}
      RECORDING_SERVICE_DB_PASSWORD: ${RECORDING_SERVICE_DB_PASSWORD}
      OPENSIPS_DB_PASSWORD: ${OPENSIPS_DB_PASSWORD}
    ports: ['127.0.0.1:3306:3306']
    volumes:
      - mariadb-data:/var/lib/mysql
      - ./src/infra/compose/mariadb/init:/docker-entrypoint-initdb.d:ro
      - ./src/telephony/opensips/db-schema:/opensips-schema:ro
    healthcheck:
      test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized']
      interval: 5s
      timeout: 5s
      retries: 30

  redis:
    <<: *service
    image: redis:7-alpine
    # Nothing in Redis is durable; no password (FreeSWITCH cannot send one).
    command: ['redis-server', '--save', '', '--appendonly', 'no']
    ports: ['127.0.0.1:6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10

  nats:
    <<: *service
    image: nats:2.10-alpine
    command: ['-js', '-sd', '/data', '--user', '${NATS_USER}', '--pass', '${NATS_PASSWORD}', '-m', '8222']
    volumes: ['nats-data:/data']
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8222/healthz']
      interval: 5s
      timeout: 5s
      retries: 10

  # ---------------------------------------------------------------- application services
  identity-service:
    <<: *service
    image: voice/identity-service:${RELEASE}
    build: { context: ./src, dockerfile: services/identity-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *crypto, *urls]
      SERVICE_NAME: identity-service
      DB_USER: identity_service
      DB_PASSWORD: ${IDENTITY_SERVICE_DB_PASSWORD}
      DB_NAME: identity_service
      COOKIE_SECURE: 'true'
    healthcheck: *healthcheck

  org-service:
    <<: *service
    image: voice/org-service:${RELEASE}
    build: { context: ./src, dockerfile: services/org-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *crypto, *storage, *urls]
      SERVICE_NAME: org-service
      DB_USER: org_service
      DB_PASSWORD: ${ORG_SERVICE_DB_PASSWORD}
      DB_NAME: org_service
      PLATFORM_BASE_DOMAIN: ${PLATFORM_BASE_DOMAIN}
    healthcheck: *healthcheck

  pbx-config-service:
    <<: *service
    image: voice/pbx-config-service:${RELEASE}
    build: { context: ./src, dockerfile: services/pbx-config-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *crypto, *storage, *urls]
      SERVICE_NAME: pbx-config-service
      DB_USER: pbx_config_service
      DB_PASSWORD: ${PBX_CONFIG_SERVICE_DB_PASSWORD}
      DB_NAME: pbx_config_service
      PROVISIONING_BASE_URL: https://console.${PLATFORM_BASE_DOMAIN}
      PROVISIONING_USERNAME: ${PROVISIONING_USERNAME}
      PROVISIONING_PASSWORD: ${PROVISIONING_PASSWORD}
      SIP_PUBLIC_PORT: '5060'
      SIP_PUBLIC_TLS_PORT: '5061'
      SIP_PUBLIC_TRANSPORTS: udp,tcp      # tls,tcp,udp once SIP certificates are active
    healthcheck: *healthcheck

  trunk-service:
    <<: *service
    image: voice/trunk-service:${RELEASE}
    build: { context: ./src, dockerfile: services/trunk-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *crypto, *urls]
      SERVICE_NAME: trunk-service
      DB_USER: trunk_service
      DB_PASSWORD: ${TRUNK_SERVICE_DB_PASSWORD}
      DB_NAME: trunk_service
    healthcheck: *healthcheck

  callflow-service:
    <<: *service
    image: voice/callflow-service:${RELEASE}
    build: { context: ./src, dockerfile: services/callflow-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *urls]
      SERVICE_NAME: callflow-service
      DB_USER: callflow_service
      DB_PASSWORD: ${CALLFLOW_SERVICE_DB_PASSWORD}
      DB_NAME: callflow_service
    healthcheck: *healthcheck

  voicemail-service:
    <<: *service
    image: voice/voicemail-service:${RELEASE}
    build: { context: ./src, dockerfile: services/voicemail-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *crypto, *storage, *urls]
      SERVICE_NAME: voicemail-service
      DB_USER: voicemail_service
      DB_PASSWORD: ${VOICEMAIL_SERVICE_DB_PASSWORD}
      DB_NAME: voicemail_service
    healthcheck: *healthcheck

  recording-service:
    <<: *service
    image: voice/recording-service:${RELEASE}
    build: { context: ./src, dockerfile: services/recording-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *storage, *urls]
      SERVICE_NAME: recording-service
      DB_USER: recording_service
      DB_PASSWORD: ${RECORDING_SERVICE_DB_PASSWORD}
      DB_NAME: recording_service
    healthcheck: *healthcheck

  cdr-service:
    <<: *service
    image: voice/cdr-service:${RELEASE}
    build: { context: ./src, dockerfile: services/cdr-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *trust, *storage, *urls]
      SERVICE_NAME: cdr-service
      DB_USER: cdr_service
      DB_PASSWORD: ${CDR_SERVICE_DB_PASSWORD}
      DB_NAME: cdr_service
      FS_CDR_INGEST_TOKEN: ${FS_CDR_INGEST_TOKEN}
    ports: ['127.0.0.1:18081:8080']        # FreeSWITCH (host network) posts CDRs here
    healthcheck: *healthcheck

  call-control:
    <<: *service
    image: voice/call-control:${RELEASE}
    build: { context: ./src, dockerfile: services/call-control/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
      redis: { condition: service_healthy }
    extra_hosts: ['host.docker.internal:host-gateway']
    environment:
      <<: [*common, *db, *nats]
      SERVICE_NAME: call-control
      DB_USER: call_control
      DB_PASSWORD: ${CALL_CONTROL_DB_PASSWORD}
      DB_NAME: call_control
      REDIS_URL: redis://redis:6379
      REDIS_KEY_PREFIX: 'voice:prod:'
      FS_NODES: fs1:host.docker.internal:8021
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
    healthcheck: *healthcheck

  telephony-config:
    <<: *service
    image: voice/telephony-config:${RELEASE}
    build: { context: ./src, dockerfile: services/telephony-config/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
      redis: { condition: service_healthy }
      call-control: { condition: service_started }
    extra_hosts: ['host.docker.internal:host-gateway']
    environment:
      <<: [*common, *db, *nats, *storage, *urls]
      SERVICE_NAME: telephony-config
      DB_USER: telephony_config
      DB_PASSWORD: ${TELEPHONY_CONFIG_SERVICE_DB_PASSWORD}
      DB_NAME: telephony_config
      OPENSIPS_DB_HOST: mariadb
      OPENSIPS_DB_USER: opensips
      OPENSIPS_DB_PASSWORD: ${OPENSIPS_DB_PASSWORD}
      OPENSIPS_DB_NAME: opensips
      OPENSIPS_MI_URL: http://host.docker.internal:8888/mi
      OPENSIPS_SIP_URI: ${PUBLIC_IP}:5060
      SELF_URL: http://127.0.0.1:18080       # as FreeSWITCH reaches it
      FS_XML_CURL_TOKEN: ${FS_XML_CURL_TOKEN}
      REDIS_URL: redis://redis:6379
      REDIS_KEY_PREFIX: 'voice:prod:'
      RECORDING_SPOOL_DIR: /var/spool/cuc/rec
    ports: ['127.0.0.1:18080:8080']        # FreeSWITCH (host network) calls /fs/* here
    healthcheck: *healthcheck

  media-worker:
    <<: *service
    image: voice/media-worker:${RELEASE}
    build: { context: ./src, dockerfile: services/media-worker/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *storage, *urls]
      SERVICE_NAME: media-worker
      DB_USER: media_worker
      DB_PASSWORD: ${MEDIA_WORKER_DB_PASSWORD}
      DB_NAME: media_worker
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

  notification-service:
    <<: *service
    image: voice/notification-service:${RELEASE}
    build: { context: ./src, dockerfile: services/notification-service/Dockerfile }
    depends_on:
      mariadb: { condition: service_healthy }
      nats: { condition: service_healthy }
    environment:
      <<: [*common, *db, *nats, *urls]
      SERVICE_NAME: notification-service
      DB_USER: notification_service
      DB_PASSWORD: ${NOTIFICATION_SERVICE_DB_PASSWORD}
      DB_NAME: notification_service
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_SECURE: ${SMTP_SECURE}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
      PLATFORM_NOREPLY_ADDRESS: ${PLATFORM_NOREPLY_ADDRESS}
      PLATFORM_BASE_DOMAIN: ${PLATFORM_BASE_DOMAIN}
      CONSOLE_LINK_SCHEME: https
    healthcheck: *healthcheck

  # ---------------------------------------------------------------- edge
  api-gateway:
    <<: *service
    image: voice/api-gateway:${RELEASE}
    build: { context: ./src, dockerfile: services/api-gateway/Dockerfile }
    depends_on:
      redis: { condition: service_healthy }
      identity-service: { condition: service_healthy }
      org-service: { condition: service_healthy }
    # Lets the non-root process bind 80 and 443 inside its own network namespace.
    sysctls: ['net.ipv4.ip_unprivileged_port_start=0']
    ports: ['80:80', '443:443']
    volumes:
      - ./src/apps/console/build/web:/console:ro
      - ./bootstrap-tls:/tls:ro
    environment:
      <<: [*common, *urls]
      SERVICE_NAME: api-gateway
      HTTP_PORT: '443'                      # must be 443: redirects are built from it
      HTTP_REDIRECT_PORT: '80'
      INTERNAL_HEADER_SIGNING_SECRET: ${INTERNAL_HEADER_SIGNING_SECRET}
      REDIS_URL: redis://redis:6379
      TLS_FROM_ORG_SERVICE: 'true'
      TLS_CERT_FILE: /tls/fullchain.pem
      TLS_KEY_FILE: /tls/privkey.pem
      HSTS_MAX_AGE_SECONDS: '31536000'
      REQUIRE_HTTPS_FOR_PROVISIONING: 'true'
      CONSOLE_DIR: /console
      CONSOLE_CONNECT_SOURCES: ${STORAGE_ORIGIN}
    # Liveness through the plain-HTTP listener: it answers 308 without TLS, so the
    # check needs no certificate for 127.0.0.1 and no disabled verification.
    healthcheck:
      <<: *healthcheck
      test: ['CMD', '/nodejs/bin/node', '-e', "require('http').get({host:'127.0.0.1',port:80,path:'/'},r=>process.exit(r.statusCode===308?0:1)).on('error',()=>process.exit(1))"]

  # ---------------------------------------------------------------- telephony (host network)
  opensips:
    image: voice/opensips:${RELEASE}
    build: { context: ./src/telephony/opensips }
    restart: unless-stopped
    network_mode: host
    depends_on:
      mariadb: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      OPENSIPS_LOG_LEVEL: '3'
      OPENSIPS_IDENTITY: SIP Media Server
      OPENSIPS_SIP_PORT: '5060'
      OPENSIPS_MI_PORT: '8888'
      OPENSIPS_DB_URL: mysql://opensips:${OPENSIPS_DB_PASSWORD}@127.0.0.1:3306/opensips
      OPENSIPS_REDIS_URL: redis:cuc://127.0.0.1:6379/0
      OPENSIPS_FS_DESTINATION: sip:${PUBLIC_IP}:5080
      OPENSIPS_REGISTRANT_TIMER_INTERVAL: '60'
      OPENSIPS_TLS_ENABLED: 'true'
      OPENSIPS_TLS_DEV_SELF_SIGNED: 'false'
    logging:
      driver: json-file
      options: { max-size: '50m', max-file: '5' }

  freeswitch:
    image: voice/freeswitch:${RELEASE}
    build: { context: ./src/telephony/freeswitch }
    restart: unless-stopped
    network_mode: host
    depends_on:
      telephony-config: { condition: service_healthy }
      cdr-service: { condition: service_healthy }
    environment:
      FS_NODE_ID: fs1
      FS_SIP_PORT: '5080'
      FS_OPENSIPS_CIDR: ${PUBLIC_IP}/32      # OpenSIPs reaches FreeSWITCH from the public address
      FS_CLUSTER_CIDR: 172.30.0.0/24         # call-control, from the Docker network
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
      TELEPHONY_CONFIG_URL: http://127.0.0.1:18080
      FS_XML_CURL_TOKEN: ${FS_XML_CURL_TOKEN}
      CDR_SERVICE_URL: http://127.0.0.1:18081
      FS_CDR_INGEST_TOKEN: ${FS_CDR_INGEST_TOKEN}
      FS_REDIS_HOST: 127.0.0.1
      FS_REDIS_PORT: '6379'
      FS_RTP_START_PORT: '16384'
      FS_RTP_END_PORT: '32768'
      FS_SIP_IDENTITY: SIP Media Server
      FS_SDP_IDENTITY: SIP-Media-Server
      FS_LOG_LEVEL: info
    volumes:
      - recording-spool:/var/spool/cuc/rec
    tmpfs:
      - /var/cache/cuc/flow
      - /var/cache/cuc/http
    logging:
      driver: json-file
      options: { max-size: '50m', max-file: '5' }

  recording-uploader:
    <<: *service
    image: voice/recording-service:${RELEASE}
    command: ['dist/src/uploader/main.js']
    depends_on:
      recording-service: { condition: service_healthy }
    volumes:
      - recording-spool:/var/spool/cuc/rec
    environment:
      SERVICE_NAME: recording-uploader-fs1
      RECORDING_SERVICE_URL: http://recording-service:8080
      INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN}
      SPOOL_DIR: /var/spool/cuc/rec
```

### 7.3 FreeSWITCH

- `FS_OPENSIPS_CIDR` is the public address because OpenSIPs, sending to FreeSWITCH's public address, uses the public address as its source. `OPENSIPS_FS_DESTINATION` is `sip:<public ip>:5080` because FreeSWITCH sends from exactly that address and port, and OpenSIPs recognises a node by both.
- FreeSWITCH reaches telephony-config and cdr-service on 127.0.0.1 through Docker's published ports. This relies on Docker's default userland proxy (`"userland-proxy": true`, the default). If you have turned it off in `/etc/docker/daemon.json`, host processes may not reach ports published on 127.0.0.1.
- call-control reaches the event socket through `host.docker.internal`, arriving from its address in `172.30.0.0/24`, which is why that subnet is `FS_CLUSTER_CIDR` and is allowed in the firewall.
- *Not verified:* this exact host-networked layout. The development and test stack runs both processes on a Docker bridge.

### 7.4 OpenSIPs

- `OPENSIPS_SIP_URI` (in telephony-config) is `<public ip>:5060`: FreeSWITCH routes outbound legs there, and carriers receive it as the contact when OpenSIPs registers a trunk. Both need to reach it.
- `OPENSIPS_REGISTRANT_TIMER_INTERVAL` is 60 here (the development stack uses 10 for fast tests).
- If the database password contains characters that are special in a URL, encode them in `OPENSIPS_DB_URL`. Hex passwords avoid this.
- OpenSIPs listens on every address, including the Docker bridge addresses. That is harmless: the firewall does not expose them.

### 7.5 api-gateway

- `HTTP_PORT` must be 443 inside the container, because the HTTP-to-HTTPS redirect is built from it. `net.ipv4.ip_unprivileged_port_start=0` lets the non-root process bind 80 and 443 inside its own network namespace only.
- Put the bootstrap certificate ([DNS/TLS §4](dns-tls-and-certificates.md#4-the-bootstrap-certificate-first-installation)) in `/opt/voice/bootstrap-tls/fullchain.pem` and `privkey.pem`, readable by uid 65532 (`chmod 644 fullchain.pem; chmod 640 privkey.pem; chgrp 65532 privkey.pem`).
- It faces the internet directly, so `X-Forwarded-For` from clients is believed ([network §6.3](network-and-firewall.md#63-the-gateway-believes-x-forwarded-headers)).

### 7.6 Self-hosted MinIO instead of hosted S3

Only if you cannot use a hosted object store. Add this service, create DNS `s3.voice.example.net` pointing at the server, and give MinIO a certificate for that name (for example `certbot certonly --standalone -d s3.voice.example.net` before the gateway takes port 80, renewed with a DNS challenge afterwards):

```yaml
  minio:
    <<: *service
    image: minio/minio:latest          # pin a release in production
    command: ['server', '/data', '--address', ':9000', '--console-address', '127.0.0.1:9001', '--certs-dir', '/certs']
    environment:
      MINIO_ROOT_USER: ${STORAGE_ACCESS_KEY_ID}
      MINIO_ROOT_PASSWORD: ${STORAGE_SECRET_ACCESS_KEY}
    ports: ['9000:9000']               # public: browsers, FreeSWITCH, uploader
    volumes:
      - /srv/minio:/data                # durable disk; back it up
      - ./minio-certs:/certs:ro         # public.crt and private.key for s3.voice.example.net
```

Then set `STORAGE_ENDPOINT=https://s3.voice.example.net:9000`, `STORAGE_ORIGIN=https://s3.voice.example.net:9000`, `STORAGE_FORCE_PATH_STYLE=true`, and open TCP 9000 in the firewall (`sudo ufw allow 9000/tcp`; Docker-published anyway). Containers reach MinIO through the server's public address (hairpin). If that fails on your host, add `extra_hosts: ['s3.voice.example.net:host-gateway']` to every service that uses storage. Using the root credentials as the platform's keys is simplest; a dedicated MinIO user with bucket-management rights is better. Recordings and voicemail then live on this server's disk: add `/srv/minio` to your backups.

## 8. First start

```sh
cd /opt/voice
docker compose build                       # all images; long the first time
docker compose up -d mariadb redis nats
docker compose ps                          # wait until the three are healthy
docker compose up -d
docker compose ps                          # everything running; Node services healthy after ~1 min
```

Services create their tables on first start. If a service keeps restarting, read its log (`docker compose logs --tail=100 <service>`). It prints every configuration problem at once.

## 9. Bootstrap the platform

### 9.1 Create the master organisation and its first administrator

One command creates the single master organisation and its first administrator, a person with the `master_admin` role:

```sh
docker compose run --rm org-service dist/src/cli/bootstrap-master.js \
  --slug master --name Master \
  --admin-email you@example.net --admin-name 'Platform administrator'
```

It asks for the administrator's password twice without showing it (at least 12 characters). The password is never a command-line argument. To run it unattended, put the password in `BOOTSTRAP_ADMIN_PASSWORD` and pass that through, or pipe it in as one line with `-T`:

```sh
read -rs BOOTSTRAP_ADMIN_PASSWORD && export BOOTSTRAP_ADMIN_PASSWORD
docker compose run --rm -e BOOTSTRAP_ADMIN_PASSWORD org-service dist/src/cli/bootstrap-master.js \
  --slug master --name Master --admin-email you@example.net --admin-name 'Platform administrator'
unset BOOTSTRAP_ADMIN_PASSWORD

# or
printf '%s\n' "$PASSWORD" | docker compose run --rm -T org-service dist/src/cli/bootstrap-master.js \
  --slug master --name Master --admin-email you@example.net --admin-name 'Platform administrator'
```

The command runs org-service's migrations, creates the master organisation, then creates the administrator through identity-service's internal API on the private network (so identity-service must be running: `docker compose ps` shows it `healthy`). It logs JSON lines with the `"orgId"` of the master and the `"userId"` of the administrator, never the password.

It is safe to run again. An existing master is kept, and the administrator is created only while the master has no users at all: once anyone exists, it creates nobody and exits 0, whatever email you give. If the organisation was created but the administrator was not (identity-service not reachable, for example), it exits 1 with the reason; run the same command again and it creates only the administrator.

To look up the master's id later:

```sh
docker compose exec mariadb mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" \
  -e "SELECT id, slug FROM org_service.orgs WHERE type='master';"
```

(`$MARIADB_ROOT_PASSWORD` is in `.env`; `set -a; . ./.env; set +a` loads it into your shell.)

### 9.2 More master administrators

Invite further master administrators from the console (**Users**). If the only one has lost their two-step device, see [operations §2](operations.md#2-first-administrator-resellers-and-tenants).

### 9.3 Sign in and finish setup in the console

1. Open `https://console.voice.example.net` and sign in with that email and password. Master and reseller administrators must set up two-step verification (a TOTP app) at first sign-in.
2. **Certificates** section, **Public address:** enter `203.0.113.10` and save. It is used for the DNS records the console shows resellers.
3. Same section: enter the **contact email**, choose **Staging (testing)** as the environment, read and agree to the agreement, and save. Within a few minutes org-service should obtain staging certificates for `console.` and `sip.` (`docker compose logs -f org-service`). When that works, switch to **production**. The gateway then serves the real certificate for `console.`, and OpenSIPs the one for `sip.`.
4. Create a reseller, a tenant, and a few extensions. Register a softphone to the tenant domain (for example `acme.voice.example.net`) on UDP 5060 with an extension's credentials. Once the `sip.` certificate is active, try TLS on 5061 and set `SIP_PUBLIC_TRANSPORTS=tls,tcp,udp` in pbx-config-service.

## 10. Verify

Work through this list on a new installation, and after every upgrade.

| # | Check | How | Expect |
|---|---|---|---|
| 1 | All containers up | `docker compose ps` | Every service `running`; Node services `healthy` |
| 2 | Platform health | In the console as master, **Platform health** (or `GET /v1/platform/health`) | All eight services ready |
| 3 | Internal readiness | `docker run --rm --network voice_backplane curlimages/curl -s http://telephony-config:8080/readyz` | `"status":"pass"`, including `opensips_db` and `redis` |
| 4 | OpenSIPs up | `docker compose logs opensips | tail` and `ss -lunp | grep 5060` | Listening; no DB errors |
| 5 | FreeSWITCH up, SDP address right | `docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia status profile internal'` | `RUNNING`; `SIP-IP` and `EXT-RTP-IP` are the public address |
| 6 | call-control sees the node | `docker compose logs call-control | grep -i connect` | Connected to `fs1` |
| 7 | Firewall | nmap from outside (§4) | Only 80, 443, 5060, 5061 open |
| 8 | Registration | Softphone registers to the tenant domain | Registered |
| 9 | Internal call with audio | Extension to extension, both directions | Two-way audio (proves RTP and the public SDP address) |
| 10 | Carrier call | Add a trunk and a DID; call in from a mobile | Rings the extension, two-way audio |
| 11 | Voicemail | Let a call go unanswered | Message appears in the console, plays in the browser (proves object storage from the browser) |
| 12 | Recording | Add a recording rule for one extension; call it | Recording appears after ~30 s; nothing left in the spool: `docker compose exec freeswitch ls /var/spool/cuc/rec` |
| 13 | Email | Invite a user | Invitation arrives; links point at `https://console.…` |
| 14 | Certificates | `openssl s_client -connect sip.voice.example.net:5061 -servername sip.voice.example.net </dev/null` | Let's Encrypt certificate for `sip.voice.example.net` |

## 11. Running it

Upgrades, backups, monitoring, log handling, secret rotation and troubleshooting are in [Day-2 operations](operations.md). In short, for this layout:

- **Back up** the MariaDB volume (logical dumps, §4 there), `/opt/voice/.env`, a copy of `CRYPTO_KEKS` held off the server, and object storage if it is self-hosted.
- **Upgrade** by checking out the new release, rebuilding the console and images, and `docker compose up -d`. Services migrate their own schemas on start.
- **Logs** are in `docker compose logs`, rotated by the `json-file` settings above.
