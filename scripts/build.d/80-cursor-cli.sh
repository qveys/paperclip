#!/usr/bin/env bash
# 80-cursor-cli.sh — Install the Cursor Agent CLI into the image so Paperclip's
# built-in `cursor` adapter (type "cursor") can spawn it.
#
# WHY build.d/ (image) and not entrypoint.d/ (volume):
#   The adapter spawns a command from PATH; without it every run fails with
#   "Command not found in PATH". The cursor CLI is a ~178 MB self-contained
#   Node.js bundle. Baking it ONCE at build beats re-downloading at every boot
#   and putting it under /opt/paperclip/ (OUTSIDE the ./data volume) makes it
#   survive a volume wipe. The built-in `cursor` adapter is already in the
#   @paperclipai/server bundle — unlike junie, there is NOTHING to register.
#
# WHY cursor-agent and cursor (not agent):
#   The Grok CLI also installs an `agent` symlink in ~/.local/bin. Since
#   ~/.local/bin appears BEFORE /opt/paperclip/bin in PATH, putting cursor as
#   `agent` in /opt/paperclip/bin would lose to Grok's `agent` symlink while
#   the volume is populated. Exposing cursor as `cursor-agent` (and `cursor`)
#   avoids the collision entirely. Set `command: cursor-agent` (or `cursor`) in
#   agent configs instead of relying on the adapter default "agent".
#
# HOW: the official installer (cursor.com/install) drops the versioned bundle at
#   $HOME/.local/share/cursor-agent/versions/<version>/ and symlinks the wrapper
#   script from $HOME/.local/bin/cursor-agent. We point HOME at a throwaway dir,
#   run the installer, then COPY (not symlink) the entire versioned directory to
#   /opt/paperclip/cursor-agent-app/ so it has no dependency on the throwaway
#   HOME or any runtime volume path. Symlinks at /opt/paperclip/bin/cursor-agent
#   and /opt/paperclip/bin/cursor point into that bundled directory.
#
# Fail-LOUD: a download/exec failure aborts the build. Idempotent: a working
# /opt/paperclip/bin/cursor-agent short-circuits (pass --force to reinstall).
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="cursor-cli"

INSTALL_URL="${CURSOR_INSTALL_URL:-https://cursor.com/install}"
APP_DIR="${CURSOR_TARGET_APP_DIR:-/opt/paperclip/cursor-agent-app}"
BIN_DIR="${CURSOR_TARGET_BIN_DIR:-/opt/paperclip/bin}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

TARGET_AGENT="$BIN_DIR/cursor-agent"
TARGET_CURSOR="$BIN_DIR/cursor"

if [ "$FORCE" -eq 0 ] && [ -L "$TARGET_AGENT" ] && "$TARGET_AGENT" --version >/dev/null 2>&1; then
  pc_log "already present: $("$TARGET_AGENT" --version 2>&1 | head -1) — skip (use --force to reinstall)"
  exit 0
fi

mkdir -p "$BIN_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pc_log "installing Cursor Agent CLI from $INSTALL_URL"
# Throwaway HOME so the installer's ~/.local/share/cursor-agent lands in $WORK.
if ! HOME="$WORK" bash -c "curl -fsSL '$INSTALL_URL' | bash" >"$WORK/install.log" 2>&1; then
  pc_warn "installer failed; last log lines:"; tail -30 "$WORK/install.log" >&2
  exit 1
fi

# Find the versioned directory the installer created.
VERSIONED_DIR=""
if [ -d "$WORK/.local/share/cursor-agent/versions" ]; then
  VERSIONED_DIR="$(ls -d "$WORK/.local/share/cursor-agent/versions/"* 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$VERSIONED_DIR" ] || [ ! -d "$VERSIONED_DIR" ]; then
  pc_warn "no versioned cursor-agent directory found under $WORK/.local/share/cursor-agent/versions/"
  ls -la "$WORK/.local/share/cursor-agent/" >&2 2>/dev/null || true
  exit 1
fi
VERSION="$(basename "$VERSIONED_DIR")"
pc_log "copying cursor-agent $VERSION from $VERSIONED_DIR to $APP_DIR"

# Copy the entire self-contained versioned bundle into the image.
rm -rf "$APP_DIR"
cp -r "$VERSIONED_DIR" "$APP_DIR"
chmod -R a+rX "$APP_DIR"

# The wrapper script inside the bundle uses realpath($0) to locate its sibling
# node binary and index.js. Symlinking into the bundle from /opt/paperclip/bin/
# preserves this resolution: realpath(symlink) -> $APP_DIR/cursor-agent ->
# SCRIPT_DIR=$APP_DIR -> node and index.js found correctly.
ln -sfn "$APP_DIR/cursor-agent" "$TARGET_AGENT"
ln -sfn "$APP_DIR/cursor-agent" "$TARGET_CURSOR"

# Fail-LOUD verification.
if ! "$TARGET_AGENT" --version >/dev/null 2>&1; then
  pc_warn "installed $TARGET_AGENT but it does not execute"
  exit 1
fi
pc_log "installed Cursor Agent CLI $("$TARGET_AGENT" --version 2>&1 | head -1) -> $APP_DIR ($(du -sh "$APP_DIR" | cut -f1))"
pc_log "exposed as: $TARGET_AGENT and $TARGET_CURSOR"
