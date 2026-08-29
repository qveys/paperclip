#!/usr/bin/env bash
# Wire GitHub App auth (my-paperclip-company) for paperclip agents at boot.
# Idempotent + fail-soft: never blocks startup. Runs as user `node`, so the
# global git config lands in /paperclip/.gitconfig (the ./data bind mount), which
# is why this must happen at runtime and not at build time (image /paperclip is
# masked by the mount). Cf. mémoire single-file-bind-mount-inode / paperclip-mcp-setup.
set -uo pipefail

# Shared logging helpers (pc_log/pc_warn). No anchor-patch here — just git config.
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="github-app"

PEM="${GITHUB_APP_PRIVATE_KEY_FILE:-/paperclip/.config/github-app/key.pem}"

if [ -z "${GITHUB_APP_ID:-}" ]; then
  pc_warn "GITHUB_APP_ID unset — skipping (no agent gh/git auth)"
  exit 0
fi
if [ ! -r "$PEM" ]; then
  pc_warn "private key $PEM not readable — skipping"
  exit 0
fi
chmod 600 "$PEM" 2>/dev/null || true

# git credential helper: mints an installation token on demand for github.com.
# The leading empty value resets any inherited/earlier helper for this host.
git config --global --unset-all 'credential.https://github.com.helper' 2>/dev/null || true
git config --global --add    'credential.https://github.com.helper' ''
git config --global --add    'credential.https://github.com.helper' '!/opt/paperclip/github-app-token.sh get'
git config --global 'credential.https://github.com.useHttpPath' false 2>/dev/null || true

# Commit identity = the App bot, so commits/pushes are attributed to the App.
slug="${GITHUB_APP_SLUG:-my-paperclip-company}"
git config --global user.name "${slug}[bot]" 2>/dev/null || true
if [ -n "${GITHUB_APP_BOT_USER_ID:-}" ]; then
  git config --global user.email "${GITHUB_APP_BOT_USER_ID}+${slug}[bot]@users.noreply.github.com" 2>/dev/null || true
else
  git config --global user.email "${slug}[bot]@users.noreply.github.com" 2>/dev/null || true
fi

pc_log "configured (app=${GITHUB_APP_ID}, helper + bot identity set)"
