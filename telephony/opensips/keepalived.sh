#!/bin/sh
# S4-06 (D-017): the floating address of the edge pair, for a deployment that
# runs keepalived next to OpenSIPs (dev compose does; production may use the
# cloud provider's floating IP instead, and run the same MI call on failover).
#
# VRRP between the two edges (unicast, so no multicast is needed on the
# network), neither preempting: an edge that comes back does not take the
# address back, which would be a second failover for nothing. The edge that
# becomes master makes the sharing tag `vip` active on its OpenSIPs, which
# makes it the one that registers trunks, probes media nodes and acts on
# dialogs; the other edge learns it is then the backup.
set -eu

: "${OPENSIPS_VIP:?}" "${OPENSIPS_OWN_IP:?}" "${OPENSIPS_PEER_IP:?}"
PRIORITY="${KEEPALIVED_PRIORITY:-100}"
ROUTER_ID="${KEEPALIVED_ROUTER_ID:-51}"
PREFIX="${OPENSIPS_VIP_PREFIX:-32}"
IFACE="${KEEPALIVED_INTERFACE:-$(ip -o -4 addr show | awk -v ip="$OPENSIPS_OWN_IP" '$4 ~ "^"ip"/" { print $2; exit }')}"

cat > /etc/keepalived/keepalived.conf <<CONF
global_defs {
  router_id edge-${OPENSIPS_NODE_ID:-1}
  enable_script_security
  script_user root
}
vrrp_script opensips_alive {
  script "/opensips-mi.sh version"
  interval 1
  timeout 2
  fall 2
  rise 1
}
vrrp_instance edge {
  state BACKUP
  interface ${IFACE}
  virtual_router_id ${ROUTER_ID}
  priority ${PRIORITY}
  nopreempt
  advert_int 1
  unicast_src_ip ${OPENSIPS_OWN_IP}
  unicast_peer {
    ${OPENSIPS_PEER_IP}
  }
  virtual_ipaddress {
    ${OPENSIPS_VIP}/${PREFIX} dev ${IFACE}
  }
  track_script {
    opensips_alive
  }
  notify_master "/opensips-mi.sh --retry clusterer_shtag_set_active vip/1"
}
CONF

exec keepalived --dont-fork --log-console --vrrp
