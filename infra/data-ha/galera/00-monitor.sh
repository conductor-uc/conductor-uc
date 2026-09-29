#!/bin/sh
# S4-07/S4-11: the user the load balancer's health check reads Galera's state
# with (SHOW GLOBAL STATUS needs no privilege). Runs once, on the bootstrap
# member's first start, like the other initdb scripts.
set -eu
mariadb -u root -p"${MARIADB_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS 'monitor'@'%' IDENTIFIED BY '${GALERA_MONITOR_PASSWORD:-dev-monitor-password}';
SQL
