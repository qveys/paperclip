#!/usr/bin/env bash
# 60-github-webhook-server.bg.sh
#
# Background daemon: tiny HTTP server on port 3101 that receives GitHub App
# webhook events (PR comments, reviews, state changes) and invokes agent
# heartbeats via the Paperclip API.
#
# Traefik routes POST paperclip.qveys.cloud/webhooks/github → port 3101
# (priority-20 router added in docker-compose.yml).
#
# .bg.sh suffix → launched in background by docker-entrypoint.sh.
# Log: /tmp/entrypoint-60-github-webhook-server.log
# Fail-soft: never blocks container startup.
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="github-webhook-server"

SERVER="/opt/paperclip/bin/github-webhook-server.js"

if [ ! -f "$SERVER" ]; then
  pc_warn "server script absent ($SERVER) — skipping"
  exit 0
fi

if [ -z "${PAPERCLIP_API_KEY:-}" ] || [ -z "${PAPERCLIP_COMPANY_ID:-}" ]; then
  pc_warn "PAPERCLIP_API_KEY ou PAPERCLIP_COMPANY_ID manquant — skipping"
  exit 0
fi

if [ -z "${GITHUB_WEBHOOK_SECRET:-}" ]; then
  pc_warn "GITHUB_WEBHOOK_SECRET non défini — le serveur démarrera sans vérification de signature"
fi

pc_log "démarrage du serveur webhook GitHub (port ${GITHUB_WEBHOOK_PORT:-3101})"
exec node "$SERVER"
