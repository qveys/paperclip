#!/usr/bin/env bash
# boot step (background) — sync + apply agent model policy
set -uo pipefail
LOG=/tmp/entrypoint-58-agent-model-policy.bg.log
SRC=/opt/paperclip/patches/agent-model-policy
DST=/paperclip/patches/agent-model-policy
{
  echo "[58-agent-model-policy] start $(date -Is 2>/dev/null || date)"
  mkdir -p "$DST" 2>/dev/null || true
  if [ -d "$SRC" ]; then
    cp -a "$SRC/." "$DST/" 2>/dev/null || true
    chmod +x "$DST/apply.sh" 2>/dev/null || true
  fi
  if [ -f "$DST/apply.sh" ]; then
    bash "$DST/apply.sh" || echo "[58-agent-model-policy] apply error (ignored)"
  else
    echo "[58-agent-model-policy] payload missing: $DST/apply.sh"
  fi
  echo "[58-agent-model-policy] done $(date -Is 2>/dev/null || date)"
} >>"$LOG" 2>&1
exit 0
