#!/usr/bin/env bash
# lib/common.sh — shared helpers for the Paperclip image scripts.
#
# Sourced (never executed). Defines ONLY functions and variables — it must NOT
# set shell options (set -e / -u / pipefail) or install traps, so each caller
# keeps its own policy: build-time patches stay fail-LOUD (set -euo pipefail),
# boot-time patches stay fail-SOFT (set -uo pipefail, exit 0 on trouble).
#
# Standard sourcing line from a script in bin/, build.d/ or entrypoint.d/:
#     source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
#
# All identifiers are namespaced `pc_*` / `PC_*` to avoid clashing with caller
# locals.

# ── Shared paths / constants ─────────────────────────────────────────────────
: "${PAPERCLIP_HOME:=/paperclip}"

# Canonical location of the installed @paperclipai/server package inside the image.
PC_SERVER_PKG_DEFAULT="/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server"

# The server's built dist/ inside the image — the anchor-patch target for the
# build.d/ patches (services/, routes/, app.js). Override per-script with
# PAPERCLIP_SERVER_DIST.
PC_SERVER_DIST_DEFAULT="$PC_SERVER_PKG_DEFAULT/dist"

# Telegram plugin worker dir inside the ./data volume — patched at boot by
# entrypoint.d/10-telegram-worker-patches.sh. Override per-script with
# TELEGRAM_PLUGIN_DIR.
PC_TELEGRAM_PLUGIN_DIR_DEFAULT="/paperclip/.paperclip/plugins/node_modules/paperclip-plugin-telegram/dist"

# MDXEditor toolbar patch markers (see build.d/30-mdxeditor-toolbar.sh).
PC_TOOLBAR_MARKER_FILE="TOOLBAR_PATCH_V1"
PC_TOOLBAR_MARKER_CSS="PAPERCLIP-TOOLBAR-PATCH-v1"

# ── Logging ──────────────────────────────────────────────────────────────────
# Configure per-script before/after sourcing:
#   PC_LOG_PREFIX  bracketed tag (default "paperclip")
#   PC_LOG_TS=1    prepend a HH:MM:SS timestamp
#   PC_LOG_FILE    also tee every line to this file
: "${PC_LOG_PREFIX:=paperclip}"

_pc_line() {  # $1 = tag (may be empty), rest = message
  local tag="$1"; shift
  local head="[$PC_LOG_PREFIX]"
  [ "${PC_LOG_TS:-0}" = "1" ] && head="$head $(date '+%H:%M:%S')"
  [ -n "$tag" ] && head="$head $tag"
  printf '%s %s\n' "$head" "$*"
}

pc_log() {
  if [ -n "${PC_LOG_FILE:-}" ]; then _pc_line "" "$@" | tee -a "$PC_LOG_FILE"
  else _pc_line "" "$@"; fi
}

pc_warn() {
  if [ -n "${PC_LOG_FILE:-}" ]; then _pc_line "WARNING:" "$@" | tee -a "$PC_LOG_FILE" >&2
  else _pc_line "WARNING:" "$@" >&2; fi
}

# Loud failure — only meaningful for fail-LOUD (build) callers.
pc_die() { _pc_line "ERROR:" "$@" >&2; exit 1; }

# ── @paperclipai/server discovery ────────────────────────────────────────────
# Unifies the three copies that used to live in entrypoint-patch-mdxeditor.sh,
# check-mdxeditor-patch.sh and patch-mdxeditor-toolbar.sh.
#
# Usage:  pkg="$(pc_find_server_pkg [explicit-target])" || handle-not-found
# Prints the resolved path on success (exit 0); prints nothing and returns 1 if
# nothing is found (caller decides whether that is fatal, a warning or a skip).
pc_find_server_pkg() {
  local target="${1:-${SERVER_PKG:-}}"
  if [ -n "$target" ]; then
    [ -d "$target" ] || return 1
    printf '%s\n' "$target"
    return 0
  fi
  local npm_root cand
  npm_root="$(npm root -g 2>/dev/null || true)"
  for cand in \
    "$PC_SERVER_PKG_DEFAULT" \
    "${npm_root:+$npm_root/paperclipai/node_modules/@paperclipai/server}" \
    "/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server" \
    "/opt/lib/node_modules/paperclipai/node_modules/@paperclipai/server"; do
    [ -n "$cand" ] || continue
    if [ -d "$cand" ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

# ── Toolbar build verification ───────────────────────────────────────────────
# Return 0 if any CSS under the given assets dir carries the toolbar marker.
# Greps the CSS (verbatim comment) rather than the JS, where Vite minification
# mangles the KitchenSinkToolbar identifier away.
pc_assets_have_toolbar() {
  local assets_dir="$1"
  grep -rqlF "$PC_TOOLBAR_MARKER_CSS" "$assets_dir" 2>/dev/null
}
