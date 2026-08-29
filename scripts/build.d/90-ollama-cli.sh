#!/usr/bin/env bash
# 90-ollama-cli.sh — Bake the Ollama runtime (`ollama`) into the image so agents
# and plugins can run a local LLM server (`ollama serve`, API on 127.0.0.1:11434)
# and the `ollama` CLI without a multi-GB download at every boot.
#
# WHY build.d/ (image) and not entrypoint.d/ (volume):
#   The official bundle is a ~2 GB self-contained tree (the `ollama` binary plus
#   its GPU/CPU runner libs under lib/ollama). Baking it ONCE at build — where
#   egress is direct, not via the Squid runtime proxy — beats re-downloading
#   gigabytes at every boot, and putting it under /opt/paperclip (already on the
#   `node` user's PATH, OUTSIDE the ./data volume) makes it survive a volume wipe.
#
# WHY relocate after the official installer:
#   ollama.com/install.sh derives its prefix from PATH (the first of
#   /usr/local/bin, /usr/bin, /bin) and drops the bundle at <prefix>/bin/ollama +
#   <prefix>/lib/ollama, plus — when systemd is present — a systemd unit and an
#   `ollama` system user. The binary loads its runner libs RELATIVE to itself
#   ($ORIGIN/../lib/ollama), so the bundle is fully relocatable: we run the
#   official installer, then MOVE bin/ollama and lib/ollama into /opt/paperclip
#   (preserving the bin/ <-> ../lib/ollama layout) and drop the systemd unit +
#   ollama user it may have left behind (both useless in this container — the
#   server is started on demand via `ollama serve`, not by systemd).
#
# CPU-only by default: OLLAMA_PRUNE_GPU defaults to 1, removing the cuda_*/rocm
#   runner dirs (the bulk of the ~2 GB bundle) so the image stays slim. Set
#   OLLAMA_PRUNE_GPU=0 to keep the GPU runners (needed only on a GPU host).
#
# Fail-LOUD: a download/exec/relocate failure aborts the build instead of
# shipping an image whose ollama runs all die on first spawn. Idempotent: a
# working /opt/paperclip/bin/ollama short-circuits (pass --force to reinstall).
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="ollama-cli"

INSTALL_URL="${OLLAMA_INSTALL_URL:-https://ollama.com/install.sh}"
PREFIX="${OLLAMA_TARGET_PREFIX:-/opt/paperclip}"
BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/lib"
TARGET="$BIN_DIR/ollama"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ "$FORCE" -eq 0 ] && [ -x "$TARGET" ] && "$TARGET" --version >/dev/null 2>&1; then
  pc_log "already present: $("$TARGET" --version 2>&1 | tail -1) — skip (use --force to reinstall)"
  exit 0
fi

mkdir -p "$BIN_DIR" "$LIB_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pc_log "installing Ollama from $INSTALL_URL"
# The installer lands the bundle at /usr/local/{bin,lib}/ollama (first PATH dir).
if ! { curl -fsSL "$INSTALL_URL" | sh; } >"$WORK/install.log" 2>&1; then
  pc_warn "installer failed; last log lines:"; tail -30 "$WORK/install.log" >&2
  exit 1
fi

# Locate what the installer dropped (default prefix /usr/local).
SRC_BIN="" SRC_LIB=""
for p in /usr/local /usr; do
  if [ -x "$p/bin/ollama" ] && [ -d "$p/lib/ollama" ]; then
    SRC_BIN="$p/bin/ollama"; SRC_LIB="$p/lib/ollama"; break
  fi
done
if [ -z "$SRC_BIN" ]; then
  pc_warn "could not locate the installed ollama bundle (bin+lib/ollama); install log tail:"
  tail -30 "$WORK/install.log" >&2
  exit 1
fi
pc_log "relocating ollama bundle from $(dirname "$SRC_BIN") to $PREFIX"

# Move the bundle into /opt/paperclip, preserving the bin <-> ../lib/ollama layout.
rm -rf "$LIB_DIR/ollama"; rm -f "$TARGET"
mv "$SRC_LIB" "$LIB_DIR/ollama"
# $SRC_BIN is the real binary (the installer only symlinks when prefix != PATH dir);
# cp -L dereferences just in case a future installer leaves a symlink there.
cp -L "$SRC_BIN" "$TARGET"
rm -f "$SRC_BIN"
chmod 0755 "$TARGET"
chmod -R a+rX "$LIB_DIR/ollama"

if [ "${OLLAMA_PRUNE_GPU:-1}" = "1" ]; then
  pc_log "OLLAMA_PRUNE_GPU=1 (default) — removing GPU runner dirs (cuda_*/rocm) for a CPU-only image"
  rm -rf "$LIB_DIR"/ollama/cuda_* "$LIB_DIR"/ollama/rocm* 2>/dev/null || true
fi

# Drop the container-useless artifacts the installer may have created.
rm -f /etc/systemd/system/ollama.service
id ollama >/dev/null 2>&1 && { userdel -r ollama 2>/dev/null || true; }

# Fail-LOUD verification: the relocated, standalone binary must actually run and
# resolve its runner libs via $ORIGIN/../lib/ollama.
if ! "$TARGET" --version >/dev/null 2>&1; then
  pc_warn "installed $TARGET but it does not execute"; exit 1
fi
pc_log "installed $("$TARGET" --version 2>&1 | tail -1) -> $TARGET (bundle $(du -sh "$LIB_DIR/ollama" | cut -f1))"
