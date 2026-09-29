# infra/deploy

The production deployment files (plan task S4-11): one Compose file per server role, for the highly available layout of [10-production-topology.md](../../docs/architecture/10-production-topology.md) and [ADR 0001](../../docs/architecture/adr/0001-orchestrator.md) (Compose per server). They are rehearsed end to end by [`rehearsal/rehearse.sh`](rehearsal/rehearse.sh) (below).

| Role | Servers | Runs | Directory |
|---|---|---|---|
| **edge** | 2 | OpenSIPs with the floating addresses (keepalived) and the media relay (RTPengine); api-gateway | [`edge/`](edge/compose.yml) |
| **app** | 2 | The twelve services; the internal load balancer (HAProxy with keepalived) that every client reaches the services, the MariaDB writer and the Redis primary through | [`app/`](app/compose.yml) |
| **data** | 3 | A Galera member, a Redis member with its sentinel, a NATS member; Prometheus on data-1 | [`data/`](data/compose.yml) |
| **media** | as many as the calls need | FreeSWITCH, the recording uploader | [`media/`](media/compose.yml) |

Images are the released ones: `${IMAGE_REGISTRY}/<image>:${RELEASE}`, `ghcr.io/conductor-uc` and a version tag by default, published by the release workflow (`.github/workflows/release.yml`, O-5) when a `vX.Y.Z` tag is pushed. The gateway image carries the console.

## Addresses

Every server is on one private network. Four floating addresses move between the members of a pair:

| Setting | Held by | Used by |
|---|---|---|
| `EDGE_VIP` | the active edge | phones, carriers and browsers (SIP, RTP, HTTPS); the media servers' SIP |
| `EDGE_MEDIA_VIP` | the active edge | the media servers' RTP to the edge's relay (private) |
| `APP_VIP` | the active app server's load balancer | every service URL, the MariaDB writer, the Redis primary |

Each app server's load balancer also listens on that server's own address, and that server's own services use it: they never depend on the other app server's balancer, so losing one app server cannot leave the other's connections hanging on it. The services themselves listen on 9101–9112; the balancers on 8101–8112, 3306 and 6379.

`EDGE_VIP` is public in a real deployment. Where the provider does not allow VRRP, use its floating IP instead and set `EDGE_PUBLIC_ADDRESS` in the edges' `.env` when that address is NATed onto the host (deploy-distributed §4.3.1 has the hook to run on failover).

## Settings

- **`platform.env`**: copy [`platform.env.example`](platform.env.example) to `/opt/voice/platform.env` on **every** server, identical, and fill it in. It holds the addresses, the release, and every secret; keep it readable by root only.
- **`.env`** beside the role's `compose.yml`: this server's identity only.

| Server | `.env` |
|---|---|
| edge-1 | `SELF_IP=<its address>` `EDGE_NODE_ID=1` `EDGE_PEER_NODE_ID=2` `EDGE_PEER_IP=<edge-2>` `EDGE_SEED=true` `EDGE_PRIORITY=110` |
| edge-2 | `SELF_IP=<its address>` `EDGE_NODE_ID=2` `EDGE_PEER_NODE_ID=1` `EDGE_PEER_IP=<edge-1>` `EDGE_SEED=false` `EDGE_PRIORITY=100` |
| app-1 | `SELF_IP=<its address>` `APP_PEER_IP=<app-2>` `LB_PRIORITY=110` |
| app-2 | `SELF_IP=<its address>` `APP_PEER_IP=<app-1>` `LB_PRIORITY=100` |
| data-1 | `SELF_IP=<its address>` `DATA_NODE_NAME=data-1` `GALERA_BOOTSTRAP=true` |
| data-2, data-3 | `SELF_IP=<its address>` `DATA_NODE_NAME=data-2` (`data-3`) |
| media-N | `SELF_IP=<its address>` `MEDIA_NODE_ID=fs1` (its id in `MEDIA_DISPATCHER` and `MEDIA_EVENT_SOCKETS`) |

Each server then runs, from its role's directory:

```sh
docker compose --env-file ../platform.env --env-file .env up -d
```

(data-1 adds `--profile prometheus`; edit [`data/prometheus.yml`](data/prometheus.yml) to your addresses first.)

## Before the first start

- **Host settings.** Edges and app servers listen on floating addresses they may not hold: `sysctl -w net.ipv4.ip_nonlocal_bind=1` (and in `/etc/sysctl.d/`). Their containers need `NET_ADMIN`, which the files grant.
- **Edge certificates.** Put a certificate for the console's name in `edge/bootstrap-tls/` (`fullchain.pem`, `privkey.pem`), readable by the gateway's non-root user. The platform issues its own later ([DNS, TLS and certificates](../../docs/operations/dns-tls-and-certificates.md)).
- **Firewall**: [deploy-distributed §5](../../docs/operations/deploy-distributed.md#5-firewall-rules-per-server) and [network and firewall](../../docs/operations/network-and-firewall.md). Between the pairs: VRRP (IP protocol 112); between the edges: 5566/tcp (replication); between data servers: 4567, 4568, 4444 (Galera), 6222 (NATS routes), 26379 (sentinels).

## Order

1. **data-1**, then data-2 and data-3. data-1 starts the Galera cluster (and creates every service's schema and user); the others join and copy it. Wait until `galera` is healthy on all three.
2. **app-1** and **app-2**. Services wait for their database; each becomes healthy once it can reach it, NATS and Redis through `APP_VIP`.
3. **media servers.**
4. **edge-1** and **edge-2**.
5. Bootstrap the platform: [deploy-all-in-one §9](../../docs/operations/deploy-all-in-one.md#9-bootstrap-the-platform), run against an app server.

## Operating

- **Losing a server.** Any one edge, app or data server can fail: the pair's other member takes its floating address (edges and app servers, seconds), Galera moves the writer and Sentinel the Redis primary (seconds), NATS keeps every stream on the other two. Established calls stay up through an edge or app server loss. What each costs is in [04 §4](../../docs/architecture/04-high-availability.md#4-failover-sequence) (S4-08's measurements).
- **Restarting the whole data tier.** Galera will not start a new cluster from a data directory unless it is sure that member has every write. Start the member that stopped last first; if none is marked safe (`/var/lib/mysql/grastate.dat`, `safe_to_bootstrap: 1`), pick the one with the highest `seqno` and start it once with `GALERA_FORCE_BOOTSTRAP=true`.
- **Adding a media server**: add it to `MEDIA_DISPATCHER` and `MEDIA_EVENT_SOCKETS` in every `platform.env`, start it, then restart `opensips` on both edges and `call-control` on both app servers.
- **Upgrading**: set `RELEASE` in `platform.env` everywhere, then one server at a time: `docker compose pull && docker compose up -d`. Drain a media server first ([04 §6](../../docs/architecture/04-high-availability.md#6-rolling-upgrades)); upgrade the backup member of each pair before the active one.

## The rehearsal

[`rehearsal/rehearse.sh`](rehearsal/rehearse.sh) runs every role's file, unchanged, on eight Docker-in-Docker "servers" on one private network (2 edge, 2 app, 3 data, 1 media), with a local registry for the images, MinIO for object storage and Mailpit for email. `images` builds and pushes the images at the current commit, `up` deploys the roles in order, `test` runs `tests/sip/rehearsal` (a call through the edge's floating address; then a whole edge, app and data server killed in turn, a call after each), `down` removes the servers and `purge` everything, the registry included. It needs about 20 GB of disk and 8 GB of memory.
