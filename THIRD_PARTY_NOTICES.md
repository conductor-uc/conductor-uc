# Third-party notices

The platform's own code is licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`; see `LICENSE`). The container images built from
this repository also contain upstream software under its own licences, listed
below. Each image carries the upstream licence texts in the places its
packages install them (for Debian packages, `/usr/share/doc/<package>/copyright`).

## Shipped in images built from this repository

### FreeSWITCH (`telephony/freeswitch/Dockerfile`)

- Base image: `safarov/freeswitch:1.10.12` (a community image built from the
  upstream FreeSWITCH Debian packages).
- Licence: Mozilla Public License 1.1 (MPL 1.1).
- Upstream source: https://github.com/signalwire/freeswitch, tag `v1.10.12`.
- Our image adds only configuration and Lua scripts from this repository
  (`telephony/freeswitch/conf/`, `telephony/freeswitch/scripts/`); FreeSWITCH
  itself is not modified. The base image also contains the libraries
  FreeSWITCH depends on and a Debian base, each under its own licence.

### OpenSIPs (`telephony/opensips/Dockerfile`)

- Base image: `opensips/opensips:3.6`, plus these OpenSIPs module packages:
  `opensips-mysql-module`, `opensips-http-modules`, `opensips-redis-module`,
  `opensips-presence-modules`, `opensips-auth-modules`, `opensips-tls-module`,
  `opensips-tlsmgm-module`, `opensips-tls-openssl-module`; and Debian's
  `gettext-base`.
- Licence: GNU General Public License, version 2 (GPLv2).
- Version: the 3.6 series; the exact patch release is pinned by the base image
  tag at build time (`3.6` follows upstream patch releases).
- Upstream source: https://github.com/OpenSIPS/opensips, the `3.6.<patch>` tag
  matching the release in the image (`opensips -V`).
- Our image adds only configuration and scripts from this repository
  (`opensips.cfg.template`, `docker-entrypoint.sh`, `seed-dispatcher.py`);
  OpenSIPs itself is not modified.

### Node.js service images (`services/*/Dockerfile`)

- Build stage: `node:22-bookworm-slim`. Runtime stage:
  `gcr.io/distroless/nodejs22-debian12:nonroot` for every service except
  `media-worker`. Version pinned by the base image tag.
- Contents: Node.js 22 (MIT, with bundled components under their own
  licences, see the Node.js `LICENSE`), a minimal Debian 12 base, and the
  service's npm production dependencies (see "npm dependencies" below).

### media-worker (`services/media-worker/Dockerfile`)

- Runtime stage: `node:22-bookworm-slim` (Node.js 22 and Debian 12), plus
  Debian's `ffmpeg` package and its dependencies, installed from the Debian
  bookworm archive. Version pinned by the base image tag and the Debian
  archive at build time.
- Licence: FFmpeg is LGPL-2.1-or-later, with GPL-2.0-or-later parts depending
  on the build configuration; Debian's `copyright` file in the image is
  authoritative.

### npm dependencies

The services' npm production dependencies are installed from
`pnpm-lock.yaml`. They are under permissive licences (MIT, Apache-2.0, ISC,
BSD, BlueOak-1.0.0, 0BSD, CC0-1.0, Unlicense, Python-2.0, CC-BY-4.0 for
data files, and `node-forge` under BSD-3-Clause OR GPL-2.0, used under
BSD-3-Clause). List them with `pnpm licenses list --prod`.

### Console web build (`apps/console`)

The console is compiled to JavaScript with Flutter (BSD-3-Clause) and served
by api-gateway. Its Dart packages are installed from
`apps/console/pubspec.lock` and are under permissive licences: `dio`,
`flutter_riverpod`, `fl_chart` (the Operations page's charts) and its
dependency `equatable` are MIT; `go_router`, `qr_flutter`, `url_launcher` and
`web` are BSD-3-Clause. List them with `flutter pub deps` in `apps/console`.

## Vendored in this repository

- `telephony/opensips/db-schema/*.sql`: table definitions copied verbatim from
  OpenSIPs' `opensips-mysql-dbschema` package (3.6.8). Part of OpenSIPs,
  GPLv2; source as above, tag `3.6.8`.

## Used by the local and CI stack only, not shipped in our images

`infra/compose/docker-compose.yml` and `.github/workflows/ci.yml` pull these
upstream images as they are. The deployment guides in `docs/operations/` tell
operators to run some of them (MariaDB, Redis, NATS, MinIO) in production too;
they are then obtained by the operator from upstream, not distributed by us.

| Image | Software | Licence |
| --- | --- | --- |
| `mariadb:11.4` | MariaDB Server | GPLv2 |
| `redis:7-alpine` | Redis 7.x | BSD-3-Clause up to 7.2; RSALv2 / SSPLv1 from 7.4 (the `7` tag follows the latest 7.x) |
| `nats:2.10-alpine` | NATS Server | Apache-2.0 |
| `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | MinIO (community build) | AGPL-3.0 |
| `axllent/mailpit:latest` | Mailpit (development mail catcher) | MIT |
| `prom/prometheus:v3.5.0` | Prometheus (the operations console's history, S4-13) | Apache-2.0 |
