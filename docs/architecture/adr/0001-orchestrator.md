# ADR 0001: Container orchestration

**Status:** Accepted by the owner, 2026-09-25 ([decisions.md O-1](../../decisions.md#2-open-questions)). Written up in S4-01.

## Context

The platform runs as containers: twelve Node.js services, api-gateway, OpenSIPs, FreeSWITCH, a recording uploader per media server, and the data stores (MariaDB, Redis, NATS; object storage is hosted). Something has to place them on servers, restart them, and upgrade them.

The telephony tier constrains the choice more than anything else:

- **FreeSWITCH needs a wide UDP port range and its real addresses.** Every media server receives RTP on UDP 16384–32768 on a public address that must be on the host's interface, because FreeSWITCH writes it into SDP ([network §4](../../operations/network-and-firewall.md#4-media-rtp-and-why-freeswitch-needs-a-public-address)). Publishing 16,000 ports through a container network, or through a Kubernetes Service, is either impossible or pathologically slow, and NAT in front of RTP breaks media. FreeSWITCH therefore runs with host networking.
- **OpenSIPs is the SIP edge and needs real source addresses.** It authenticates trunks by source IP (`permissions`), rate-limits by source (`pike`), and must see the client's address and port for NAT traversal and registrations. It also runs with host networking.
- **Neither is a stateless web workload.** A FreeSWITCH node holds live calls and pinned resources (queues, parks, conferences) and must be drained, not killed, to be replaced ([04 §6](../04-high-availability.md#6-rolling-upgrades)). OpenSIPs holds dialogs and registrations in memory.

The application tier is the opposite: stateless HTTP services configured entirely by environment variables, logging to stdout, with `/healthz` and `/readyz`. They fit any orchestrator.

Operations capacity matters too: a small team, hosts that may be cloud VMs or bare metal, and a first production deployment that must be understandable end to end.

## Decision

1. **Now: Docker Compose, one project per server.** Each server has a role (edge, media, app, data; [10 §2](../10-production-topology.md#2-server-roles)) and runs that role's Compose file. The role-based files in [`deploy-distributed.md`](../../operations/deploy-distributed.md) become the tested production manifests of S4-11, built from the published images of O-5.
2. **Telephony servers stay on dedicated VMs with Compose and host networking permanently.** Edge (OpenSIPs) and media (FreeSWITCH, uploader) never move to Kubernetes.
3. **Later: the application tier moves to Kubernetes**, a managed offering where possible, alongside the S4 high-availability work or once placing application containers by hand becomes a burden. The data tier may follow or move to managed services; that is decided then.
4. **Nomad is not considered further.**
5. **Services stay orchestrator-neutral**: configuration by environment only, logs to stdout, health endpoints, no reliance on a specific service-discovery mechanism (every upstream is a URL setting). This is what keeps the later move cheap.

## Alternatives considered

- **Kubernetes for everything, now.** Rejected for the telephony tier on the grounds above: host networking with large UDP ranges, real source addresses, and drain-before-stop lifecycles fight Kubernetes' networking and scheduling model, and running FreeSWITCH/OpenSIPs there anyway (host-network pods pinned to nodes) gains little over Compose while adding a control plane. Deferred, not rejected, for the application tier.
- **Nomad.** Handles host networking and mixed workloads better than Kubernetes, but it is one more system to operate with a smaller ecosystem, and it offers the application tier nothing a managed Kubernetes will not. Dropped.
- **systemd units on bare hosts, no containers.** Simplest runtime, but loses image-based releases, reproducible builds and the path to Kubernetes for the application tier.
- **Docker Swarm.** Its overlay networking has the same problems for RTP, and its future is uncertain.

## Consequences

- **High availability is built from Compose-level pieces**, not from an orchestrator's rescheduling: redundant copies on separate servers, health-checked load balancers and floating addresses in front of them, and clustering in the data stores themselves. [10-production-topology.md](../10-production-topology.md) lays this out; S4-02 to S4-08 build it.
- **A server's role is fixed at provisioning.** Adding capacity means adding a server of that role and registering it (media: dispatcher and `FS_NODES`; app: the load balancer pool). Nothing moves on its own.
- **Restarts are local** (`restart: unless-stopped`, health checks); a dead server is replaced by rebuilding it from its role's files. Configuration and secrets live in each server's `.env`; secrets management beyond that (a vault, or Kubernetes secrets) comes with the Kubernetes move or O-5.
- **Every upstream address must be stable across a failure**, since there is no platform service discovery: each service URL, the database, Redis and NATS are reached through a load balancer, a floating address or a client that knows every member ([10 §4](../10-production-topology.md#41-stable-endpoints)).
- **Moving the application tier to Kubernetes later** means: publishing the same images, turning each app service's Compose entry into a Deployment with the same environment, pointing edge and media servers at the cluster's internal load balancers for telephony-config, call-control and cdr/recording/voicemail, and keeping call-control's one-controller-per-node rule (S4-03) as a lease, not a Kubernetes singleton.
