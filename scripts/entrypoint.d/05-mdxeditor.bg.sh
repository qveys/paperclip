#!/usr/bin/env bash
# entrypoint-patch-mdxeditor.sh — Boot-time MDXEditor toolbar patch.
#
# IMPORTANT: This script must run INSIDE the Paperclip container, NOT on the host.
#
# Integration options:
#
#   Option A — Call from docker-entrypoint.sh (recommended):
#     Add this line BEFORE the main process starts in docker-entrypoint.sh:
#       bash /opt/paperclip/entrypoint-patch-mdxeditor.sh 2>&1 | tee /tmp/mdxeditor-patch.log || true
#
#   Option B — Dockerfile RUN step (bakes patch into image):
#     COPY entrypoint-patch-mdxeditor.sh /opt/paperclip/
#     COPY patch-mdxeditor-toolbar.sh /opt/paperclip/
#     RUN bash /opt/paperclip/entrypoint-patch-mdxeditor.sh
#
#   Option C — docker compose exec (one-shot, must redo after recreate):
#     docker compose exec paperclip bash /opt/paperclip/entrypoint-patch-mdxeditor.sh
#
# This script:
#   - Checks if the patch is already applied (idempotent)
#   - Runs the full patch if needed
#   - NEVER blocks container startup — logs errors and exits 0
#   - Logs everything to stdout AND /tmp/mdxeditor-patch.log
#
set -uo pipefail

# Shared helpers: pc_log/pc_warn, pc_find_server_pkg, pc_assets_have_toolbar,
# PC_TOOLBAR_MARKER_*. From entrypoint.d/ the lib is one level up.
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"

LOG_FILE="/tmp/mdxeditor-patch.log"
PATCH_MARKER_FILE="$PC_TOOLBAR_MARKER_FILE"
PC_LOG_PREFIX="entrypoint-patch"
PC_LOG_TS=1
PC_LOG_FILE="$LOG_FILE"

log()  { pc_log "$@"; }
warn() { pc_warn "$@"; }

: > "$LOG_FILE"
log "MDXEditor toolbar patch — boot-time check starting"
log "Running as: $(whoami) in $(pwd)"

# ── Locate server package ────────────────────────────────────────────────────

server_pkg="$(pc_find_server_pkg)" || server_pkg=""

if [[ -z "$server_pkg" ]]; then
  warn "Cannot locate @paperclipai/server — patch skipped."
  warn "This script must run INSIDE the Paperclip container."
  log "Exit 0 — not blocking container startup."
  exit 0
fi

log "Server package found: $server_pkg"

# ── Idempotency check ────────────────────────────────────────────────────────

ui_dist="$server_pkg/ui-dist"

if [[ -f "$ui_dist/$PATCH_MARKER_FILE" ]]; then
  if pc_assets_have_toolbar "$ui_dist/assets"; then
    log "Patch already applied and verified (marker + CSS marker OK). Nothing to do."
    exit 0
  else
    log "Marker file exists but CSS marker missing from assets — re-patching."
    rm -f "$ui_dist/$PATCH_MARKER_FILE" 2>/dev/null || true
  fi
fi

log "Patch not yet applied — running full patch..."

# ── Locate patch script ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_SCRIPT=""

for candidate in \
  "$SCRIPT_DIR/../build.d/30-mdxeditor-toolbar.sh" \
  "/opt/paperclip/build.d/30-mdxeditor-toolbar.sh"; do
  if [[ -f "$candidate" ]]; then
    PATCH_SCRIPT="$candidate"
    break
  fi
done

if [[ -z "$PATCH_SCRIPT" ]]; then
  warn "30-mdxeditor-toolbar.sh not found in build.d/"
  warn "Searched: $SCRIPT_DIR/../build.d/, /opt/paperclip/build.d/"
  log "Exit 0 — not blocking container startup."
  exit 0
fi

log "Using patch script: $PATCH_SCRIPT"

# ── Pre-flight checks ────────────────────────────────────────────────────────

missing_tools=()
command -v node >/dev/null 2>&1 || missing_tools+=("node")
command -v git  >/dev/null 2>&1 || missing_tools+=("git")

if [[ ${#missing_tools[@]} -gt 0 ]]; then
  warn "Missing required tools: ${missing_tools[*]}"
  warn "The patch script needs: node, git, and npm or pnpm"
  log "Exit 0 — not blocking container startup."
  exit 0
fi

log "Pre-flight OK — node $(node --version), git $(git --version 2>&1 | head -1)"

# ── Run the patch ─────────────────────────────────────────────────────────────

log "Executing: bash $PATCH_SCRIPT --force --target $server_pkg"

set +e
bash "$PATCH_SCRIPT" --force --target "$server_pkg" 2>&1 | tee -a "$LOG_FILE"
patch_exit=${PIPESTATUS[0]}

if [[ $patch_exit -ne 0 ]]; then
  warn "Patch script exited with code $patch_exit"
  warn "The container will continue starting without the toolbar patch."
  warn "Check full log: $LOG_FILE"
  log "Exit 0 — not blocking container startup."
  exit 0
fi

# ── Post-patch verification ───────────────────────────────────────────────────

if [[ -f "$ui_dist/$PATCH_MARKER_FILE" ]]; then
  if pc_assets_have_toolbar "$ui_dist/assets"; then
    log "Post-patch verification PASSED — toolbar CSS marker is in the bundle."
    log "Patch applied successfully."

    # 30-mdxeditor-toolbar.sh just replaced ui-dist/ wholesale (rm -rf + fresh
    # copy), which wipes build.d/50-agentanalytics-tracker.sh's index.html
    # injection (same file, both patch it — see build.d/README.md). Re-run 50
    # so a real boot-time rebuild doesn't silently drop the analytics tracker.
    # 50 is itself idempotent (marker AGENT_ANALYTICS_TRACKER_V1) and locates
    # the package itself via pc_find_server_pkg, so no args are needed.
    TRACKER_SCRIPT=""
    for candidate in \
      "$SCRIPT_DIR/../build.d/50-agentanalytics-tracker.sh" \
      "/opt/paperclip/build.d/50-agentanalytics-tracker.sh"; do
      if [[ -f "$candidate" ]]; then
        TRACKER_SCRIPT="$candidate"
        break
      fi
    done

    if [[ -n "$TRACKER_SCRIPT" ]]; then
      log "Re-asserting analytics tracker injection: bash $TRACKER_SCRIPT"
      bash "$TRACKER_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
      tracker_exit=${PIPESTATUS[0]}
      if [[ $tracker_exit -ne 0 ]]; then
        warn "Analytics tracker re-injection failed (exit $tracker_exit) — index.html may be missing the tracker."
      fi
    else
      warn "50-agentanalytics-tracker.sh not found in build.d/ — tracker re-injection skipped."
    fi
  else
    warn "Post-patch: marker exists but CSS marker not in assets."
    warn "The Vite build may have produced output without the toolbar."
  fi
else
  warn "Post-patch: marker file not found — patch may have failed silently."
fi

log "Entrypoint patch complete. Log: $LOG_FILE"
exit 0
