#!/bin/sh
# S4-06/S4-10: what an edge does when keepalived gives it the floating
# addresses (`active`) or takes them away (`standby`). Active: the sharing tag
# `vip` (trunk registration, media node probing, dialogs), and the media relay
# owns the calls it was following. Standby: the relay hands its calls over as
# following copies. Each step is retried for an OpenSIPs or relay still starting.
set -u
case "${1:-}" in
  active)
    /opensips-mi.sh --retry clusterer_shtag_set_active vip/1
    ;;
esac
# The relay runs when its pid file is there (keepalived may run this script
# without the container's environment).
if [ -e /tmp/rtpengine.pid ]; then
  i=0
  until /rtpengine-cli.sh "$1" >/dev/null 2>&1 || [ "$i" -ge 30 ]; do
    i=$((i + 1))
    sleep 1
  done
fi
exit 0
