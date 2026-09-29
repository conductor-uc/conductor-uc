# infra/data-ha

The highly available data tier (plan task S4-07; [10 §4](../../docs/architecture/10-production-topology.md#4-components-how-each-survives-and-the-address-clients-use), D-016, D-017), as its own compose project so it can be run and failed over apart from the everyday dev stack, which keeps one server of each.

| Part | Members | Survives | Services reach it at |
|---|---|---|---|
| MariaDB | Galera, 3 | One member lost; writes move to another in about 6 s | HAProxy `:13306` (one writer at a time) |
| Redis | 1 primary, 2 replicas, 3 sentinels | The primary lost; a replica is promoted in about 8 s | HAProxy `:16379` (whichever says `role:master`) |
| NATS | 3, JetStream on each | One member lost; streams keep 3 copies | `:14222`, `:14223`, `:14224` (all three) |

```sh
docker compose -f infra/data-ha/compose.yml up -d --build
REQUIRE_DATA_HA_TESTS=1 pnpm --filter @cuc/tests-data-ha test   # kills each part's leader in turn
docker compose -f infra/data-ha/compose.yml down -v
```

A service uses it with `DB_HOST`/`DB_PORT` and `REDIS_URL` pointing at HAProxy, `NATS_SERVERS` listing the three members, and `NATS_STREAM_REPLICAS=3`.

Operating notes:

- **Galera start.** A member joins when any peer answers. `galera-1` (`GALERA_BOOTSTRAP=true`) starts a new cluster only on an empty data directory. After every member has stopped, start the one with the latest writes first with `GALERA_FORCE_BOOTSTRAP=true` (see MariaDB's "Restarting the cluster"), then the others.
- **The writer** is one member at a time (D-016), checked Synced and ready by `haproxy/galera-check.sh` (the `monitor` user). When the old writer returns, writes stay on the new one.
- **Redis** members ask the sentinels for the primary when they start, so a primary that died comes back as a replica.
- **One HAProxy** here. Production runs two behind a keepalived address, or the provider's internal load balancer (S4-11).
