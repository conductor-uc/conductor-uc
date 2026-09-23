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

# S2-16's voicemail Lua app, S2-10's flow runner, S2-15's conference app
# (plus the `json.lua` the flow runner loads). Copied to mod_lua's own
# compiled-in default script directory, not a custom one — confirmed live
# (S2-20): `lua.conf.xml`'s own `script-directory` param (the correct name;
# an earlier `script-path` was simply wrong) is a long-documented FreeSWITCH
# bug (signalwire/freeswitch#1483 — the param parses and logs as accepted,
# but is never actually applied to the runtime search path), so every
# `lua <script>.lua ...` dialplan action failed with "cannot open
# /usr/share/freeswitch/scripts/<script>.lua: No such file or directory"
# despite `/etc/freeswitch/scripts/` being correctly populated and
# correctly (if uselessly) configured. Copying here instead sidesteps the
# module bug entirely rather than depending on a fix that may never land.
COPY scripts/ /usr/share/freeswitch/scripts/

# 06's recording pipeline spool, and S2-10's flow-IR cache. Created here so
# `docker run` without an explicit volume still has somewhere to write;
# compose mounts these as tmpfs (CLAUDE.md rule 5 — nothing durable lives on
# the node, and a cache is by definition safe to lose on restart: the runner
# re-fetches, which is S2-07's "a node restart simply re-caches" applied to
# call flows).
#
# `sounds/moh`: `local_stream.conf.xml`'s own MOH directory (G-47) — has to
# exist for `mod_local_stream` to load at all, empty is fine (confirmed
# live: an empty directory degrades to silence/comfort noise, not a load
# failure), and there is no sound package to populate it with regardless.
#
# `cache/cuc/http`: `http_cache.conf.xml`'s own `location` (G-47, same bug
# class — `mod_http_cache` also fails to *load* without a config file
# naming a cache directory, confirmed live).
RUN mkdir -p /var/spool/cuc/rec /var/cache/cuc/flow /usr/share/freeswitch/sounds/moh /var/cache/cuc/http

EXPOSE 5060/udp 5060/tcp
EXPOSE 16384-32768/udp
EXPOSE 8021/tcp

HEALTHCHECK --interval=5s --timeout=5s --start-period=20s --retries=10 \
  CMD fs_cli -p "${FS_EVENT_SOCKET_PASSWORD:-change-me-FS_EVENT_SOCKET_PASSWORD}" -x status || exit 1

# -nf: stay in the foreground. FreeSWITCH otherwise double-forks into a
# background daemon by default, which leaves Docker's PID 1 with nothing to
# supervise. Runs directly, not through the base image's entrypoint script.
ENTRYPOINT ["/usr/bin/freeswitch", "-nf"]
