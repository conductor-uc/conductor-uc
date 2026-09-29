#!/bin/sh
# HAProxy runs external checks with an empty environment, so the Galera check's
# credentials go into a MariaDB client options file it reads instead.
#
# S4-11: on the app servers the load balancer also holds the private floating
# address the services, the media nodes and the edges use (LB_VIP), through
# keepalived beside it. That needs the container to start as root (`user:
# root`, with NET_ADMIN); HAProxy itself then drops to its own user (the
# configuration's `user haproxy`).
set -eu
umask 077
printf '[client]\nuser=%s\npassword=%s\n' "${GALERA_CHECK_USER:-monitor}" "${GALERA_CHECK_PASSWORD:-}" \
  > /tmp/galera-check.cnf
if [ "$(id -u)" = 0 ]; then chown haproxy /tmp/galera-check.cnf; fi

if [ -n "${LB_VIP:-}" ]; then
  : "${LB_OWN_IP:?LB_OWN_IP must be set with LB_VIP}" "${LB_PEER_IP:?LB_PEER_IP must be set with LB_VIP}"
  IFACE="${LB_INTERFACE:-$(ip -o -4 addr show | awk -v ip="$LB_OWN_IP" '$4 ~ "^"ip"/" { print $2; exit }')}"
  mkdir -p /etc/keepalived
  cat > /etc/keepalived/keepalived.conf <<CONF
global_defs {
  router_id lb-${LB_OWN_IP}
  enable_script_security
  script_user root
}
vrrp_script haproxy_alive {
  script "/usr/bin/pgrep -x haproxy"
  interval 1
  fall 2
  rise 1
}
vrrp_instance lb {
  state BACKUP
  interface ${IFACE}
  virtual_router_id ${LB_ROUTER_ID:-52}
  priority ${LB_PRIORITY:-100}
  nopreempt
  advert_int 1
  unicast_src_ip ${LB_OWN_IP}
  unicast_peer {
    ${LB_PEER_IP}
  }
  virtual_ipaddress {
    ${LB_VIP}/${LB_VIP_PREFIX:-32} dev ${IFACE}
  }
  track_script {
    haproxy_alive
  }
}
CONF
  keepalived --dont-fork --log-console --vrrp &
fi
exec docker-entrypoint.sh "$@"
