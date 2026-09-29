# S4-07 (D-016): a Galera member. The stock MariaDB image carries the Galera
# library and mariabackup; the state transfer to a joining member also needs
# socat.
FROM mariadb:11.4
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*
COPY galera.cnf /etc/mysql/conf.d/galera.cnf
COPY galera-start.sh /usr/local/bin/galera-start.sh
COPY galera-health.sh /usr/local/bin/galera-health.sh
RUN chmod +x /usr/local/bin/galera-start.sh /usr/local/bin/galera-health.sh
ENTRYPOINT ["galera-start.sh"]
