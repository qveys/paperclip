#!/usr/bin/env bash
# boot step (background) — apply agent model policy
#
# Ne contient AUCUNE logique : il exécute le payload baké dans l'image par le
# Dockerfile (COPY patches/ patches/ -> /app/patches/agent-model-policy/apply.sh).
# Avant ce commit, SRC pointait sur /opt/paperclip/patches/agent-model-policy,
# qui n'existe pas dans l'image (rien ne le copie là) : le step no-opait en
# silence à chaque boot ("payload missing").
#
# Fail-soft : sort toujours 0.
set -uo pipefail
LOG=/tmp/entrypoint-58-agent-model-policy.bg.log
PAYLOAD=/app/patches/agent-model-policy/apply.sh
{
  echo "[58-agent-model-policy] start $(date -Is 2>/dev/null || date)"
  if [ -x "$PAYLOAD" ]; then
    "$PAYLOAD" || echo "[58-agent-model-policy] apply error (ignored)"
  elif [ -f "$PAYLOAD" ]; then
    bash "$PAYLOAD" || echo "[58-agent-model-policy] apply error (ignored)"
  else
    echo "[58-agent-model-policy] payload missing: $PAYLOAD"
  fi
  echo "[58-agent-model-policy] done $(date -Is 2>/dev/null || date)"
} >>"$LOG" 2>&1
exit 0
