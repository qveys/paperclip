#!/usr/bin/env bash
# boot step — apply prompt diet (fail-soft, foreground — fast)
#
# Ne contient AUCUNE logique : il exécute le payload baké dans l'image par le
# Dockerfile (COPY patches/ patches/ -> /app/patches/agent-prompt-diet/apply.sh).
# Avant ce commit, SRC pointait sur /opt/paperclip/patches/agent-prompt-diet,
# qui n'existe pas dans l'image (rien ne le copie là) : le step no-opait en
# silence à chaque boot ("payload missing").
#
# Fail-soft : sort toujours 0.
set -uo pipefail

PAYLOAD=/app/patches/agent-prompt-diet/apply.sh
log() { echo "[59-agent-prompt-diet] $*"; }

if [ -x "$PAYLOAD" ]; then
  "$PAYLOAD" || log "apply error (ignored)"
elif [ -f "$PAYLOAD" ]; then
  bash "$PAYLOAD" || log "apply error (ignored)"
else
  log "payload missing: $PAYLOAD"
fi

exit 0
