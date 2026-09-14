.PHONY: up down reset ps logs seed

COMPOSE := docker compose --project-directory infra/compose -f infra/compose/docker-compose.yml
ENV_FILE := infra/compose/.env

# S0-05: MariaDB, Redis, NATS (JetStream), MinIO, and Mailpit — everything a
# service needs locally except telephony, which arrives in S1. See
# infra/compose/README.md for details and troubleshooting.

up: $(ENV_FILE)
	$(COMPOSE) up -d
	@infra/compose/wait-healthy.sh
	@echo "MariaDB :3306  Redis :6379  NATS :4222 (monitor :8222)  MinIO :9000 (console :9001)  Mailpit :8025"

down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v
	$(MAKE) up

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

# Applies migrations and bootstraps the master org. Needs `pnpm build` first.
seed:
	infra/compose/seed.sh

$(ENV_FILE):
	cp infra/compose/.env.example $(ENV_FILE)
	@echo "Created $(ENV_FILE) from .env.example — edit it if a default port collides with something already running."
