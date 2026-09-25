# Network and firewall

Every port the platform listens on and every connection it makes: who opens it, whether it must be public, and what protects it. The two deployment guides turn this into concrete firewall rules ([all-in-one §4](deploy-all-in-one.md#4-host-firewall), [distributed §5](deploy-distributed.md#5-firewall-rules-per-server)).

## 1. Public or private, at a glance

| Component | Needs a public address? | Why |
|---|---|---|
| **api-gateway** | **Yes**: TCP 443 and 80 | Browsers, phones fetching their provisioning files, and Let's Encrypt validation all come from the internet. Port 80 must be on **the same public IP as OpenSIPs** ([§3.3](#33-port-80-must-share-the-sip-edges-address)). |
| **OpenSIPs** | **Yes**: UDP and TCP 5060, TCP 5061 | Phones register and call; carriers send and receive calls. Its management port 8888 must stay private. |
| **FreeSWITCH** | **Yes, for media**: UDP 16384–32768 | Audio flows straight between phones or carriers and FreeSWITCH, and FreeSWITCH advertises its own interface address in SDP ([§4](#4-media-rtp-and-why-freeswitch-needs-a-public-address)). Its SIP port and event socket must stay private. |
| **Object storage** | **Reachable over HTTPS by browsers** (and by FreeSWITCH servers) | Browsers download recordings, voicemail and exports, and upload prompts and logos, through presigned URLs on `STORAGE_ENDPOINT`. A hosted S3 provider satisfies this; a self-hosted MinIO needs a public HTTPS name. |
| recording-uploader | No | Outbound only, plus a private metrics port |
| All twelve application services | **No, never** | Private by design; shared internal secrets protect them ([§6.1](#61-keep-backend-service-ports-private)) |
| MariaDB, Redis, NATS | **No, never** | No TLS support in the clients; Redis and (by default) NATS have no password |

Everything private can sit behind NAT or on a network with no internet route, **except** where it needs outbound internet access ([§5](#5-outbound-connections)): org-service (Let's Encrypt, DNS), notification-service (SMTP relay), and anything that talks to a hosted object store.

## 2. Every listening port

"Bind" is the address the process listens on in the shipped configuration. "Auth" is what the process itself checks. Where it says **none**, only the network protects the port.

### 2.1 Public ports

| Component | Port | Protocol | Bind | Who connects | Auth | Notes |
|---|---|---|---|---|---|---|
| api-gateway | 443 (`HTTP_PORT`) | TCP, HTTPS (TLS 1.2 minimum) | `HTTP_HOST` (0.0.0.0) | Browsers, phones, API clients | Access token (JWT) on `/v1/*` except `/v1/auth` and `/v1/public` | Serves plain HTTP if no certificate source is configured. Must be 443 inside the container too, or HTTPS redirects point at the wrong port ([all-in-one §7.5](deploy-all-in-one.md#75-api-gateway)). |
| api-gateway | 80 (`HTTP_REDIRECT_PORT`) | TCP, HTTP | `HTTP_HOST` | Let's Encrypt validation servers; browsers typing `http://` | None | Answers `/.well-known/acme-challenge/*`; redirects everything else (308) to HTTPS. Only opened if `HTTP_REDIRECT_PORT` is set. |
| OpenSIPs | 5060 (`OPENSIPS_SIP_PORT`) | UDP | all interfaces | Phones, carriers, FreeSWITCH nodes | Digest for phones; source IP for trunks; dispatcher membership (IP and port) for FreeSWITCH | Flood limit: 30 requests per 2 s per source IP |
| OpenSIPs | 5060 | TCP | all interfaces | Phones, carriers | Same | |
| OpenSIPs | 5061 | TCP, SIP over TLS | all interfaces | Phones | Same, inside TLS | Only when TLS is enabled. The container always listens on 5061 (`OPENSIPS_TLS_PORT` is not passed through by the development compose file). |
| FreeSWITCH | 16384–32768 (`FS_RTP_START_PORT`–`FS_RTP_END_PORT`) | UDP, RTP and RTCP | detected interface address | Phones, carriers | None (unencrypted RTP; SRTP is not built) | Needed open to the whole internet: a phone or carrier sends media from wherever it is |

WebSocket SIP (WS/WSS), SIP over IPv6 and HEP capture are not configured.

### 2.2 Private ports

| Component | Port | Protocol | Bind | Who must connect | Auth | Must allow only |
|---|---|---|---|---|---|---|
| OpenSIPs MI | 8888 (`OPENSIPS_MI_PORT`) | TCP, HTTP JSON-RPC | **all interfaces** | telephony-config; the container's own health check (127.0.0.1) | **None** | telephony-config's address. Anyone who reaches it can reload or change OpenSIPs' state. |
| FreeSWITCH SIP | 5060 (`FS_SIP_PORT`) | UDP and TCP | detected interface address only | OpenSIPs | ACL `FS_OPENSIPS_CIDR` (one CIDR) | OpenSIPs' address |
| FreeSWITCH ESL | 8021 (fixed) | TCP | 0.0.0.0 (`FS_EVENT_SOCKET_BIND_IP`) | call-control | ACL `FS_CLUSTER_CIDR` (one CIDR) plus `FS_EVENT_SOCKET_PASSWORD` | call-control's address. ESL can run any FreeSWITCH command. |
| Every application service | 8080 (`HTTP_PORT`) | TCP, HTTP | `HTTP_HOST` (0.0.0.0) | The gateway and other services ([§2.3](#23-who-calls-which-service)) | Signed identity headers from the gateway, or `INTERNAL_SERVICE_TOKEN`; public routes need none ([§6.1](#61-keep-backend-service-ports-private)) | Only the callers in §2.3 |
| recording-uploader | 9464 (`METRICS_PORT`) | TCP, HTTP | `METRICS_HOST` (0.0.0.0) | Your monitoring system | None | Your monitoring system |
| MariaDB | 3306 | TCP (no TLS) | container default | Every service except api-gateway; OpenSIPs; telephony-config (also the `opensips` schema) | Per-service user and password | Those hosts |
| Redis | 6379 | TCP (no TLS) | container default | api-gateway, call-control, telephony-config, FreeSWITCH, OpenSIPs | **None** (FreeSWITCH's Redis module has no password option) | Those hosts |
| NATS client | 4222 | TCP (no TLS) | container default | Every application service | None in the development stack; username and password supported (`NATS_USER`, `NATS_PASSWORD`) | Those hosts |
| NATS monitoring | 8222 | TCP, HTTP | container default | Your monitoring system | None | Monitoring only, or do not publish it |
| MinIO console | 9001 | TCP, HTTP | container default | Administrators | MinIO root credentials | Do not publish it, or administrators' addresses only |
| MinIO API (self-hosted object storage) | 9000 | TCP, HTTP (HTTPS if you give MinIO a certificate) | container default | Services, uploaders, FreeSWITCH; browsers **via HTTPS** | S3 signatures | See [§1](#1-public-or-private-at-a-glance): browsers need it over HTTPS |

Mailpit (1025, 8025) exists only in the development stack. Do not deploy it.

### 2.3 Who calls which service

Every application service listens on 8080. This is the complete list of callers, which tells you what each service's firewall must allow.

| Service (port 8080) | Called by | Over |
|---|---|---|
| identity-service | api-gateway (`/v1/auth`, `/v1/orgs`, and JWKS), org-service, pbx-config, trunk, callflow, voicemail, recording and cdr services (permission lookups) | HTTP |
| org-service | api-gateway (`/v1/public`, `/v1/resellers`, `/v1/tenants`, `/v1/session`, `/v1/platform/...`, certificates, ACME challenges), identity, pbx-config, trunk, telephony-config, cdr and notification services | HTTP |
| pbx-config-service | api-gateway, telephony-config, media-worker, voicemail-service, cdr-service | HTTP |
| trunk-service | api-gateway, pbx-config-service, telephony-config | HTTP |
| callflow-service | api-gateway, telephony-config | HTTP |
| voicemail-service | api-gateway, telephony-config, notification-service | HTTP |
| recording-service | api-gateway, telephony-config, **every recording-uploader** | HTTP |
| cdr-service | api-gateway, **every FreeSWITCH node** (`/ingest/json-cdr`) | HTTP |
| telephony-config | **every FreeSWITCH node** (`/fs/*`), trunk-service | HTTP |
| call-control | telephony-config | HTTP |
| media-worker | nobody (health checks only) | — |
| notification-service | nobody (health checks only) | — |

## 3. How traffic flows

### 3.1 A phone call

1. The phone registers to OpenSIPs (5060 UDP or TCP, or 5061 TLS) with its extension's credentials.
2. A call from the phone goes to OpenSIPs. OpenSIPs picks a FreeSWITCH node (round robin over its dispatcher list) and sends the INVITE to that node's SIP port, with the tenant in a header.
3. FreeSWITCH asks telephony-config `POST /fs/dialplan` (HTTP to 8080) what to do. The answer may bridge to another phone, ring a group, run an IVR flow or voicemail, join a queue or conference, or dial out.
4. To reach a phone or a carrier, FreeSWITCH sends the new leg **back through OpenSIPs** (to `OPENSIPS_SIP_URI`), and OpenSIPs delivers it.
5. **Audio never passes through OpenSIPs.** The SDP each side sees carries FreeSWITCH's own address and an RTP port from its range. Phones and carriers send RTP straight to that address, and FreeSWITCH sends RTP straight back.
6. When the call ends, FreeSWITCH posts the call record to cdr-service (`/ingest/json-cdr`). If it was recorded, the uploader moves the file to object storage.

### 3.2 An administrator or end user in the browser

1. The browser loads the console from the gateway (`https://console.<domain>/`) and signs in (`/v1/auth/*`).
2. Every API call goes to the gateway, which checks the access token and forwards the call to the right service with signed identity headers.
3. Listening to a recording or voicemail, downloading an export, or uploading a prompt or logo: the service returns a presigned URL (valid at most 5 minutes for downloads, 15 for uploads), and **the browser talks to object storage directly**.

### 3.3 Port 80 must share the SIP edge's address

Certificates are issued by Let's Encrypt with the HTTP-01 challenge only. For the SIP proxy name `sip.<domain>`, which resolves to OpenSIPs' public address, Let's Encrypt fetches `http://sip.<domain>/.well-known/acme-challenge/...`. That request must reach the api-gateway's port-80 listener, so **TCP 80 on OpenSIPs' public IP must lead to the gateway.** Either run the gateway on the same server as OpenSIPs (both deployment guides do), or forward port 80 of that address to the gateway.

### 3.4 Phone provisioning

Phones fetch `GET https://<gateway>/v1/public/provision/yealink/<mac>.cfg` with HTTP Basic credentials. The gateway refuses plain HTTP (403) unless `REQUIRE_HTTPS_FOR_PROVISIONING=false`. The configuration they receive points them at the tenant's SIP domain on 5060 or 5061, and, once the SIP proxy certificate is active, at `sip.<domain>` as outbound proxy. Only Yealink is supported, and it has **not been tried on real Yealink hardware**.

## 4. Media (RTP), and why FreeSWITCH needs a public address

There is no media relay (no RTPengine or rtpproxy; decision O-7, deferred). OpenSIPs forwards SDP untouched. So the address FreeSWITCH writes into its SDP for audio is where phones and carriers send RTP, and it has to be reachable from the internet.

By default that address is `local_ip_v4`: the IPv4 address of the interface that carries FreeSWITCH's default route. **`FS_EXTERNAL_RTP_IP` overrides it** for audio only. Signalling stays on the interface address, because only OpenSIPs talks SIP to FreeSWITCH (G-114).

| Where FreeSWITCH runs | What to set | Result |
|---|---|---|
| **Host networking on a server whose public IPv4 is configured on its network interface** (most bare-metal servers and VPS providers) | Nothing | SDP carries the public address. What both deployment guides use by default. |
| **Host networking behind 1:1 NAT**, where the public address is not on any interface (AWS EC2 and Lightsail, Google Cloud, Azure, most office routers) | `FS_EXTERNAL_RTP_IP=<public IPv4>`, and forward UDP 16384–32768 from the public address to the server (cloud providers do this for you once the security group allows it) | SDP carries the public address; FreeSWITCH binds to and signals on its private address. OpenSIPs must then reach the node on its **private** address: use that in `OPENSIPS_FS_DESTINATION` and set `FS_OPENSIPS_CIDR` to OpenSIPs' private address ([distributed §4.4](deploy-distributed.md#44-media-n)). |
| In a Docker bridge network (the development stack) | Nothing | SDP carries a private container address. Works only when phones and carriers are on the same Docker network (the SIP test suite). Not usable in production. |

`tests/sip/test/media_address.test.ts` checks on a real node that the advertised audio address follows `FS_EXTERNAL_RTP_IP` and that signalling does not move. That audio then really flows through a cloud provider's NAT has **not been verified** (no such network was available): confirm it with a test call on your first cloud deployment.

Consequences you have to plan for:

- **Open UDP 16384–32768 on every FreeSWITCH server to the whole internet.** Phones and carriers pick their own source addresses, so you cannot usefully restrict the source.
- The range allows about 8,000 simultaneous media streams per server (two ports per stream). You may narrow it with `FS_RTP_START_PORT` and `FS_RTP_END_PORT`; open exactly the range you configure.
- A FreeSWITCH server's public address appears in SDP. Signalling topology is hidden, media topology is not.
- Media is unencrypted (no SRTP).
- **Do not publish the RTP range through Docker's port mapping** (`-p 16384-32768:...`). Docker creates one proxy process and a set of NAT rules for every port. Use host networking.

## 5. Outbound connections

What each component must be allowed to open. Private-to-private connections are covered by §2. This table is what leaves your network.

| From | To | Port | Why | Required? |
|---|---|---|---|---|
| org-service | Let's Encrypt: `acme-v02.api.letsencrypt.org` (production) or `acme-staging-v02.api.letsencrypt.org` (staging), or `ACME_DIRECTORY_URL` | TCP 443 | Issue and renew certificates | Yes, for automatic certificates |
| org-service | Public DNS, through the server's normal resolver | UDP and TCP 53 | Check the `_domain-verification` TXT record when a reseller verifies a domain | Yes, for reseller domains |
| notification-service | Your SMTP relay (`SMTP_HOST`) | `SMTP_PORT` (587 by default, or 465 with `SMTP_SECURE=true`, or 25) | Every email | Yes |
| Services using storage, recording-uploader, FreeSWITCH | Object storage (`STORAGE_ENDPOINT`, or AWS S3 when unset) | TCP 443 (or your MinIO port) | Audio, images, exports | Yes |
| OpenSIPs | Carriers' SIP servers | Their SIP port (usually 5060 UDP or TCP) | Registration (for registration-based trunks) and outbound calls | Yes, if you use trunks |
| FreeSWITCH | Carriers' and phones' media addresses | Their RTP ports (any UDP) | Audio | Yes |
| OpenSIPs | Phones | Whatever address each phone registered | Incoming calls to the phone | Yes |
| Every server | NTP servers | UDP 123 | Clock sync ([README](README.md#four-rules-that-apply-to-every-deployment)) | Yes |
| Build hosts | Docker Hub, `gcr.io`, `deb.debian.org` and `snapshot.debian.org`, the npm registry (pnpm), and for the web console the Flutter SDK and packages (`storage.googleapis.com`, `pub.dev`) | TCP 443 | Building images and the console | At build time only; not needed by running servers if images are built elsewhere |

Carriers that authenticate you by IP address must allow **OpenSIPs' public address** (signalling) and **every FreeSWITCH server's public address** (media).

## 6. Security properties that decide placement

### 6.1 Keep backend service ports private

The eight services the gateway forwards to (identity, org, pbx-config, trunk, callflow, voicemail, recording and cdr) decide who is calling from the signed `x-internal-*` headers the gateway adds. A request that reaches one of them directly, with **no** signed headers, is refused (401 `authentication_required`) on every route except sign-in, the public routes and health checks, unless it presents `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`. The token marks a trusted machine caller: another service, or a tool of your own. This closed gap G-112 in [decisions](../decisions.md); before it, such a request was served for whatever tenant its URL named.

Keep the service ports private anyway, as defence in depth:

- Never publish any application service's port on a public interface.
- On a shared or multi-purpose network, restrict each service's port to the callers listed in [§2.3](#23-who-calls-which-service).
- Treat the private network between gateway, services and FreeSWITCH as part of the trusted core. Anything on it that learns a shared secret can reach tenant data.

The internal secrets are what protects the services now. `INTERNAL_SERVICE_TOKEN` (one shared token) opens every service's API as a machine caller and every service's `/internal/v1/*` routes, including one that returns TLS private keys. `INTERNAL_HEADER_SIGNING_SECRET` lets its holder sign as any person. `FS_XML_CURL_TOKEN` opens telephony-config's `/fs/*` routes. `FS_CDR_INGEST_TOKEN` lets a caller write call records.

### 6.2 Internal ports with no password

- **OpenSIPs MI (8888)**: no authentication, listens on every interface. Allow only telephony-config.
- **Redis (6379)**: must not require a password, because FreeSWITCH's Redis module cannot send one. Allow only the gateway, call-control, telephony-config, FreeSWITCH and OpenSIPs.
- **NATS (4222)**: no authentication unless you configure a NATS user and give every service `NATS_USER` and `NATS_PASSWORD`. NKeys are not supported (`NATS_NKEY_SEED` is accepted but ignored). The account needs permission to create and update streams.
- **FreeSWITCH ESL (8021)**: a password, plus one allowed CIDR.
- **MariaDB, Redis, NATS** connections carry no TLS, and the clients have no TLS options. Keep them on a private network. On untrusted links, use a VPN or WireGuard between servers.

### 6.3 Client addresses and X-Forwarded headers

The gateway takes the client's address from the connection itself, and ignores `X-Forwarded-For` and `X-Forwarded-Proto`, unless the connection comes from a proxy listed in `TRUSTED_PROXIES` ([configuration §4.1](configuration-reference.md#41-api-gateway)). The address it settles on is what the per-IP rate limit (300 requests per minute by default) counts, and it is signed into the identity headers it forwards, so services record it in audit events and sign-in sessions instead of the gateway's own address. Before G-113 in [decisions](../decisions.md) was fixed, the gateway believed these headers from any client, which let a client escape the per-IP rate limit, put a false address in the audit log, and claim HTTPS on the provisioning URL.

- **Gateway directly on 80 and 443** (what the deployment guides do, because the gateway serves the certificates org-service issues): leave `TRUSTED_PROXIES` empty.
- **Behind a reverse proxy or load balancer that terminates TLS** and overwrites `X-Forwarded-For` and `X-Forwarded-Proto`: list its addresses (or its subnet) in `TRUSTED_PROXIES`. Otherwise every client appears to come from the proxy, all of them share one per-IP rate limit, and phone provisioning is refused as plain HTTP. The proxy then needs its own certificates for every console hostname; the platform's automatic certificates are served by the gateway.
- **Behind a layer-4 balancer that passes TLS through**: it cannot set these headers. Leave `TRUSTED_PROXIES` empty; the gateway sees the balancer's address for every client, with the same shared rate limit, unless the balancer preserves the client's source address (transparent mode or direct server return).

Never list an address that ordinary clients can connect from: whatever it sends in `X-Forwarded-For` is believed.

### 6.4 SIP flood protection hits trusted peers too

OpenSIPs' `pike` module blocks any source that sends more than 30 SIP requests in 2 seconds, for 120 seconds. It has no allow list, so it counts FreeSWITCH nodes and carriers as well. A busy FreeSWITCH node (outbound legs plus OPTIONS replies) or a carrier delivering many calls at once can be blocked, which drops calls. Watch OpenSIPs' log for `pike: blocking flood from`. Raising the threshold means editing `opensips.cfg.template` (`reqs_density_per_unit`).

There is also a fixed limit of 10 new calls per second per tenant from phones (G-31), and FreeSWITCH accepts at most 30 new sessions per second and 1,000 in total per node (`switch.conf.xml`).

### 6.5 Phones behind NAT

OpenSIPs stores a registration with the contact address the phone sends. There is no `fix_nated_register` or received-address handling, and keep-alive pings are configured but never sent. **A phone behind NAT that puts its private address in its Contact header can place calls but may not receive them.** This is not verified. Before deploying phones behind NAT, test incoming calls. Enabling STUN on the phones, or putting phones on a VPN or on public addresses, avoids the problem. Prefer TCP or TLS: the phone keeps its connection open, but whether OpenSIPs reuses it for incoming calls is also not verified.

## 7. Docker networking rules that affect the firewall

- **Ports published by Docker bypass the host firewall.** Docker inserts its own `iptables`/`nftables` rules (the `DOCKER` chains) ahead of UFW's and firewalld's rules. A port published as `-p 3306:3306` is reachable from the internet even if UFW says deny. Publish internal ports only on `127.0.0.1` or on a private IP (`-p 127.0.0.1:3306:3306`, `-p 10.10.0.41:3306:3306`), or filter in the `DOCKER-USER` chain.
- **Host-networked containers** (FreeSWITCH and OpenSIPs in both guides) are filtered by the host's normal `INPUT` rules like any other process.
- A container reaching a host-networked service through `host.docker.internal` (mapped to `host-gateway`) arrives from its own container address. Allow the Docker network's subnet in the host firewall for those ports, and use that subnet in `FS_CLUSTER_CIDR`. Give the Docker network a fixed subnet so the rule stays valid.
- The development compose file publishes MariaDB, Redis, NATS, MinIO and Mailpit on every interface. **Do not use it on a server with a public address.**
