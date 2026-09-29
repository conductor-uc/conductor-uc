# S4-07 (D-017): the internal load balancer in front of the data tier (and,
# on the app servers, S4-11, in front of every service). The MariaDB client is
# for the Galera health check (galera-check.sh); both clients serve the
# container's own health check; keepalived holds the app servers' private
# floating address (haproxy-start.sh, LB_VIP).
FROM haproxy:2.8
USER root
RUN apt-get update && apt-get install -y --no-install-recommends mariadb-client redis-tools keepalived iproute2 procps && rm -rf /var/lib/apt/lists/*
COPY haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg
COPY galera-check.sh /usr/local/bin/galera-check.sh
COPY haproxy-start.sh /usr/local/bin/haproxy-start.sh
RUN chmod +x /usr/local/bin/galera-check.sh /usr/local/bin/haproxy-start.sh
USER haproxy
ENTRYPOINT ["haproxy-start.sh"]
CMD ["haproxy", "-f", "/usr/local/etc/haproxy/haproxy.cfg"]
