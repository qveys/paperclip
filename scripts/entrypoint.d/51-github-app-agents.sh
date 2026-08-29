#!/usr/bin/env bash
# Materialize per-agent GitHub App private keys at boot, from base64 vars in the
# environment (sourced from .env, itself decrypted from .env.enc via SOPS) into
# the .pem files the registry points at. Companion to 50-github-app.sh (which
# wires the *global* App); this one provisions the *per-agent* Apps declared in
# config/github-apps.json. github-app-token.sh then selects the right App per
# agent at mint time (keyed on PAPERCLIP_AGENT_ID).
#
# Idempotent + fail-soft: never blocks startup. Runs as user `node`, writing
# under /paperclip/.config (the ./data bind mount) — so it must run at runtime,
# not build time (image /paperclip is masked by the mount). Re-materializes on
# every boot => self-healing after a key rotation / re-encrypt / volume wipe.
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="github-app-agents"

REGISTRY="${GITHUB_APP_REGISTRY:-$(dirname "$(readlink -f "$0")")/../config/github-apps.json}"

if ! command -v jq >/dev/null 2>&1; then
  pc_warn "jq not found — skipping per-agent App key materialization"
  exit 0
fi
if [ ! -f "$REGISTRY" ]; then
  pc_warn "registry $REGISTRY not found — skipping"
  exit 0
fi

written=0 skipped=0
# Emit "<key_env>\t<key_file>" per agent; iterate without a subshell so counters
# survive (process substitution keeps the while loop in the current shell).
while IFS=$'\t' read -r key_env key_file; do
  [ -n "$key_env" ] && [ -n "$key_file" ] || continue

  # Indirect-expand the named env var; empty/unset => this agent falls back to
  # the global App, nothing to write.
  b64="${!key_env:-}"
  if [ -z "$b64" ]; then
    pc_warn "\$$key_env unset — $key_file not written (agent will use global App)"
    skipped=$((skipped + 1))
    continue
  fi

  dir="$(dirname "$key_file")"
  mkdir -p "$dir" 2>/dev/null || { pc_warn "cannot mkdir $dir — skipping"; skipped=$((skipped + 1)); continue; }
  chmod 700 "$dir" 2>/dev/null || true

  umask 077
  tmp="${key_file}.$$"
  if printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    chmod 600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$key_file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; pc_warn "cannot install $key_file"; skipped=$((skipped + 1)); continue; }
    written=$((written + 1))
  else
    rm -f "$tmp" 2>/dev/null || true
    pc_warn "base64 decode of \$$key_env failed — $key_file not written"
    skipped=$((skipped + 1))
  fi
done < <(jq -r '.agents | to_entries[] | select(.value.key_env and .value.key_file) | "\(.value.key_env)\t\(.value.key_file)"' "$REGISTRY" 2>/dev/null)

pc_log "per-agent App keys: $written written, $skipped skipped"
