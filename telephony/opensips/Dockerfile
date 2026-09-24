# S1-11: OpenSIPs 3.6 (03 §2: "OpenSIPs 3.4 LTS or later"), the extra
# modules the platform needs beyond the base install.
FROM opensips/opensips:3.6

# bullseye's plain security repo has been pruned upstream (EOL) — the
# Debian snapshot archive is what still serves it. Confirmed directly while
# building this image: `apt-get update` against the image's own
# sources.list fails on debian-security with a 404.
RUN printf '%s\n' \
    'deb http://snapshot.debian.org/archive/debian/20260803T000000Z bullseye main' \
    'deb http://snapshot.debian.org/archive/debian-security/20260803T000000Z bullseye-security main' \
    'deb http://snapshot.debian.org/archive/debian/20260803T000000Z bullseye-updates main' \
    > /etc/apt/sources.list

# Everything here is already in 03 §2's module list; none of it ships in
# the base `opensips` package. opensips-mysql-dbschema is deliberately not
# installed — its table-creation SQL is vendored instead (db-schema/), so a
# real deployment provisions the schema the same way every other service's
# schema is provisioned, not via this image at container start.
#
# TLS (07 §5: "SIP-TLS (5061) and SRTP are offered to endpoints"): the
# transport module, its certificate manager, and the OpenSSL backend. The
# listener is only turned on when a certificate is configured (see
# docker-entrypoint.sh), so an image without one behaves as before.
RUN apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends \
      gettext-base \
      opensips-mysql-module \
      opensips-http-modules \
      opensips-redis-module \
      opensips-presence-modules \
      opensips-auth-modules \
      opensips-tls-module \
      opensips-tlsmgm-module \
      opensips-tls-openssl-module && \
    rm -rf /var/lib/apt/lists/*

COPY opensips.cfg.template /etc/opensips/opensips.cfg.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
# S1-14 (G-18): seeds the FS node into `dispatcher` at container start.
# `pymysql` (confirmed present — `opensips-cli` itself needs a MySQL driver)
# means no new package is needed for this.
COPY seed-dispatcher.py /seed-dispatcher.py
RUN chmod +x /docker-entrypoint.sh

EXPOSE 5060/udp 5060/tcp 5061/tcp

# opensips-cli defaults to the FIFO transport (its own defaults.py); this
# image never loads mi_datagram/FIFO, only mi_http — confirmed directly, the
# bare command errors "FIFO file ... does not exist". -o forces http, whose
# own default URL (http://127.0.0.1:8888/mi) already matches OPENSIPS_MI_PORT.
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=10 \
  CMD opensips-cli -o communication_type=http -o url=http://127.0.0.1:${OPENSIPS_MI_PORT}/mi -x mi version || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
