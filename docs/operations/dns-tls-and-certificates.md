# DNS, TLS and certificates

The hostnames the platform uses, the DNS records to create, and how TLS certificates are issued and loaded. The platform obtains its own certificates from Let's Encrypt. You provide DNS, one bootstrap certificate, and a certificate for self-hosted object storage.

## 1. Hostnames

All derive from `PLATFORM_BASE_DOMAIN` (org-service, notification-service) and from the domains resellers add. Example platform domain: `voice.example.net`.

| Hostname | Pattern | Serves | Points at |
|---|---|---|---|
| Master console | `console.<platform domain>` | Web console and API for the master (operator) | api-gateway |
| Platform SIP proxy | `sip.<platform domain>` | SIP over TLS for tenants without their own reseller domain; also the fallback TLS certificate | OpenSIPs (and port 80 of the same address must reach the gateway) |
| Tenant domain | `<tenant slug>.<platform domain>` or `<tenant slug>.<reseller base domain>` | The SIP domain and realm a tenant's phones register to | OpenSIPs |
| Reseller base domain | chosen by the reseller, for example `voice.reseller-brand.com` | Parent of that reseller's tenant domains | Ownership proven by a TXT record |
| Reseller SIP proxy | `sip.<reseller base domain>` | SIP over TLS for that reseller's tenants | OpenSIPs (plus port 80 to the gateway) |
| Reseller console | any name the reseller registers, for example `portal.reseller-brand.com` | That reseller's branded console | api-gateway |
| Object storage | yours, for example `s3.voice.example.net`, or your provider's | Presigned downloads and uploads from browsers, FreeSWITCH and uploaders | Your object store |

Keep product and operator names out of every hostname (brand rule): only reseller brands may appear, and the platform domain itself should be neutral.

**Choose `PLATFORM_BASE_DOMAIN` once.** Tenant domains are created from it and stored, and phones are configured with them.

## 2. DNS records

With the reference layout (the gateway and OpenSIPs share public IP `203.0.113.10`):

| Record | Type | Value | Why |
|---|---|---|---|
| `console.voice.example.net` | A | `203.0.113.10` | Master console |
| `sip.voice.example.net` | A | `203.0.113.10` | Platform SIP proxy, and its certificate's HTTP-01 check (port 80) |
| `*.voice.example.net` | A | `203.0.113.10` | Every tenant domain under the platform domain. Phones resolve their tenant domain to reach OpenSIPs. |
| `s3.voice.example.net` | A | your object store's address | Only if you self-host object storage under your domain |
| For each reseller base domain `voice.reseller-brand.com`: | | | |
| `_domain-verification.voice.reseller-brand.com` | TXT | the 40-character token shown in the console | Proves the reseller controls the domain. Needed before activation. |
| `sip.voice.reseller-brand.com` | A | `203.0.113.10` | The reseller's SIP proxy |
| `*.voice.reseller-brand.com` | A | `203.0.113.10` | That reseller's tenant domains |
| For each reseller console hostname `portal.reseller-brand.com`: | A (or CNAME) | `203.0.113.10` | Reseller console |

Notes:

- Explicit records such as `console.` and `sip.` take precedence over the wildcard. In both guides they all point at the same address anyway.
- If the gateway and OpenSIPs have different public addresses, point `console.` and reseller console names at the gateway, and point `sip.` and the wildcards at OpenSIPs. Port 80 on OpenSIPs' address must still reach the gateway ([network §3.3](network-and-firewall.md#33-port-80-must-share-the-sip-edges-address)).
- In the console, the master's **Certificates** section records the public address, and each reseller's **Certificates** tab shows **DNS records to publish**: the A, AAAA or CNAME record for every name the platform holds a certificate for. It does not list the wildcards or the TXT record.
- The platform does not use SRV or NAPTR records. Phones are given a host and port directly.
- The tenant wildcards are inferred from how phones are configured (tenant domain as registrar); the platform does not list them. Test registration with your first tenant.
- Add SPF and DKIM for the domain in `PLATFORM_NOREPLY_ADDRESS`, as your mail relay requires, or email is likely to be marked as spam. The platform sends every email from that one address today (G-57).

## 3. Certificates the platform issues itself

org-service is an ACME client. It obtains and renews certificates from Let's Encrypt using the **HTTP-01** challenge only (no DNS-01, so no wildcard certificates).

### 3.1 Which names get certificates

The certificate reconciler runs at startup and every 5 minutes. It wants one certificate (RSA 2048, one name each) for:

- `console.<platform domain>`
- `sip.<platform domain>`
- `sip.<each verified reseller base domain>`
- every reseller console hostname

Tenant domains get **no** certificate. A phone using TLS connects to the `sip.` proxy name as its outbound proxy and keeps the tenant domain only as its SIP domain (G-105).

### 3.2 Prerequisites

Nothing is issued until all of these are true:

1. The name resolves publicly to your edge ([§2](#2-dns-records)).
2. TCP 80 on that address reaches the api-gateway's `HTTP_REDIRECT_PORT` listener, and the gateway has `INTERNAL_SERVICE_TOKEN` (it asks org-service for the challenge answer).
3. org-service can reach Let's Encrypt on TCP 443.
4. A master administrator has saved the ACME settings in the console's **Certificates** section: a contact email, the environment (Production or Staging), and agreement to the CA's terms.

Use **staging** first. Staging certificates are not trusted by browsers or phones, but they prove the whole path without using up Let's Encrypt's production rate limits. Then switch to production.

### 3.3 Issuance and renewal

- A worker runs every 60 seconds and handles up to 5 names per pass. A job is leased for 15 minutes, so several org-service copies do not collide.
- Renewal starts 30 days before expiry. After a failure it retries after 1 minute, then 5 minutes, 30 minutes, 2 hours, 6 hours, then daily.
- Certificates, their private keys and the ACME account key are stored in org-service's database. Private keys are encrypted with `CRYPTO_KEKS`.
- Each issued certificate publishes an `org.certificate.issued` event (without the key).

### 3.4 How the certificates are loaded

| Consumer | How | When |
|---|---|---|
| api-gateway (console names) | With `TLS_FROM_ORG_SERVICE=true`, fetches the certificate for each TLS hostname from org-service's internal API, caching it for 60 seconds | On the first connection for a name, then every 60 seconds |
| OpenSIPs (`sip.` names) | telephony-config writes each certificate into OpenSIPs' `tls_mgm` table (matched by SIP domain and SNI; the platform's own `sip.` certificate is also the default), then calls the MI command `tls_reload` | When the event arrives, and on every reconcile (`RECONCILE_INTERVAL_MS`, 15 minutes by default) |

No restart is needed for new or renewed certificates. The gateway never serves SIP certificates, and OpenSIPs never serves console certificates.

**Private keys are stored unencrypted** in OpenSIPs' `tls_mgm` table, because OpenSIPs must read them. Restrict the `opensips` schema to the `opensips` and telephony-config database users, and protect database backups accordingly.

## 4. The bootstrap certificate (first installation)

The ACME settings can only be saved from the console, and the console needs HTTPS to be usable (secure cookies). So the first start needs a certificate that does not come from the platform. Give the gateway one for `console.<platform domain>`:

**Option A: a real certificate (recommended).** Before starting the gateway, while port 80 is still free:

```sh
sudo certbot certonly --standalone -d console.voice.example.net \
  --agree-tos -m ops@example.net --no-eff-email
```

Mount `/etc/letsencrypt/live/console.voice.example.net/fullchain.pem` and `privkey.pem` into the gateway and set `TLS_CERT_FILE` and `TLS_KEY_FILE` to them, together with `TLS_FROM_ORG_SERVICE=true`.

**Option B: a self-signed certificate.** Browsers warn once. Fine for the first sign-in:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -subj "/CN=console.voice.example.net" \
  -addext "subjectAltName=DNS:console.voice.example.net" \
  -keyout privkey.pem -out fullchain.pem
```

Once org-service has issued its own certificate for `console.<platform domain>`, the gateway uses that one (org-service certificates are checked before the default file). The bootstrap file then only answers for names that have no certificate. Keep it in place and do not let it expire: a missing or unreadable `TLS_CERT_FILE` stops the gateway at startup. With certbot, renewals need port 80, which the gateway now holds. Either renew with `--pre-hook`/`--post-hook` that stop and start the gateway, or replace the file with a long-lived self-signed one after org-service has taken over.

Without any certificate source (no file, no directory, no org-service), the gateway serves **plain HTTP** on `HTTP_PORT`. Do not run it that way on the internet.

## 5. OpenSIPs TLS in detail

- The TLS listener (5061) opens when `OPENSIPS_TLS_ENABLED=true`, even before any certificate exists. Until telephony-config has written one, TLS handshakes fail and phones should use UDP or TCP (`SIP_PUBLIC_TRANSPORTS=udp,tcp`). Switch phones to TLS (`tls,tcp,udp`) once the `sip.` certificates are active.
- Optional file fallback: set `OPENSIPS_TLS_CERT_FILE` and `OPENSIPS_TLS_KEY_FILE` to a certificate mounted into the container. Both files must exist or OpenSIPs does not start.
- **Set `OPENSIPS_TLS_DEV_SELF_SIGNED=false` in production.** With `true`, the container generates a self-signed fallback certificate for `OPENSIPS_TLS_DEV_NAMES`.
- Protocol and ciphers: OpenSSL defaults with `HIGH:!aNULL:!MD5:!RC4:!3DES`. No explicit minimum version is set. Phones are not asked for client certificates.
- **Not verified:** whether Yealink phones validate the proxy certificate against the proxy name or the SIP domain (G-105).

## 6. Object storage TLS

Browsers load presigned URLs from `STORAGE_ENDPOINT` inside an HTTPS console, so the endpoint **must be HTTPS with a publicly trusted certificate**, or playback, downloads and uploads fail (mixed content). The platform does not issue this certificate.

- **Hosted S3** (AWS, Wasabi, Backblaze B2, Cloudflare R2, and so on): already HTTPS. Nothing to do.
- **Self-hosted MinIO:** give it a certificate for its public name. Either MinIO's own TLS (`public.crt` and `private.key` in its `certs` directory) or a reverse proxy in front of it that forwards the `Host` header unchanged (the signatures cover it). Renew that certificate yourself (for example certbot with a DNS challenge, or a reverse proxy that does ACME).

Also add the endpoint's origin to the gateway's `CONSOLE_CONNECT_SOURCES`, for example `https://s3.voice.example.net`.

## 7. Adding a reseller's domain (runbook)

1. The reseller adds its base domain in the console. The console shows a TXT token.
2. The reseller creates `_domain-verification.<base domain>` TXT `<token>` at its DNS provider and waits for it to propagate.
3. The reseller (or you) clicks **Verify**. org-service looks the TXT record up through the server's resolver. The record must equal the token exactly.
4. Create `sip.<base domain>` and `*.<base domain>` pointing at the SIP edge.
5. Within 5 minutes the reconciler asks for a `sip.<base domain>` certificate, and the worker issues it once DNS and port 80 are right. Watch org-service's log, or the certificate list in the console.
6. For a branded console, add the reseller's console hostname in the console and point it at the gateway. It gets its own certificate the same way. There is no ownership check for console hostnames, so only add names the reseller controls.
