# Paperclip Operations Makefile
# All operations go through targets below. See 'make help' for usage.
#
# Design principles:
# - DRY (Don't Repeat Yourself): common commands in variables
# - Composable: small helpers combine into larger operations
# - Readable: self-documenting targets with clear intent
# - Safe: idempotent, fail-soft where appropriate

.PHONY: help \
	up down restart stop \
	build pull pull-build \
	decrypt encrypt \
	logs logs-app logs-hindsight \
	status version healthcheck shell cmd \
	clean \
	_ensure_env _compose_up _compose_down

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# VARIABLES & HELPERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COMPOSE := docker compose
EXEC := $(COMPOSE) exec -T paperclip
SERVICE := paperclip

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HELP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

help:
	@echo "📋 Paperclip Operations"
	@echo ""
	@echo "Core:"
	@echo "  make up              Start Paperclip"
	@echo "  make down            Stop Paperclip"
	@echo "  make restart         Restart (fresh container)"
	@echo ""
	@echo "Build & Update:"
	@echo "  make build           Rebuild with local patches (cached base)"
	@echo "  make pull-build      Check upstream + rebuild (recommended weekly)"
	@echo "  make pull            Update base only (no rebuild)"
	@echo ""
	@echo "Logs & Debug:"
	@echo "  make logs            Live logs (all services)"
	@echo "  make logs-app        Paperclip logs only"
	@echo "  make logs-hindsight  Hindsight logs only"
	@echo "  make status          Service status + version"
	@echo "  make version         Show version & patches"
	@echo "  make shell           Interactive bash"
	@echo "  make cmd ARGS=\"...\"  Run command in container"
	@echo ""
	@echo "Health:"
	@echo "  make healthcheck     HTTP health check"
	@echo ""
	@echo "Config:"
	@echo "  make decrypt         Decrypt .env.enc → .env"
	@echo "  make encrypt         Encrypt .env → .env.enc"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean           Remove old images"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CORE OPERATIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

up: _ensure_env _compose_up

down: _compose_down

restart: _ensure_env
	$(COMPOSE) up -d --force-recreate
	@echo "✓ Restarted"

stop:
	$(COMPOSE) stop
	@echo "✓ Stopped"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# BUILD & UPDATE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

build: _ensure_env
	$(COMPOSE) build $(SERVICE)
	@echo "✓ Rebuilt image"

pull-build: _ensure_env
	$(COMPOSE) pull $(SERVICE)
	$(COMPOSE) build $(SERVICE)
	@$(MAKE) restart
	@$(MAKE) version

pull: _ensure_env
	$(COMPOSE) pull
	@$(MAKE) _compose_up

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CONFIG & SECRETS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

decrypt:
	sops --decrypt --input-type dotenv --output-type dotenv .env.enc > .env
	chmod 600 .env
	@echo "✓ .env decrypted"

encrypt:
	sops --encrypt --input-type dotenv --output-type dotenv .env > .env.enc
	@echo "✓ .env encrypted"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LOGS & DEBUG
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

logs:
	$(COMPOSE) logs -f --tail=100

logs-app:
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

logs-hindsight:
	$(COMPOSE) logs -f --tail=100 hindsight

status:
	@echo "=== Docker Compose Status ===" && \
	$(COMPOSE) ps && \
	echo && \
	$(MAKE) version

version:
	@echo "=== Paperclip Version ===" && \
	$(EXEC) node -e "process.stdout.write(require('/usr/local/lib/node_modules/paperclipai/package.json').version+'\n')" 2>/dev/null || echo "Version not available" && \
	echo && echo "=== Patches Applied ===" && \
	$(EXEC) ls -1 /opt/paperclip/build.d/ 2>/dev/null | grep -E "^[0-9]+" | sed 's/^/  ✓ /'

shell:
	$(COMPOSE) exec $(SERVICE) bash

cmd:
	$(COMPOSE) exec $(SERVICE) $(ARGS)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HEALTH & MONITORING
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

healthcheck:
	@$(EXEC) curl -s http://localhost:3100/health 2>/dev/null | jq . || \
	echo "✗ Health check failed"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CLEANUP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

clean:
	$(COMPOSE) down
	docker image prune -f --filter until=72h
	@echo "✓ Cleaned"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# INTERNAL HELPERS (not meant to be called directly)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_ensure_env:
	@test -f .env || \
	(echo "[paperclip] .env absent — decrypting .env.enc..." && $(MAKE) decrypt)

_compose_up:
	$(COMPOSE) up -d
	@echo "✓ Started"

_compose_down:
	$(COMPOSE) down
	@echo "✓ Stopped"
