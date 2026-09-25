.PHONY: up down reset ps logs seed

COMPOSE := docker compose --project-directory infra/compose -f infra/compose/docker-compose.yml
ENV_FILE := infra/compose/.env

# The local stack: infrastructure (MariaDB, Redis, NATS, MinIO, Mailpit),
# FreeSWITCH and OpenSIPs, and the Node services behind api-gateway. See
# infra/compose/README.md for details and troubleshooting.

# --build: the images carry the services and the bootstrap CLI `make seed`
# runs, so they must match the checkout (unchanged layers come from cache).
up: $(ENV_FILE)
	$(COMPOSE) up -d --build
	@infra/compose/wait-healthy.sh 180
	@echo "Default host ports (see $(ENV_FILE)): gateway :8080  SIP :5060 udp/tcp, :5061 TLS  MariaDB :3306  Redis :6379  NATS :4222 (monitor :8222)  MinIO :9000 (console :9001)  Mailpit :8025"

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v
	$(MAKE) up

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

# Creates the master org and a master administrator (DEV_ADMIN_* in .env).
# Needs the stack up (`make up`); safe to re-run.
seed:
	infra/compose/seed.sh

$(ENV_FILE):
	cp infra/compose/.env.example $(ENV_FILE)
	@echo "Created $(ENV_FILE) from .env.example — edit it if a default port collides with something already running."
