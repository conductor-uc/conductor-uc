# Scenario B: distributed deployment

Components spread over several servers: an edge, media servers, application servers and data servers, joined by a private network. Use this to separate what faces the internet from what holds data, to add media capacity, or to place media servers near users. Read [components](components.md), [network and firewall](network-and-firewall.md) and the [all-in-one guide](deploy-all-in-one.md) first: this guide reuses the all-in-one configuration and explains only what changes.

> **Status.** A reference built from the code, **not verified end to end on real servers.** In particular the platform has **no high availability**: distributing it adds capacity and separation, not redundancy. Every server except the media servers is a single point of failure ([§8](#8-what-happens-when-a-server-fails)).

## 1. Roles

| Role | Runs | Public address | Private address | Copies |
|---|---|---|---|---|
| **edge** | OpenSIPs (host network), api-gateway | **Yes**: TCP 80, 443; SIP 5060 UDP/TCP, 5061 TCP | Yes | **Exactly one.** OpenSIPs cannot be clustered, and port 80 must share OpenSIPs' address ([network §3.3](network-and-firewall.md#33-port-80-must-share-the-sip-edges-address)). |
| **media** | FreeSWITCH (host network), recording-uploader | **Yes**: UDP 16384–32768 open to all; SIP 5060 from the edge only. The public IPv4 must be on the server's interface ([network §4](network-and-firewall.md#4-media-rtp-and-why-freeswitch-needs-a-public-address)). | Yes | One or more, **but read [§7](#7-adding-and-removing-media-servers) before using more than one** |
| **app** | The twelve application services | **No** (outbound internet through NAT) | Yes | One. More only as described in [§6](#6-scaling-the-application-services). |
| **data** | MariaDB, Redis, NATS | **No** | Yes | One. No clustering is supported yet. |
| object storage | Hosted S3 (recommended), or MinIO on its own server | Reachable over HTTPS by browsers and media servers | — | Provider's concern |
| SMTP relay | Your mail provider | — | — | — |

You may combine roles on fewer servers, for example app and data together. Keep the edge and the media servers separate from the private roles: they face the internet.

## 2. Reference layout

```
                                   Internet
      TCP 80/443, SIP 5060/5061   │                  │ RTP 16384-32768/udp
   ┌──────────────────────────────▼───┐   ┌──────────▼──────────┐  ┌──────────────────────┐
   │ edge-1                            │   │ media-1              │  │ media-2              │
   │ public 203.0.113.10               │   │ public 203.0.113.21  │  │ public 203.0.113.22  │
   │ private 10.10.0.10                │   │ private 10.10.0.21   │  │ private 10.10.0.22   │
   │ OpenSIPs (host net)  api-gateway  │   │ FreeSWITCH  uploader │  │ FreeSWITCH  uploader │
   └─────────┬───────────────┬─────────┘   └──────┬───────────────┘  └──────┬───────────────┘
             │ SIP to media public IPs:5060 ◀─────┴──────────────────────────┘
   ═══════════╪═══════════════╪══════ private network 10.10.0.0/24 ═══════════════════════════
             │               │
   ┌─────────▼───────────────▼──────────────┐     ┌───────────────────────────────┐
   │ app-1   private 10.10.0.31              │     │ data-1  private 10.10.0.41     │
   │ identity :8101  org :8102  pbx :8103    │────▶│ MariaDB :3306                  │
   │ trunk :8104  callflow :8105             │     │ Redis   :6379                  │
   │ voicemail :8106  recording :8107        │     │ NATS    :4222                  │
   │ cdr :8108  telephony-config :8109       │     └───────────────────────────────┘
   │ call-control :8110  media-worker :8111  │
   │ notification :8112                      │──▶ NAT gateway ──▶ Let's Encrypt, SMTP, S3
   └─────────────────────────────────────────┘
```

Addresses used below:

| Server | Public | Private |
|---|---|---|
| edge-1 | 203.0.113.10 | 10.10.0.10 |
| media-1 | 203.0.113.21 | 10.10.0.21 |
| media-2 | 203.0.113.22 | 10.10.0.22 |
| app-1 | — | 10.10.0.31 |
| data-1 | — | 10.10.0.41 |
| your monitoring | — | 10.10.0.50 |
| your administrators | 198.51.100.0/24 | — |

Each application service is published on app-1's private address with its own port (8101–8112), so the edge and media servers can reach each one directly. Services on app-1 reach each other by name over app-1's Docker network.

## 3. The private network

- Every server needs a private address on one network, or on several routed networks.
- **Traffic on it is not encrypted**: MariaDB, Redis, NATS, the services' HTTP, FreeSWITCH's configuration requests (which carry `FS_XML_CURL_TOKEN`) and the event socket (which carries its password). Use a private network you trust: a cloud VPC, a dedicated VLAN, or WireGuard between the servers if they are in different places.
- The private network is also the **security boundary for tenant data** ([network §6.1](network-and-firewall.md#61-keep-backend-service-ports-private)). Keep other workloads off it, or filter every port as in §5.
- app-1 and data-1 need outbound internet access through NAT: app-1 for Let's Encrypt, SMTP and hosted S3; data-1 only for NTP and pulling images.
- Media servers talk to the edge over their **public** addresses for SIP (FreeSWITCH binds SIP only to the public address). Everything else between servers uses private addresses.

## 4. Configuration per role

Start from the all-in-one `.env` ([all-in-one §7.1](deploy-all-in-one.md#71-env)): every server gets the same file, with the same secrets. Add these lines:

```sh
# added to /opt/voice/.env on every server
EDGE_PUBLIC_IP=203.0.113.10
EDGE_PRIVATE_IP=10.10.0.10
APP_IP=10.10.0.31
DATA_IP=10.10.0.41
```

On each media server, also set its own values:

```sh
# media-1 only
NODE_ID=fs1
NODE_PUBLIC_IP=203.0.113.21
```

Copy the repository to each server as in [all-in-one §6](deploy-all-in-one.md#6-get-the-code-and-build), or build images once and push them to a private registry (recommended: set `image:` to your registry and drop `build:`). Only the edge needs the built web console.

Every compose file below uses the same `x-` anchors as the all-in-one file. Copy that block (from `x-service` through `x-urls`) to the top of each file, then change `x-urls` as shown for the app server.

### 4.1 data-1

```yaml
# /opt/voice/compose.yml on data-1
name: voice
# (x-service anchor from the all-in-one file)

networks:
  backplane:
    driver: bridge
    ipam: { config: [{ subnet: 172.30.0.0/24 }] }

volumes:
  mariadb-data:
  nats-data:

services:
  mariadb:
    # exactly as in the all-in-one file, except:
    ports: ['${DATA_IP}:3306:3306']

  redis:
    # as in the all-in-one file, except:
    ports: ['${DATA_IP}:6379:6379']

  nats:
    # as in the all-in-one file, except:
    ports: ['${DATA_IP}:4222:4222']
```

### 4.2 app-1

All twelve application services, as in the all-in-one file, with these differences:

1. Replace `x-urls` with the private addresses (services on app-1 could use names, but one set of URLs everywhere is simpler):

   ```yaml
   x-urls: &urls
     IDENTITY_SERVICE_URL: http://${APP_IP}:8101
     ORG_SERVICE_URL: http://${APP_IP}:8102
     PBX_CONFIG_SERVICE_URL: http://${APP_IP}:8103
     TRUNK_SERVICE_URL: http://${APP_IP}:8104
     CALLFLOW_SERVICE_URL: http://${APP_IP}:8105
     VOICEMAIL_SERVICE_URL: http://${APP_IP}:8106
     RECORDING_SERVICE_URL: http://${APP_IP}:8107
     CDR_SERVICE_URL: http://${APP_IP}:8108
     TELEPHONY_CONFIG_URL: http://${APP_IP}:8109
     CALL_CONTROL_URL: http://${APP_IP}:8110
   ```

2. Point the data settings at data-1: in `x-db`, `DB_HOST: ${DATA_IP}`; in `x-nats`, `NATS_SERVERS: nats://${DATA_IP}:4222`; and every `REDIS_URL: redis://${DATA_IP}:6379`.
3. Remove every `depends_on` entry that names `mariadb`, `redis` or `nats` (they are on another server). The services restart until data-1 is reachable.
4. Publish each service on the private address:

   | Service | `ports:` |
   |---|---|
   | identity-service | `['${APP_IP}:8101:8080']` |
   | org-service | `['${APP_IP}:8102:8080']` |
   | pbx-config-service | `['${APP_IP}:8103:8080']` |
   | trunk-service | `['${APP_IP}:8104:8080']` |
   | callflow-service | `['${APP_IP}:8105:8080']` |
   | voicemail-service | `['${APP_IP}:8106:8080']` |
   | recording-service | `['${APP_IP}:8107:8080']` |
   | cdr-service | `['${APP_IP}:8108:8080']` (replaces `127.0.0.1:18081`) |
   | telephony-config | `['${APP_IP}:8109:8080']` (replaces `127.0.0.1:18080`) |
   | call-control | `['${APP_IP}:8110:8080']` |
   | media-worker | `['${APP_IP}:8111:8080']` (health checks only) |
   | notification-service | `['${APP_IP}:8112:8080']` (health checks only) |

5. telephony-config:

   ```yaml
       environment:
         # ... as in the all-in-one file, but:
         OPENSIPS_DB_HOST: ${DATA_IP}
         OPENSIPS_MI_URL: http://${EDGE_PRIVATE_IP}:8888/mi
         OPENSIPS_SIP_URI: ${EDGE_PUBLIC_IP}:5060
         SELF_URL: http://${APP_IP}:8109          # as the media servers reach it
   ```

   Remove its `extra_hosts` entry.

6. call-control: list every media server by its **private** address (the event socket listens on every interface), and remove `extra_hosts`:

   ```yaml
         FS_NODES: fs1:10.10.0.21:8021,fs2:10.10.0.22:8021
   ```

7. Remove `opensips`, `freeswitch`, `recording-uploader`, `api-gateway`, and the data services from this file.

### 4.3 edge-1

```yaml
# /opt/voice/compose.yml on edge-1
name: voice
# (x-service, x-healthcheck and x-common anchors from the all-in-one file,
#  and x-urls from the app-1 section above)

networks:
  backplane:
    driver: bridge
    ipam: { config: [{ subnet: 172.30.0.0/24 }] }

services:
  api-gateway:
    # as in the all-in-one file, except:
    depends_on: {}                           # identity, org, redis are elsewhere
    environment:
      # ... as in the all-in-one file, but:
      REDIS_URL: redis://${DATA_IP}:6379

  opensips:
    # as in the all-in-one file (network_mode: host), except:
    depends_on: {}
    environment:
      # ... as in the all-in-one file, but:
      OPENSIPS_DB_URL: mysql://opensips:${OPENSIPS_DB_PASSWORD}@${DATA_IP}:3306/opensips
      OPENSIPS_REDIS_URL: redis:cuc://${DATA_IP}:6379/0
      OPENSIPS_FS_DESTINATION: sip:203.0.113.21:5060,sip:203.0.113.22:5060
```

The gateway's `*_SERVICE_URL` values come from `x-urls` (app-1's private addresses). It still needs `./src/apps/console/build/web` and `./bootstrap-tls` on this server.

### 4.4 media-N

```yaml
# /opt/voice/compose.yml on media-1 (and media-2 with its own .env values)
name: voice
# (x-service anchor from the all-in-one file)

networks:
  backplane:
    driver: bridge
    ipam: { config: [{ subnet: 172.30.0.0/24 }] }

volumes:
  recording-spool:
    driver: local
    driver_opts: { type: tmpfs, device: tmpfs, o: 'size=2g,mode=0777' }

services:
  freeswitch:
    # as in the all-in-one file (network_mode: host), except:
    depends_on: {}
    environment:
      FS_NODE_ID: ${NODE_ID}                        # fs1, fs2, ...
      FS_SIP_PORT: '5060'                           # nothing else holds 5060 here
      FS_OPENSIPS_CIDR: ${EDGE_PUBLIC_IP}/32        # OpenSIPs sends from its public address
      FS_CLUSTER_CIDR: ${APP_IP}/32                 # call-control
      FS_EVENT_SOCKET_PASSWORD: ${FS_EVENT_SOCKET_PASSWORD}
      TELEPHONY_CONFIG_URL: http://${APP_IP}:8109   # equals telephony-config's SELF_URL
      FS_XML_CURL_TOKEN: ${FS_XML_CURL_TOKEN}
      CDR_SERVICE_URL: http://${APP_IP}:8108
      FS_CDR_INGEST_TOKEN: ${FS_CDR_INGEST_TOKEN}
      FS_REDIS_HOST: ${DATA_IP}
      FS_REDIS_PORT: '6379'
      FS_RTP_START_PORT: '16384'
      FS_RTP_END_PORT: '32768'
      FS_SIP_IDENTITY: SIP Media Server
      FS_SDP_IDENTITY: SIP-Media-Server
      FS_LOG_LEVEL: info

  recording-uploader:
    <<: *service
    image: voice/recording-service:${RELEASE}
    command: ['dist/src/uploader/main.js']
    volumes: ['recording-spool:/var/spool/cuc/rec']
    ports: ['${NODE_PRIVATE_IP}:9464:9464']         # metrics, for your monitoring
    environment:
      SERVICE_NAME: recording-uploader-${NODE_ID}
      RECORDING_SERVICE_URL: http://${APP_IP}:8107
      INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN}
      SPOOL_DIR: /var/spool/cuc/rec
```

Add `NODE_PRIVATE_IP=10.10.0.21` (for media-1) to that server's `.env`.

How the addresses fit together on a media server:

- OpenSIPs sends to `203.0.113.21:5060` from `203.0.113.10`. That is why `FS_OPENSIPS_CIDR` is the edge's public address and the firewall allows 5060 from it.
- FreeSWITCH sends its outbound legs to `OPENSIPS_SIP_URI` (`203.0.113.10:5060`) from `203.0.113.21:5060`. That is exactly its entry in `OPENSIPS_FS_DESTINATION`, which is how OpenSIPs recognises it.
- call-control connects to `10.10.0.21:8021` from app-1's private address, which is what `FS_CLUSTER_CIDR` allows.
- The node and its uploader reach object storage over the internet (voicemail uploads, recordings).

## 5. Firewall rules per server

Use your cloud provider's security groups or host firewalls. The rules below are the complete inbound policy. Default: deny inbound, allow outbound. Where Docker publishes a port on a private address, host firewalls such as UFW do not see the traffic ([network §7](network-and-firewall.md#7-docker-networking-rules-that-affect-the-firewall)). Enforce those rules in security groups, or in the `DOCKER-USER` chain (example after the tables).

### edge-1 (203.0.113.10, 10.10.0.10)

| Port | Protocol | From | Why |
|---|---|---|---|
| 80, 443 | TCP | anywhere | Console, API, provisioning, ACME |
| 5060 | UDP, TCP | anywhere | SIP (phones, carriers) and media servers |
| 5061 | TCP | anywhere | SIP over TLS |
| 8888 | TCP | 10.10.0.31 | OpenSIPs MI, telephony-config only (**no authentication**) |
| 22 | TCP | 198.51.100.0/24 | Administration |

### media-N (203.0.113.2x, 10.10.0.2x)

| Port | Protocol | From | Why |
|---|---|---|---|
| 16384–32768 | UDP | anywhere | RTP |
| 5060 | UDP, TCP | 203.0.113.10 only | SIP from OpenSIPs |
| 8021 | TCP | 10.10.0.31 | Event socket (call-control) |
| 9464 | TCP | 10.10.0.50 | Uploader metrics |
| 22 | TCP | 198.51.100.0/24 | Administration |

### app-1 (10.10.0.31)

| Port | Protocol | From | Why |
|---|---|---|---|
| 8101–8107, 8110 | TCP | 10.10.0.10 (gateway) and 10.10.0.50 (monitoring) | API services; call-control only for monitoring |
| 8107 | TCP | 10.10.0.21, 10.10.0.22 | recording-service, from the uploaders |
| 8108 | TCP | 10.10.0.10, 10.10.0.21, 10.10.0.22, 10.10.0.50 | cdr-service: gateway, and CDRs from FreeSWITCH |
| 8109 | TCP | 10.10.0.21, 10.10.0.22, 10.10.0.50 | telephony-config: FreeSWITCH configuration |
| 8111, 8112 | TCP | 10.10.0.50 | Health checks only |
| 22 | TCP | 198.51.100.0/24 | Administration |

Services on app-1 call each other through its own Docker network, so the table only lists callers from other servers. The gateway calls identity-service (8101) and org-service (8102) for more than proxying (tokens, certificates, ACME), which the 8101–8107 rule covers. It does not call call-control; that port is open to monitoring only.

### data-1 (10.10.0.41)

| Port | Protocol | From | Why |
|---|---|---|---|
| 3306 | TCP | 10.10.0.31 (services), 10.10.0.10 (OpenSIPs) | MariaDB |
| 6379 | TCP | 10.10.0.10 (gateway, OpenSIPs), 10.10.0.31 (call-control, telephony-config), 10.10.0.21, 10.10.0.22 (FreeSWITCH) | Redis (**no authentication**) |
| 4222 | TCP | 10.10.0.31 | NATS |
| 8222 | TCP | 10.10.0.50 | NATS monitoring (publish it only if you use it) |
| 22 | TCP | 198.51.100.0/24 | Administration |

### Filtering Docker-published ports (example for data-1)

```sh
# Allow the listed sources, drop everything else that Docker would forward to
# the published MariaDB, Redis and NATS ports. Rules in DOCKER-USER survive
# container restarts but not reboots: persist them with your distribution's
# iptables-persistent / nftables service.
for src in 10.10.0.31 10.10.0.10; do
  sudo iptables -I DOCKER-USER -p tcp -s "$src" --dport 3306 -j RETURN
done
for src in 10.10.0.10 10.10.0.31 10.10.0.21 10.10.0.22; do
  sudo iptables -I DOCKER-USER -p tcp -s "$src" --dport 6379 -j RETURN
done
sudo iptables -I DOCKER-USER -p tcp -s 10.10.0.31 --dport 4222 -j RETURN
sudo iptables -A DOCKER-USER -p tcp -m multiport --dports 3306,6379,4222 -j DROP
```

`DOCKER-USER` sees destination ports after Docker's address translation, which here are the container ports (3306, 6379, 4222). On app-1 they are all 8080 inside the containers, so filter by published port with `-m conntrack --ctorigdstport 8101` instead, or rely on security groups.

## 6. Scaling the application services

Safe to run in several copies: api-gateway, identity, org, pbx-config, trunk, callflow, voicemail, cdr, media-worker and notification services. recording-service and telephony-config also work, but repeat their background work ([components §6](components.md#6-running-more-than-one-copy)). **Never run more than one call-control.**

The URL settings (`*_SERVICE_URL`, `TELEPHONY_CONFIG_URL`, and so on) each name one address. To run several copies of a service across app servers, put a private load balancer in front of them and point the URL at it. HAProxy example for pbx-config-service on two app servers:

```
frontend pbx_config
    bind 10.10.0.30:8103
    default_backend pbx_config
backend pbx_config
    option httpchk GET /readyz
    server app1 10.10.0.31:8103 check
    server app2 10.10.0.32:8103 check
```

That load balancer is itself a single point of failure unless you make it redundant (keepalived and a floating address). The platform does not provide one. Scale the gateway the same way on the edge, behind a layer-4 balancer that passes TLS through. A layer-4 balancer cannot set `X-Forwarded-For`, so the gateway sees the balancer's address for every client ([network §6.3](network-and-firewall.md#63-client-addresses-and-x-forwarded-headers)). A balancer that terminates TLS and sets the header must be listed in `TRUSTED_PROXIES`.

Database connections grow with copies: each copy of each service opens up to `DB_POOL_SIZE` (10) connections. Raise MariaDB's `max_connections` accordingly.

## 7. Adding and removing media servers

**The limitation first.** OpenSIPs spreads calls over media servers round robin. Queues, parking lots and conference rooms live in one node's memory while in use, and call-control pins each to a node with a lease. But OpenSIPs does not yet send a call to the node holding the lease (G-46, plan task S4-05). With two or more media servers, a caller joining a queue, a parking slot or a conference that is active on another node can fail. Plain calls, ring groups, IVR flows and voicemail are not affected. If your tenants use queues, parking or conferences, run **one** media server until S4-05 is built.

To add media server N:

1. Prepare the server as in §4.4 with a new `NODE_ID` (`fs3`), its public and private address, and firewall rules (§5).
2. Start `freeswitch` and `recording-uploader` on it.
3. On app-1, add `fs3:<private ip>:8021` to call-control's `FS_NODES` and restart call-control (the list is read only at startup; live-call tracking restarts too).
4. On edge-1, add `sip:<public ip>:5060` to `OPENSIPS_FS_DESTINATION` and restart OpenSIPs. OpenSIPs reads the list only at start, and replaces its dispatcher table with it. **Restarting OpenSIPs drops calls being set up and loses its dialog state.** Do it in a quiet period. Registrations are stored in MariaDB (`db_mode` 2) and survive.
5. Allow the new server's addresses in the firewalls of app-1 (8107, 8108, 8109) and data-1 (6379).

To remove one: take it out of `OPENSIPS_FS_DESTINATION` and restart OpenSIPs, wait for its calls to end (`fs_cli -x 'show calls count'`), let its uploader empty the spool (`ls /var/spool/cuc/rec`), then remove it from `FS_NODES` and restart call-control. There is no draining mode: every node has weight 1 (plan task S4-02).

## 8. What happens when a server fails

| Server lost | Effect | Recovery |
|---|---|---|
| edge-1 | **All calls and the console stop.** Phones cannot register or call. | Restore or rebuild it. Nothing on it is durable: its state is in MariaDB. |
| One media server | Its calls drop, and its recordings not yet uploaded are lost (O-13, accepted). OpenSIPs stops sending new calls to it once its OPTIONS probe (every 10 seconds) goes unanswered, so within tens of seconds; calls routed to it before then fail. call-control marks it down. **Its call records are not written** (synthetic CDRs are S4-04, not built). | Other nodes carry new calls. Restart it; it rejoins without configuration changes. |
| app-1 | New calls fail, because FreeSWITCH asks telephony-config for every call. Established calls stay up, but anything in them that needs telephony-config (a transfer, an IVR step, voicemail) fails. The console and API stop. | Restart. Services reconnect and catch up on events from NATS. |
| data-1 | Everything stops: services cannot reach MariaDB, and OpenSIPs cannot authenticate. | Restore MariaDB from backup ([operations §4](operations.md#4-backups-and-restore)). Redis needs no restore. |
| object storage | Recording and voicemail playback, prompt uploads and exports fail. Recordings wait on the media servers' spool and upload later. Voicemail messages lose their audio (FreeSWITCH is meant to upload them directly; that upload is broken anyway until S5-16). Calls otherwise work: FreeSWITCH caches prompts. | Provider's concern. |
| SMTP relay | Emails fail. Nothing else is affected. | — |

## 9. Checklist before going live

Everything in [all-in-one §10](deploy-all-in-one.md#10-verify), plus:

- From outside, only the ports in §5 answer on each public address, and nothing answers on app-1 or data-1.
- A call placed through each media server has two-way audio. Call repeatedly: calls alternate between nodes. `fs_cli -x 'show calls'` on each node shows them.
- `docker compose logs call-control` on app-1 shows a connection to every node.
- On each media server, `fs_cli -x 'sofia status profile internal'` shows that server's public address for `SIP-IP` and `EXT-RTP-IP`.
- Stop one media server during a test call to see the failure behaviour in §8, before your users do.
