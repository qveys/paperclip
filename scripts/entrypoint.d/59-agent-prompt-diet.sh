#!/usr/bin/env bash
# boot step — sync + apply prompt diet (fail-soft, foreground — fast)
set -uo pipefail
SRC=/opt/paperclip/patches/agent-prompt-diet
DST=/paperclip/patches/agent-prompt-diet
log() { echo "[59-agent-prompt-diet] $*"; }

mkdir -p "$DST" 2>/dev/null || true
if [ -d "$SRC" ]; then
  cp -a "$SRC/." "$DST/" 2>/dev/null || true
  chmod +x "$DST/apply.sh" 2>/dev/null || true
fi
if [ -f "$DST/apply.sh" ]; then
  bash "$DST/apply.sh" || log "apply error (ignored)"
else
  log "payload missing: $DST/apply.sh"
fi
exit 0
