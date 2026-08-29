#!/usr/bin/env bash
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="qveys-agent-router"

ROUTER_DIR="${QVEYS_AGENT_ROUTER_DIR:-/opt/paperclip/qveys-agent-router}"
LOG_FILE="${QVEYS_AGENT_ROUTER_BOOT_LOG:-/tmp/qveys-agent-router.log}"

if [ ! -f "$ROUTER_DIR/router.mjs" ]; then
  pc_log "router.mjs absent dans $ROUTER_DIR, ignoré"
  exit 0
fi

if command -v pgrep >/dev/null 2>&1 && pgrep -f "$ROUTER_DIR/router.mjs" >/dev/null 2>&1; then
  pc_log "déjà lancé"
  exit 0
fi

mkdir -p "${PAPERCLIP_HOME:-/paperclip}/qveys-agent-router"
nohup node "$ROUTER_DIR/router.mjs" >>"$LOG_FILE" 2>&1 &
pc_log "lancé pid=$! log=$LOG_FILE"
exit 0
