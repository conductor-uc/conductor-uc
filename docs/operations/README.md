# Operations and deployment guide

This folder is for **system administrators** who install and run the platform. The rest of `docs/` is about why it is designed the way it is. This folder says what to install, where, and which ports to open.

Everything here was written from the code, the container images and `infra/compose/docker-compose.yml` as they are on `main` (2026-09-25), not from the design docs. Where the code and the design docs disagree, this folder follows the code and says so.

## Documents

| # | Document | Read it when |
|---|---|---|
| 1 | [Components](components.md) | First. What every process does, what it stores, what it talks to, and whether it can run more than one copy. |
| 2 | [Network and firewall](network-and-firewall.md) | Before you choose servers or IP addresses. Every port, which side opens it, and which components need a public address. |
| 3 | [Configuration reference](configuration-reference.md) | While writing environment files. Every variable for every component, plus how to generate each secret. |
| 4 | [DNS, TLS and certificates](dns-tls-and-certificates.md) | Before you point DNS at the platform. Hostnames, records, and how certificates are issued and loaded. |
| 5 | [All-in-one deployment](deploy-all-in-one.md) | Scenario A: every component on one server. |
| 6 | [Distributed deployment](deploy-distributed.md) | Scenario B: components spread over several servers. |
| 7 | [Day-2 operations](operations.md) | After install. First administrator, upgrades, backups and restore, monitoring, logs, secret rotation, troubleshooting. |

## Before you start: what state the platform is in

Read this section before you plan a production deployment. It is short on purpose. Each item is explained in the document it links to.

### What exists

- Every service builds into a container image from its `Dockerfile` (13 Node.js services, FreeSWITCH, OpenSIPs).
- `infra/compose/docker-compose.yml` runs the whole platform on one machine. It is a **development** stack: development passwords, a development encryption key, no TLS on the web edge, a mail catcher instead of a mail relay, and ports that suit a laptop.
- Services create and upgrade their own database tables when they start.

### What does not exist yet

- **No production deployment files.** `infra/deploy/` is empty (plan task S4-11). The two deployment guides in this folder give reference configurations built from the development stack. They follow the code exactly, but **they have not been run end to end on real servers.** Treat the first installation as a pilot and test each step.
- **No high availability.** There is one OpenSIPs, one MariaDB, one Redis and one NATS, with no clustering, no failover and no floating IP (plan stage S4). `call-control` must run as exactly one copy. A second FreeSWITCH node works for plain calls but not reliably for queues, parking lots and conferences ([components §6](components.md#6-running-more-than-one-copy)).
- **No media relay.** Audio flows directly between phones or carriers and the FreeSWITCH servers. Every FreeSWITCH server needs a public IP address with its RTP port range open to the internet ([network §4](network-and-firewall.md#4-media-rtp-and-why-freeswitch-needs-a-public-address)).
- **No backup or restore tooling**, no metrics except on the recording uploader, and no tracing. [Day-2 operations](operations.md) says what to back up by hand and what to watch.
- **No key management service.** The master encryption key is an environment variable (`CRYPTO_KEKS`). Losing it makes stored secrets and the login signing keys unreadable ([configuration §3.5](configuration-reference.md#35-crypto_keks-the-master-encryption-key)).

### Four rules that apply to every deployment

1. **Only three things face the internet:** the API gateway (TCP 80 and 443), OpenSIPs (SIP on UDP and TCP 5060, TLS on TCP 5061), and the FreeSWITCH media ports (UDP 16384–32768). Object storage must also be reachable by browsers, over HTTPS. Nothing else may be reachable from outside.
2. **The backend services trust their network.** A request that reaches a service's port directly, without going through the gateway, is not asked to log in. It can read and change any tenant's data ([network §6.1](network-and-firewall.md#61-backend-services-trust-the-network)). Keeping service ports private is the security boundary, not a precaution.
3. **Several internal ports have no password at all:** the OpenSIPs management interface (TCP 8888), Redis (6379) and, as configured by the development stack, NATS (4222). A firewall must restrict them.
4. **Every server's clock must be synchronised** (NTP or chrony). The gateway signs each request it forwards, and services reject signatures more than 60 seconds old.

## Conventions in this folder

- Commands assume a Linux host with Docker Engine 24 or later and the Docker Compose v2 plugin. The platform does not depend on Docker. It needs the images and the variables described here, whatever runs them.
- Example values: platform domain `voice.example.net`, public IP `203.0.113.10` (from the documentation range), private network `10.10.0.0/24`. Replace them with your own.
- **Public** means reachable from the internet. **Private** means reachable only on a network you control (a VPC, a VLAN, a host-only Docker network or the loopback interface).
- "Verified" means the behaviour was observed on a running system (usually the live SIP test suite). Anything that was not observed is marked **not verified**.
- File references such as `services/api-gateway/src/config.ts` are relative to the repository root.
