-- S4-07: the user the load balancer's health check reads Galera's state with.
-- SHOW GLOBAL STATUS needs no privilege.
CREATE USER IF NOT EXISTS 'monitor'@'%' IDENTIFIED BY 'dev-monitor-password';
