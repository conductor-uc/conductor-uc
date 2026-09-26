# Day-2 operations

Running the platform after installation: upgrades, backups and restore, monitoring, logs, rotating secrets, troubleshooting, and the known limitations to plan around. Commands use the all-in-one layout (`/opt/voice`, compose project `voice`); on a distributed installation, run them on the server that holds the component.

## 1. Useful commands

```sh
cd /opt/voice
set -a; . ./.env; set +a                     # load settings into your shell

docker compose ps                             # state and health
docker compose logs -f --tail=100 <service>   # logs
docker compose restart <service>

# Call an internal endpoint (service images have no shell or curl)
docker run --rm --network voice_backplane curlimages/curl -s http://org-service:8080/readyz

# FreeSWITCH
docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'sofia status profile internal'
docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'show calls'
docker compose exec freeswitch fs_cli -p "$FS_EVENT_SOCKET_PASSWORD" -x 'show calls count'

# OpenSIPs (management interface, from inside its container)
MI='opensips-cli -o communication_type=http -o url=http://127.0.0.1:8888/mi -x mi'
docker compose exec opensips $MI ds_list        # FreeSWITCH nodes and their state
docker compose exec opensips $MI ul_dump        # registered phones
docker compose exec opensips $MI reg_list       # outbound trunk registrations
docker compose exec opensips $MI dr_gw_status   # carrier gateways

# Database shell
docker compose exec mariadb mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"
```

## 2. First administrator, resellers and tenants

The master organisation and its first administrator are created once, with one command ([all-in-one §9](deploy-all-in-one.md#9-bootstrap-the-platform)); running it again changes nothing. After that, everything is done in the console: the master creates resellers and resellers create tenants. Creating a reseller or tenant also creates its first administrator, with the email and initial password entered in the form (no invitation email is sent; pass the password on securely). Further people are invited from **Users**, which does send an email. Reseller domains follow [DNS/TLS §7](dns-tls-and-certificates.md#7-adding-a-resellers-domain-runbook).

If a master administrator loses their two-step device, another master administrator can reset it in the console (**Users**, **Reset two-step verification**). The resetting administrator confirms with a current code from **their own** authenticator app (step-up, G-100), so an administrator without two-step verification of their own cannot reset anyone's, and five wrong codes lock the confirmation for 15 minutes. The person is emailed, and so are the organisation's other administrators. If there is no other, the bootstrap command will not help (it creates an administrator only while the master has nobody). Create a second master administrator with identity-service's internal call instead, from a throwaway container on the private network:

```sh
set -a; . ./.env; set +a
docker run --rm --network voice_backplane curlimages/curl -sS \
  -X POST "http://identity-service:8080/internal/v1/orgs/<master orgId>/admin-user" \
  -H "Authorization: Bearer ${INTERNAL_SERVICE_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"orgType":"master","email":"second@example.net","displayName":"Second administrator","password":"<at least 12 characters>"}'
```

A `201` response means the person exists with the `master_admin` role. Sign in as them: as a master user they set up their own authenticator app at that first sign-in, which is what lets them confirm the reset. Then reset the first administrator's two-step verification, entering the new administrator's own current code when asked. The password is on the command line here, so clear your shell history afterwards.

### 2.1 Feature codes

Dialed as a number from a registered phone:

| Code | What it does |
|---|---|
| `*97` | Your own voicemail: listen to messages (asks for the mailbox PIN) |
| `*45` | Queue agent: log in (available for queue calls) |
| `*46` | Queue agent: log out |

Pressed during a call (the key `*`, then the digit), only on calls whose recording rule allows it (**Recordings**, **Rules**, "Allow recording on demand" or "Allow pausing"), and only by the tenant's own party on the call, never by an outside caller:

| Code | What it does |
|---|---|
| `*1` | Start recording the call; `*1` again stops it. Only where the rule does not record the call already. A recording a rule started cannot be stopped. |
| `*2` | Pause the call's recording (the paused part is silent); `*2` again resumes it. |

A short beep confirms; a low double tone means nothing was done (not allowed here, or the recording system could not be reached). Every start, stop, pause and resume is in the tenant's audit trail. On a call where these codes are armed, that party's `*` key is used by them and is not sent on to the other end.

## 3. Upgrades

### 3.1 How schema changes work

Every service applies its own database migrations **when it starts**, before it accepts requests. Several copies starting at once are safe (the migrator takes a lock). There is no separate migration step. Migrations only move forward in normal operation. A down-migration exists for development (`cuc-db down`), but rolling back a release means **restoring the database from the backup taken before the upgrade**.

### 3.2 Procedure

1. Read the release's changes, including new entries in `docs/decisions.md`: new required variables, changed ports, changed behaviour.
2. **Back up** MariaDB (§4.2) and copy `.env`.
3. Check out the release, rebuild the console (`flutter build web --release --no-web-resources-cdn`) and the images (`docker compose build`), or pull them from your registry.
4. Add any new variables to `.env`. For example, notification-service requires `IDENTITY_SERVICE_URL` from the release that tells an org's other admins about two-step resets (G-100); without it the service refuses to start.
5. Restart in this order, waiting for each group to be healthy:
   1. data stores, only if their version changes;
   2. identity-service and org-service;
   3. the other application services;
   4. call-control, then telephony-config;
   5. api-gateway;
   6. OpenSIPs and FreeSWITCH, **in a quiet period**.

   `docker compose up -d` recreates only the containers whose image or settings changed, in dependency order. Use it for steps 2–5 together if a few seconds of API errors are acceptable.
6. Run the verification list ([all-in-one §10](deploy-all-in-one.md#10-verify)).

**Releases that change the signed identity headers** (the first is the one that added the client address to them, G-113; its release notes say so): the gateway and the eight services that trust those headers (identity, org, pbx-config, trunk, callflow, voicemail, recording, cdr) must run the same version. While one side is old, every request through the gateway is answered 401 `internal_headers_forged`. Upgrade them together, in one step, and expect the API to be unavailable until both sides are restarted. The same release makes those services refuse a request that reaches them directly without signed headers or `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (G-112): check that any script or tool of your own that calls a service's port directly sends the token. It also stops the gateway believing `X-Forwarded-For` and `X-Forwarded-Proto` unless you list your proxies in `TRUSTED_PROXIES` ([network §6.3](network-and-firewall.md#63-client-addresses-and-x-forwarded-headers)); set it before upgrading if the gateway sits behind a load balancer.

**The release that issues reset and invitation links at send time** (G-55; its release notes say so):

- `INVITATION_TTL_DAYS` is renamed `INVITATION_TTL_HOURS`, and invitations now last **72 hours** by default instead of 7 days. The old variable is ignored; if you set it, set `INVITATION_TTL_HOURS` instead (for example `168` to keep seven days). Invitations made before the upgrade keep their expiry.
- notification-service needs a new required variable, `IDENTITY_SERVICE_URL` (the all-in-one and distributed files already pass it through `x-urls`; add it if you wrote your own). It must reach identity-service's port.
- The password-reset and invitation events change version. **Upgrade identity-service and notification-service in the same step.** A reset or invitation requested in the few seconds while one is old and the other new is not emailed (notification-service logs `terminating event that does not match its contract` at error). The person can ask for a new reset. An invitation that was not emailed can be sent again only once it expires, so avoid inviting people during the upgrade. Links emailed before the upgrade keep working until they expire.
- Two new settings apply to every service: `OUTBOX_RETENTION_DAYS` and `NATS_STREAM_MAX_AGE_DAYS`, both 7 by default ([configuration §3.3](configuration-reference.md#33-events-every-service-except-api-gateway)). At first start, every service deletes the events it published more than 7 days ago (on an old installation, the first run takes a while; it works in batches and does not block anything), and every stream gets a 7-day age limit, so messages older than that are removed from NATS at once. Make sure no consumer is stopped with a backlog older than 7 days before upgrading, or set a larger `NATS_STREAM_MAX_AGE_DAYS` in every service first.

What a restart costs:

| Restarting | Effect |
|---|---|
| An application service | Requests to it fail for a few seconds. Events wait in NATS and are processed afterwards (for up to `NATS_STREAM_MAX_AGE_DAYS`, 7 days by default). |
| telephony-config | **New calls fail while it is down**: FreeSWITCH asks it for every call. |
| call-control | Live-call tracking and resource leases restart. Calls continue. |
| api-gateway | Console and API unavailable for a few seconds. Signed-in users stay signed in. Open live views (Monitoring) are closed with 1001 and reconnect by themselves. |
| **OpenSIPs** | **Calls being set up fail, and in-dialog requests for existing calls may fail** (dialog state is reloaded from the database). Registrations survive (stored in MariaDB). |
| **FreeSWITCH** | **Every call on that node drops.** Recordings in progress are lost; finished ones still in the spool are uploaded after restart if the spool volume survived. The spool is tmpfs, so on a server reboot they are lost too. |

## 4. Backups and restore

### 4.1 What to back up

| What | Why | How | How often |
|---|---|---|---|
| **MariaDB**: every service schema plus `opensips` | The system of record: organisations, users, configuration, call records, audit, certificates, encrypted secrets | Logical dump (§4.2) and/or binary logs for point-in-time recovery | Daily at least; before every upgrade |
| **Object storage** | Recordings, voicemail, prompts, logos, exports | Provider versioning and replication, or copy with `rclone`/`mc mirror`; MinIO's data directory if self-hosted | Per your retention needs |
| **`.env` and compose files** | Every setting and secret | Copy to your secrets vault | On every change |
| **`CRYPTO_KEKS`** | Without it, the encrypted data in the dump is useless ([configuration §3.5](configuration-reference.md#35-crypto_keks-the-master-encryption-key)) | **Store separately from the database backups**, in a vault or offline | On every change |
| Bootstrap TLS files, MinIO certificates | Needed to start the gateway and MinIO | With `.env` | On renewal |

Not needed: Redis (live state only), NATS (undelivered events stay in the services' outbox tables; losing the stream loses at most events already published but not yet consumed), FreeSWITCH, OpenSIPs and the gateway (no state of their own).

Event retention (G-55): each service deletes events from its `outbox` table 7 days after publishing them (`OUTBOX_RETENTION_DAYS`), and NATS removes a message 7 days after it arrived, consumed or not (`NATS_STREAM_MAX_AGE_DAYS`). So a consumer stopped for longer than that loses the events it missed. No event carries a password-reset or invitation token: the token is created when the email is sent and only its hash is stored, so neither a dump nor a NATS store holds a usable one.

There is no backup tooling in the platform (release-readiness task, not started). Nothing checks that backups work, so test restores.

**The dump contains sensitive data**: call records, audit logs, and the OpenSIPs TLS private keys in clear. Encrypt it at rest and restrict access.

### 4.2 Logical backup

```sh
SCHEMAS="identity_service org_service pbx_config_service telephony_config trunk_service \
  media_worker call_control callflow_service voicemail_service cdr_service \
  notification_service recording_service opensips"
docker compose exec -T mariadb mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" \
  --single-transaction --routines --triggers --events --databases $SCHEMAS \
  | gzip > "/backup/voice-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
```

`--single-transaction` gives a consistent snapshot without locking InnoDB tables. The dump leaves out the `mysql` system schema on purpose: users and grants are recreated by the init scripts on restore.

For point-in-time recovery, enable binary logs (`--log-bin`, `--binlog-format=ROW`, `--expire-logs-days=7` in the MariaDB `command:`) and archive them. `mariadb-backup` (physical backups) also works with this image.

### 4.3 Restore

1. Stop everything except MariaDB: `docker compose stop` for all services, or `docker compose down` then `docker compose up -d mariadb`.
2. To restore into a **fresh** data volume, delete the volume (`docker compose down`, then `docker volume rm voice_mariadb-data`) and start MariaDB. The init scripts create every schema and user from the passwords in `.env`, so use the same `.env`.
3. Load the dump:

   ```sh
   gunzip -c /backup/voice-<timestamp>.sql.gz | \
     docker compose exec -T mariadb mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"
   ```

4. Make sure `CRYPTO_KEKS` in `.env` is the same one the backup was made with, including every older version.
5. Start the rest (`docker compose up -d`). Services find their schemas already migrated. telephony-config re-projects its view within one reconcile interval and on the next events.
6. Flush Redis (`docker compose exec redis redis-cli FLUSHALL`). It may hold leases and counters that do not match the restored data.
7. Run the verification list.

Object storage is restored separately. A database restored to an earlier time than the objects is harmless: rows point only at objects that existed then. The reverse (objects older than rows) shows as missing recordings or voicemail.

## 5. Monitoring

The platform exports almost no metrics yet: there is no OpenTelemetry (the variable exists and is ignored), and only the recording uploader has a Prometheus endpoint. Monitor from outside with health probes and logs.

### 5.1 Health endpoints

Every application service and the gateway:

- `GET /healthz`: liveness, `{status, service, version, uptimeSeconds}`.
- `GET /readyz`: 503 if any dependency check fails; the body lists each check.

Readiness checks:

| Service | Checks |
|---|---|
| api-gateway | redis. NATS is deliberately not a readiness check: the API works without it. When the realtime hub cannot read events, live subscriptions are refused as unavailable and the gateway logs `realtime feed not reading; retrying` or `realtime hub cannot reach NATS yet`. |
| Services with a database | db, bus (NATS), outbox (reports the number of unpublished events, always passes) |
| org, identity, pbx-config, trunk and voicemail services | also kek_rewrap: records still under an older `CRYPTO_KEKS` version (always passes; see §6) |
| call-control | db, bus, redis |
| telephony-config | db, opensips_db, bus, redis, outbox |

`GET /v1/platform/health` on the gateway (master administrators, or the console's **Platform health**) checks the eight services the gateway forwards to. It does **not** cover telephony-config, call-control, media-worker, notification-service, OpenSIPs, FreeSWITCH or the uploaders. Probe those directly.

### 5.2 What to watch

| Signal | How | Alert when |
|---|---|---|
| Every service ready | HTTP probe of `/readyz` on each service (private network) | Not 200 for 1 minute |
| Container restarts | `docker compose ps`, or your container monitoring | A service restarts repeatedly (usually configuration or a dependency) |
| Console reachable | External HTTPS probe of `https://console.<domain>/healthz` | Down, or certificate expires within 14 days |
| SIP edge reachable | SIP OPTIONS probe to `sip.<domain>:5060` (for example with `sipsak`) | No answer |
| FreeSWITCH nodes | `ds_list` shows each node active; `fs_cli -x status` on each | Any node inactive |
| Registrations | `ul_dump` count, trended | Sudden drop |
| Trunk registrations | `reg_list` | A trunk not registered |
| Flood blocks | OpenSIPs log: `pike: blocking flood from` | Any from an address you expected to be exempt (a carrier or media server): it is missing from its trunk or from `OPENSIPS_FS_DESTINATION` |
| Recording and voicemail spool | Uploader `/metrics`: `cuc_recording_spool_stuck_files`, `cuc_recording_spool_undeletable_files`, `cuc_recording_spool_bytes`, `cuc_recording_upload_failures_total` | stuck or undeletable above 0; spool bytes above half its size |
| Recording or voicemail loss | Uploader, recording-service and voicemail-service logs | `recording_upload_stuck` or `recording_spool_delete_failed` alerts |
| Unrecordable calls | telephony-config log: `recording_policy_unavailable` | Any, if recording matters to your tenants |
| Calls refused for want of a recording | telephony-config log: `recording_required_refused` (tenants with "Recording required" on) | Any: those tenants' calls are failing while recording-service is unreachable |
| Certificates | Console **Certificates** list; org-service log | A certificate failing, or active and expiring within 20 days (renewal starts at 30) |
| Email | notification-service log | SMTP errors |
| Outbox backlog | `/readyz` outbox detail (`N pending`) on each service | Growing steadily (NATS unreachable, or events failing) |
| Consumers stopped | A consumer service not ready, or `nats consumer report <stream>` showing unprocessed messages | Any consumer down for more than a day: after `NATS_STREAM_MAX_AGE_DAYS` (7 days) its missed events are gone |
| Reset and invitation emails skipped | notification-service log: `identity-service issued no link; not sending` (info) | Many at once: identity-service refusing links (the reset was used or expired, the user disabled, the invitation accepted) is normal one at a time |
| NATS | `http://<nats>:8222/jsz` (if you publish monitoring) | Stream or consumer errors; storage full |
| MariaDB | Your usual MariaDB monitoring | Connections near `max_connections`; replication lag if used; disk |
| Disk | Host monitoring | MariaDB and NATS volumes above 80% |
| Clock | `chronyc tracking` or `timedatectl` | Offset above 1 second (signatures fail at 60) |

## 6. Rotating secrets

Most secrets are shared between components that read them only at startup. Rotating one means changing it everywhere and restarting those components together. Requests between them fail in between.

Any secret can be given to the services as a file instead of an environment variable: set `<NAME>_FILE` to its path, for example `DB_PASSWORD_FILE=/run/secrets/db_password` with a Docker or Kubernetes secret mounted there ([configuration reference §1](configuration-reference.md#1-how-the-services-read-their-settings)). Rotating it is then replacing the file and restarting the service; the file is read only at startup.

| Secret | Procedure | Impact |
|---|---|---|
| Database passwords | `ALTER USER '<user>'@'%' IDENTIFIED BY '<new>';` in MariaDB, update `.env`, restart that service (for `opensips`: OpenSIPs and telephony-config) | That service restarts |
| `INTERNAL_SERVICE_TOKEN` | Update `.env`, restart every service, the gateway and the uploaders together (`docker compose up -d`) | Internal calls fail for the few seconds of the restart |
| `INTERNAL_HEADER_SIGNING_SECRET` | Update, restart the gateway and the eight services that check it together | API calls fail during the restart |
| `FS_XML_CURL_TOKEN`, `FS_CDR_INGEST_TOKEN` | Update, restart telephony-config (or cdr-service) and **every FreeSWITCH node** | **Restarting FreeSWITCH drops its calls.** Do it in a quiet period. |
| `FS_EVENT_SOCKET_PASSWORD` | Update, restart FreeSWITCH nodes and call-control | Same |
| `CRYPTO_KEKS` | 1. Add a new version and make it current, identically in the five services that use it (org, identity, pbx-config, trunk, voicemail): `CRYPTO_KEKS=1:<old>,2:<new>`, `CRYPTO_KEK_CURRENT=2`. Restart them. 2. Each re-wraps its existing records under version 2 in the background (at startup, then every 10 minutes). Watch `GET /readyz` on each: the `kek_rewrap` check reads `N values under older key versions`, and the logs repeat the count after each pass. 3. When **all five** report `0 values under older key versions`, remove version 1 (`CRYPTO_KEKS=2:<new>`) and restart them again. Keep the old key with any backup taken before step 3: restoring that backup needs it. | Services restart twice. Nothing else is interrupted: records stay readable while they are re-wrapped. |
| Login-token signing keys | **Automatic**, published ahead: when the key has signed for `SIGNING_KEY_ROTATION_DAYS` (default 90), identity-service publishes the next key (log: `signing key staged`) and, `SIGNING_KEY_PUBLISH_AHEAD_MINUTES` later (default 15, within 5 minutes), makes it the signing key (log: `signing key rotated`). The old key keeps verifying for `SIGNING_KEY_OVERLAP_DAYS`. **On demand**: `docker compose run --rm identity-service dist/src/cli/rotate-signing-key.js` publishes the next key the same way and prints when it starts signing; identity-service switches to it by itself after that time (running the command again after it also switches). `--now` switches at once instead, skipping publish-ahead. **If a key may have leaked**, use `--revoke-previous`: it switches at once (it implies `--now`) and every earlier key, including one published ahead, leaves the key set. | None for an automatic or default rotation: the gateway already holds the new key when the first token it signed arrives. With `--now`, a gateway that fetched the key set within the last `JWKS_COOLDOWN_MS` (30 s) can refuse new tokens until that time has passed. With `--revoke-previous`, access tokens signed before it stop working at identity-service at once and at the gateway once its key cache refreshes (`JWKS_CACHE_MAX_AGE_MS`, default 10 minutes); nobody has to sign in again, because the refresh cookie is not affected, but an open console's requests fail until it fetches a new token at its next scheduled refresh (within the 10-minute access-token lifetime) or a page reload, and someone midway through a two-step sign-in starts again. |
| Object storage keys | Create a new key pair at the provider, update `.env`, restart the storage services, then delete the old key | Services restart |
| ACME account | Handled by org-service | — |

## 7. Logs

- Every Node.js service writes **JSON lines to stdout** (pino): `level`, `time` (ISO 8601), `service`, `version`, `msg`, plus `requestId`, `traceId`, `tenantId`, `resellerId`, `actorId` on request logs.
- Each service logs its effective configuration at startup, with secrets masked. Credentials, tokens and passwords are always redacted.
- OpenSIPs and FreeSWITCH log to stdout at `OPENSIPS_LOG_LEVEL` and `FS_LOG_LEVEL`.
- Rotate with Docker's `json-file` options (`max-size`, `max-file`, as in the reference compose file) or ship to a collector (journald, Loki, Elasticsearch, your SIEM).
- The platform's **audit log** (who did what, private-data access) is in the database (`identity_service.audit_events`) and visible in the console. It is not in the container logs.
- The audit table is partitioned by month for a window fixed when the migration was written, with a catch-all partition after it, so inserts never fail. But nothing adds new monthly partitions or drops old ones, so there is no automatic retention and rows past the window pile into the catch-all (G-12). `cdrs` is the same (G-52). Prune and re-partition by hand until that is built.

Logs may contain telephone numbers and tenant identifiers. Treat log storage as personal data under your privacy obligations.

## 8. Troubleshooting

| Symptom | Likely causes | Check |
|---|---|---|
| A service restarts in a loop | A required variable is missing or invalid; MariaDB or NATS unreachable | First lines of its log list every configuration error at once |
| Console: "Sign in to continue" everywhere after signing in | The service has `TRUST_INTERNAL_HEADERS=false` | That service's environment |
| API errors `internal_headers_forged` (401) | `INTERNAL_HEADER_SIGNING_SECRET` differs between gateway and service, or clocks are more than 60 s apart | Secrets; `timedatectl` on every server |
| API errors 503 "Could not check your permissions" | identity-service unreachable from that service | identity-service health; `IDENTITY_SERVICE_URL` |
| Console blank or partly broken | `CONSOLE_DIR` unset or empty; console built without `--no-web-resources-cdn` | Gateway environment; browser developer console (content security policy errors) |
| Recordings or voicemail won't play in the browser; uploads fail | Storage origin not in `CONSOLE_CONNECT_SOURCES`; storage not HTTPS; `STORAGE_ENDPOINT` not reachable from the browser | Browser developer console |
| Phones get 403 `https_required` when provisioning | Phones fetch over HTTP | Use `https://` in the phones, or (not recommended) `REQUIRE_HTTPS_FOR_PROVISIONING=false` |
| Phones get 429 | Many phones behind one address rebooting together (limit 300 per minute per IP) | Raise `RATE_LIMIT_IP_MAX` |
| Phones cannot register | DNS for the tenant domain; wrong credentials; OpenSIPs has not received the tenant's domain yet (telephony-config projection); flood block | `ul_dump`; OpenSIPs log; telephony-config log |
| Registered phones don't receive calls | Phone behind NAT sending a private Contact ([network §6.5](network-and-firewall.md#65-phones-behind-nat)) | `ul_dump` shows the contact address |
| Calls fail with 503 | No FreeSWITCH node active in dispatcher; node refusing OpenSIPs (ACL `FS_OPENSIPS_CIDR`) | `ds_list`; FreeSWITCH log (`acl` rejections); OpenSIPs log (`pike`) |
| Calls connect but no audio, or one-way audio | FreeSWITCH advertising a private address (1:1 NAT without `FS_EXTERNAL_RTP_IP`); RTP range blocked; carrier or phone NAT | `sofia status profile internal` (`Ext-RTP-IP`); firewall; packet capture on the RTP range |
| Calls to extensions fail, FreeSWITCH log shows xml_curl errors | telephony-config unreachable from FreeSWITCH; `FS_XML_CURL_TOKEN` mismatch; `SELF_URL` ≠ `TELEPHONY_CONFIG_URL` | FreeSWITCH log; telephony-config log (401s) |
| Outbound calls fail | No outbound route; trunk not registered; carrier rejects the caller ID; tenant fraud limits | `reg_list`, `dr_gw_status`; OpenSIPs and telephony-config logs |
| Carrier cannot reach you after registration | `OPENSIPS_SIP_URI` is a private address (it is the contact sent to carriers) | telephony-config environment; `reg_list` |
| Calls to queues, parking or conferences fail intermittently | Several FreeSWITCH nodes (G-46, S4-05) | Run one media server |
| No call records | FreeSWITCH cannot reach cdr-service; `FS_CDR_INGEST_TOKEN` mismatch | FreeSWITCH log (json_cdr); cdr-service log |
| Calls to one tenant fail with a short tone, then fail (SIP 500 at the caller, `Reason: Q.850;cause=41`); other tenants' calls work | The tenant has **Recording required** on (Recordings, Rules) and recording-service is unreachable or slow from telephony-config, or cannot register the recording (its database). Calls no rule records are not affected | telephony-config log `recording_required_refused`; recording-service `/readyz`; `RECORDING_SERVICE_URL`. Restore recording-service; the tenant can also turn the option off |
| Recordings never appear | No recording rule matches; recording-service unreachable at call setup (`recording_policy_unavailable`); uploader cannot reach recording-service or storage | telephony-config, uploader and recording-service logs; uploader metrics |
| Voicemail messages never appear, or appear only much later | A message is listed only after the uploader has delivered its audio (about 30 s after the caller hangs up, `SETTLE_SECONDS`). Uploader not running on that node, or it cannot reach voicemail-service (`VOICEMAIL_SERVICE_URL`, 8106 in the distributed layout) or storage; the caller hung up before speaking (the uploader reports `empty_file`) | `ls /var/spool/cuc/rec` in the FreeSWITCH container (`vm-<id>.wav` files waiting); uploader log and metrics; voicemail-service log |
| A queue agent's calls are not recorded although an agent rule names them | The call was already recorded from setup by a queue, DID or tenant rule (one recording only; it is the caller's); the agent's rule applies from their answer only, and only to queue calls; the FreeSWITCH image predates `agent_recording.lua`; recording-service unreachable when the agent answered (agent recordings fail open) | FreeSWITCH log (`agent_recording.lua`); telephony-config log; the recording list filtered by the queue |
| `*1` or `*2` during a call gives a low double tone, or nothing | The call's deciding rule does not allow on demand (the narrowest rule decides); `*1` pressed during a recording a rule started (pause it with `*2` instead); recording-service unreachable (nothing is done when it cannot be audited); the FreeSWITCH image predates `recording_control.lua`; the phone sends DTMF in-band or by SIP INFO rather than RFC 4733 | telephony-config log (`feature code refused`, `could not reach recording-service`); recording-service log; FreeSWITCH log (`recording_control.lua`); the phone's DTMF setting |
| Recordings upload but stay in the spool | Spool directory has the sticky bit (`1777`) | `ls -ld /var/spool/cuc/rec` in the FreeSWITCH container must show `drwxrwxrwx`, not `drwxrwxrwt` |
| Certificates never issue | ACME settings not saved; DNS wrong; port 80 not reaching the gateway; gateway without `INTERNAL_SERVICE_TOKEN`; org-service cannot reach Let's Encrypt; Let's Encrypt rate limit | org-service log; `curl http://sip.<domain>/.well-known/acme-challenge/test` from outside must reach the gateway (404 is fine) |
| SIP TLS handshake fails | No `sip.` certificate yet; telephony-config could not reach the MI to `tls_reload` | Console **Certificates**; telephony-config log |
| Emails not sent | SMTP settings; relay refuses the sender address | notification-service log |
| Nobody can sign in after a restore | `CRYPTO_KEKS` differs from the one the data was encrypted with | Restore the right key |

## 9. Known limitations

Plan around these. IDs refer to [decisions](../decisions.md) and the [implementation plan](../plan/implementation-plan.md).

| Area | Limitation | Reference |
|---|---|---|
| Security | OpenSIPs MI and Redis have no authentication; no TLS to MariaDB, Redis or NATS; NATS NKeys ignored | network §6.2 |
| Security | One shared internal token for all services; FreeSWITCH tokens are static | 07 §1 |
| Security | Master key comes from an environment variable or a file; no KMS (deferred until a customer or auditor needs one) | G-116, 07 §5 |
| Security | OpenSIPs TLS private keys stored in clear in the `opensips` schema | 07 §5 |
| Availability | No HA for OpenSIPs, MariaDB, Redis, NATS; call-control single copy; no FreeSWITCH failure cleanup or synthetic CDRs | S4-03 to S4-07 |
| Telephony | No media relay: media servers need public addresses; no SRTP | O-7 |
| Telephony | Queues, parking and conferences unreliable with more than one media server | G-46, S4-05 |
| Telephony | Media server list fixed at OpenSIPs start; no weights or draining | S4-02 |
| Telephony | Per-tenant call rate fixed at 10 per second; repeated SIP authentication failures not blocked | G-31, G-118 |
| Telephony | Phones behind NAT not verified | network §6.5 |
| Telephony | Only Yealink auto-provisioning, not verified on hardware | G-103 |
| Operations | No production manifests; no backup tooling; no metrics beyond the uploader; no tracing | S4-11, release readiness |
| Operations | Audit and CDR tables have no retention: partitions are never extended or pruned | G-12, G-52 |
| Capacity | No capacity benchmarks | S4-09 |
