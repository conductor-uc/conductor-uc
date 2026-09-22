# S1-10: FreeSWITCH 1.10.x, minimal module set, neutral identity (03 §3).
#
# Base: a community-maintained, actively updated image built from the
# upstream FreeSWITCH APT packages — not `files.freeswitch.org` directly,
# which now requires authentication (confirmed while building this image: a
# plain request against it returns 401). The base image's own
# docker-entrypoint.sh still expects that access for its first-boot sound
# download and demo-config setup; this Dockerfile replaces the config
# entirely and never runs that entrypoint, so it is never reached.
FROM safarov/freeswitch:1.10.12

# Our own from-scratch config (see conf/) replaces the base image's vanilla
# demo config — not layered on top of it.
COPY conf/ /etc/freeswitch/

# S2-16: the voicemail Lua app. `lua.conf.xml` points mod_lua's own
# script-path at this exact directory.
COPY scripts/ /etc/freeswitch/scripts/

# 06's recording pipeline spool. Created here so `docker run` without an
# explicit volume still has somewhere to write; compose mounts this as tmpfs
# (CLAUDE.md rule 5 — nothing durable lives on the node).
RUN mkdir -p /var/spool/cuc/rec

EXPOSE 5060/udp 5060/tcp
EXPOSE 16384-32768/udp
EXPOSE 8021/tcp

HEALTHCHECK --interval=5s --timeout=5s --start-period=20s --retries=10 \
  CMD fs_cli -p "${FS_EVENT_SOCKET_PASSWORD:-change-me-FS_EVENT_SOCKET_PASSWORD}" -x status || exit 1

# -nf: stay in the foreground. FreeSWITCH otherwise double-forks into a
# background daemon by default, which leaves Docker's PID 1 with nothing to
# supervise. Runs directly, not through the base image's entrypoint script.
ENTRYPOINT ["/usr/bin/freeswitch", "-nf"]
