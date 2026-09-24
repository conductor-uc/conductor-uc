S1-11: the `opensips` schema (05 §1.1's database-per-service rule, applied to
OpenSIPs). Vendored verbatim from the `opensips-mysql-dbschema` package
(OpenSIPs 3.6.8, matching the version this stack runs — see
`../Dockerfile`), one file per module this deployment actually loads. Not
hand-written: these are OpenSIPs' own module-internal table layouts, and a
module will not start correctly against a schema that does not match them
exactly.

Applied once, at compose bootstrap, by
`infra/compose/mariadb/init/02-opensips-schema.sh` — the same
"only runs against an empty data directory" rule as every other schema this
stack provisions (see that file, and `01-schemas.sh`). Not
`CREATE TABLE IF NOT EXISTS`: that is the upstream files' own choice, not
this repo's, so they stay byte-identical to what OpenSIPs ships.

Regenerate by re-extracting `/usr/share/opensips/mysql/{module}-create.sql`
from a fresh `opensips/opensips:<version>` image after installing
`opensips-mysql-dbschema`, if the pinned OpenSIPs version ever changes.

Covers: `standard` (the `version` bookkeeping table), `usrloc`, `auth_db`,
`domain`, `permissions`, `dispatcher`, `drouting`, `registrant`
(uac_registrant), `dialog`, `tls_mgm`, and `presence` (also backs
`presence_dialoginfo`/`pua_dialoginfo` — they reuse its tables, there is no
separate schema file for either). `tls_mgm` (G-105): the TLS certificates OpenSIPs presents, one row per SIP proxy
hostname, chosen by the name a client asks for (SNI) and reloaded with the MI
command `tls_reload`. Its `type` column is 1 for a *client* domain and 2 for a
*server* domain, which is the opposite of what one would guess. telephony-config's
`certificate-sync` writes one server row per proxy hostname plus a `default` row
(the platform's own certificate), with the private key in clear because that is
how the module loads it from the database; keep access to this schema narrow. No `clusterer` —
see `../opensips.cfg.template` for why this deployment does not load it yet.

S1-12 (telephony-config) is the only thing that ever *writes* to this
schema at runtime (03 §2's projection pattern) — this task only provisions
the empty tables that make S1-11's "reads the (empty) projection" done-when
criterion meaningful.
