#!/usr/bin/env bash
# 85-antigravity-cli.sh — Install the Google Antigravity CLI (`agy`) into the
# image so the external `antigravity_local` adapter
# (scripts/adapters/adapter-antigravity-local, registered at boot by
# entrypoint.d/46-register-antigravity-adapter.sh) can spawn it.
#
# WHY: the adapter spawns the bare command `agy` from PATH; without it every run
#   dies with "Command not found in PATH: agy". Same reasoning as 60-grok-cli.sh:
#   bake the binary once at build (direct egress, no Squid) under
#   /opt/paperclip/bin (on the `node` user's PATH, outside the ./data volume).
#
# HOW: the upstream installer (antigravity.google/cli/install.sh) takes
#   `--dir <path>` and drops a standalone binary there after a SHA-512 check.
#   HOME points at a throwaway dir so its ~/.cache staging never lands in /root.
#   Runtime auth is separate: OAuth token at $HOME/.gemini/antigravity-cli/
#   antigravity-oauth-token, or GEMINI_API_KEY + settings.json modelProvider=gemini.
#   agy self-updates in the background; /opt/paperclip/bin is root-owned, so at
#   runtime (uid node) that update cannot land — the version moves with rebuilds.
#
# Fail-LOUD, idempotent (a working binary short-circuits; --force reinstalls).
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="antigravity-cli"

INSTALL_URL="${AGY_INSTALL_URL:-https://antigravity.google/cli/install.sh}"
BIN_DIR="${AGY_TARGET_BIN_DIR:-/opt/paperclip/bin}"
TARGET="$BIN_DIR/agy"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ "$FORCE" -eq 0 ] && [ -x "$TARGET" ] && "$TARGET" --version >/dev/null 2>&1; then
  pc_log "already present: $("$TARGET" --version 2>&1 | head -1) — skip (use --force to reinstall)"
  exit 0
fi

mkdir -p "$BIN_DIR"
rm -f "$TARGET"  # the installer refuses to overwrite an existing binary
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pc_log "installing Antigravity CLI from $INSTALL_URL into $BIN_DIR"
if ! HOME="$WORK" bash -c "curl -fsSL '$INSTALL_URL' | bash -s -- --dir '$BIN_DIR'" >"$WORK/install.log" 2>&1; then
  pc_warn "installer failed; last log lines:"; tail -20 "$WORK/install.log" >&2
  exit 1
fi

chmod 0755 "$TARGET"
if ! "$TARGET" --version >/dev/null 2>&1; then
  pc_warn "installed $TARGET but it does not execute"; exit 1
fi
pc_log "installed $("$TARGET" --version 2>&1 | head -1) -> $TARGET ($(stat -c%s "$TARGET") bytes)"
