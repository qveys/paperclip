#!/usr/bin/env bash
# 60-grok-cli.sh — Install the official xAI Grok CLI (`grok`) into the image so
# Paperclip's built-in `grok_local` adapter can spawn it.
#
# WHY a build.d/ (image) patch and not entrypoint.d/ (volume):
#   The adapter spawns the bare command `grok` from PATH; without it the run dies
#   with "Command not found in PATH: grok". The binary is a single ~145 MB self-
#   contained executable — baking it ONCE at build (where egress is direct, not
#   via the Squid runtime proxy) beats re-downloading at every boot, and putting
#   it under /opt/paperclip/bin (already on the `node` user's PATH, OUTSIDE the
#   ./data volume) makes it survive a volume wipe. `grok_local` itself is built
#   into @paperclipai/server (var grokLocalCLIAdapter, type "grok_local"), so —
#   unlike junie — there is NOTHING to register; only the binary is missing.
#
# HOW: the upstream installer (x.ai/cli/install.sh) drops the binary under
#   $HOME/.grok/downloads and symlinks $GROK_BIN_DIR/grok -> it. We point HOME at
#   a throwaway dir and GROK_BIN_DIR at /opt/paperclip/bin, then DEREFERENCE the
#   symlink into a standalone file (cp -L) so the kept binary has no dependency on
#   the throwaway HOME, which we delete. Runtime auth is separate (XAI_API_KEY /
#   `grok` login) — same "binary baked, token still owed" state as junie.
#
# Fail-LOUD: a download/exec failure aborts the build instead of shipping an
# image whose grok runs all die on first spawn. Idempotent: a working
# /opt/paperclip/bin/grok short-circuits (pass --force to reinstall/upgrade).
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="grok-cli"

INSTALL_URL="${GROK_INSTALL_URL:-https://x.ai/cli/install.sh}"
BIN_DIR="${GROK_TARGET_BIN_DIR:-/opt/paperclip/bin}"
TARGET="$BIN_DIR/grok"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ "$FORCE" -eq 0 ] && [ -x "$TARGET" ] && "$TARGET" --version >/dev/null 2>&1; then
  pc_log "already present: $("$TARGET" --version 2>&1 | head -1) — skip (use --force to reinstall)"
  exit 0
fi

mkdir -p "$BIN_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pc_log "installing Grok CLI from $INSTALL_URL into $BIN_DIR"
# Throwaway HOME so the installer's ~/.grok cache lands in $WORK, not /root.
if ! HOME="$WORK" GROK_BIN_DIR="$WORK/bin" bash -c "curl -fsSL '$INSTALL_URL' | bash" >"$WORK/install.log" 2>&1; then
  pc_warn "installer failed; last log lines:"; tail -20 "$WORK/install.log" >&2
  exit 1
fi

# The installer symlinks $WORK/bin/grok -> $WORK/.grok/downloads/grok-<arch>.
# Dereference into a standalone file under $BIN_DIR (independent of $WORK).
src="$WORK/bin/grok"
[ -e "$src" ] || { pc_warn "expected installed binary at $src not found"; ls -la "$WORK/bin" >&2 || true; exit 1; }
cp -L "$src" "$TARGET"
chmod 0755 "$TARGET"

# Fail-LOUD verification: the kept, standalone binary must actually run.
if ! "$TARGET" --version >/dev/null 2>&1; then
  pc_warn "installed $TARGET but it does not execute"; exit 1
fi
pc_log "installed $("$TARGET" --version 2>&1 | head -1) -> $TARGET ($(stat -c%s "$TARGET") bytes)"
