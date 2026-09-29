# S4-07 (D-016): a Galera member. The stock MariaDB image carries the Galera
# library and mariabackup; the state transfer to a joining member also needs
# socat.
#
# S4-11: built from the repository root, so a data server needs nothing but
# the image: the first member's first start creates the load balancer's
# `monitor` user, every service's schema and user (infra/compose/mariadb/init)
# and OpenSIPs' tables (telephony/opensips/db-schema), as the everyday
# `mariadb` does. The other members receive them by state transfer.
FROM mariadb:11.4
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*
COPY infra/data-ha/galera/galera.cnf /etc/mysql/conf.d/galera.cnf
COPY infra/data-ha/galera/galera-start.sh /usr/local/bin/galera-start.sh
COPY infra/data-ha/galera/galera-health.sh /usr/local/bin/galera-health.sh
COPY infra/data-ha/galera/00-monitor.sh /docker-entrypoint-initdb.d/00-monitor.sh
COPY infra/compose/mariadb/init/ /docker-entrypoint-initdb.d/
COPY telephony/opensips/db-schema/ /opensips-schema/
RUN chmod +x /usr/local/bin/galera-start.sh /usr/local/bin/galera-health.sh
ENTRYPOINT ["galera-start.sh"]
