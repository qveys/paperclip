#!/usr/bin/env bash
# github-app-token — mint a short-lived GitHub App *installation access token*
# from an App ID + private key, with on-disk caching. Used by:
#   - the `gh` shim (exported as GH_TOKEN)
#   - git's credential helper (mode "get": prints username/password)
#
# Why openssl+curl and not @octokit/auth-app: the paperclip container egress is
# proxy-only (Squid). curl honours HTTP(S)_PROXY automatically; octokit's undici
# fetch ignores the proxy env and would fail to reach api.github.com in-container.
# This script is identical on host and in the container.
#
# Config (env vars, or a config file sourced from $GITHUB_APP_CONFIG /
# ~/.config/github-app/config — env wins over file):
#   GITHUB_APP_ID                 (required) numeric App ID
#   GITHUB_APP_PRIVATE_KEY_FILE   (required) path to the .pem private key
#   GITHUB_APP_INSTALLATION_ID    (recommended) installation id; if unset it is
#                                 auto-derived (no cross-call cache then)
#   GITHUB_APP_ACCOUNT            (optional) org/user login to pick the right
#                                 installation when auto-deriving
#   GITHUB_APP_CACHE_DIR          (optional) defaults to $TMPDIR or /tmp
#
# Per-agent Apps: if PAPERCLIP_AGENT_ID (injected in each agent's runtime env)
# matches an entry in the registry ($GITHUB_APP_REGISTRY, default
# /opt/paperclip/config/github-apps.json), that agent's own App overrides the
# ambient (global) App config below. Agents with no registry entry keep minting
# the global App, so the Operator and other companies are unaffected. This is the
# single lever that makes commits/pushes/gh/PR-comments attribute per agent — the
# gh shim and git's credential helper both route through this script.
#
# Usage:
#   github-app-token            -> prints the raw installation token
#   github-app-token get        -> git credential helper format (username/password)
#   github-app-token store|erase-> no-op (git credential protocol)
set -euo pipefail

MODE="${1:-token}"
case "$MODE" in
  store|erase) exit 0 ;;  # git credential protocol: nothing to persist
esac

# --- load config -------------------------------------------------------------
CFG="${GITHUB_APP_CONFIG:-$HOME/.config/github-app/config}"
if [ -f "$CFG" ]; then
  # shellcheck disable=SC1090
  . "$CFG"
fi

# --- per-agent App override (keyed on PAPERCLIP_AGENT_ID) ---------------------
# The registry maps an agent UUID -> its dedicated App. When the current agent
# has an entry, its App wins over the ambient/global env (loaded above). Agents
# absent from the registry fall through unchanged -> the global App. Best-effort:
# any lookup error leaves the global config intact (fail-open to global).
REGISTRY="${GITHUB_APP_REGISTRY:-/opt/paperclip/config/github-apps.json}"
if [ -n "${PAPERCLIP_AGENT_ID:-}" ] && [ -f "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
  entry=$(jq -c --arg id "$PAPERCLIP_AGENT_ID" '.agents[$id] // empty' "$REGISTRY" 2>/dev/null || true)
  if [ -n "$entry" ]; then
    _v=$(jq -r '.app_id // empty'          <<<"$entry"); [ -n "$_v" ] && GITHUB_APP_ID="$_v"
    _v=$(jq -r '.installation_id // empty' <<<"$entry"); [ -n "$_v" ] && GITHUB_APP_INSTALLATION_ID="$_v"
    _v=$(jq -r '.key_file // empty'        <<<"$entry"); [ -n "$_v" ] && GITHUB_APP_PRIVATE_KEY_FILE="$_v"
    _v=$(jq -r '.account // empty'         <<<"$entry"); [ -n "$_v" ] && GITHUB_APP_ACCOUNT="$_v"
    unset _v
  fi
fi

: "${GITHUB_APP_ID:?GITHUB_APP_ID not set (env or $CFG)}"
: "${GITHUB_APP_PRIVATE_KEY_FILE:?GITHUB_APP_PRIVATE_KEY_FILE not set (env or $CFG)}"
[ -r "$GITHUB_APP_PRIVATE_KEY_FILE" ] || { echo "github-app-token: cannot read key $GITHUB_APP_PRIVATE_KEY_FILE" >&2; exit 1; }

API="https://api.github.com"
CACHE_DIR="${GITHUB_APP_CACHE_DIR:-${TMPDIR:-/tmp}}"
INST="${GITHUB_APP_INSTALLATION_ID:-}"

b64url() { openssl base64 -A | tr -d '=' | tr '/+' '_-'; }

emit() { # $1 = token
  if [ "$MODE" = "get" ]; then
    printf 'username=x-access-token\npassword=%s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# --- cache hit? (only when installation id is known up-front) -----------------
cache_file=""
if [ -n "$INST" ]; then
  cache_file="$CACHE_DIR/.gh-app-token-${GITHUB_APP_ID}-${INST}.json"
  if [ -f "$cache_file" ]; then
    exp=$(jq -r '.expires_epoch // 0' "$cache_file" 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ "$exp" -gt "$((now + 300))" ]; then
      emit "$(jq -r '.token' "$cache_file")"
      exit 0
    fi
  fi
fi

# --- build the App JWT (RS256) -----------------------------------------------
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$GITHUB_APP_ID" | b64url)
signing_input="${header}.${payload}"
sig=$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$GITHUB_APP_PRIVATE_KEY_FILE" -binary | b64url)
jwt="${signing_input}.${sig}"

gh_api() { # $1=method $2=path
  curl -sS --fail-with-body --max-time 30 -X "$1" \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API}${2}"
}

# --- derive installation id if needed ----------------------------------------
if [ -z "$INST" ]; then
  insts=$(gh_api GET /app/installations)
  INST=$(jq -r --arg a "${GITHUB_APP_ACCOUNT:-}" \
    'if $a=="" then (.[0].id) else (map(select(.account.login==$a))[0].id) end // empty' <<<"$insts")
  [ -n "$INST" ] || { echo "github-app-token: no installation found (account='${GITHUB_APP_ACCOUNT:-}')" >&2; exit 1; }
  cache_file="$CACHE_DIR/.gh-app-token-${GITHUB_APP_ID}-${INST}.json"
fi

# --- mint the installation access token ---------------------------------------
resp=$(gh_api POST "/app/installations/${INST}/access_tokens")
token=$(jq -r '.token // empty' <<<"$resp")
expires_at=$(jq -r '.expires_at // empty' <<<"$resp")
[ -n "$token" ] || { echo "github-app-token: mint failed: $resp" >&2; exit 1; }

# --- cache (best effort) ------------------------------------------------------
if [ -n "$cache_file" ]; then
  exp_epoch=$(date -d "$expires_at" +%s 2>/dev/null || echo 0)
  umask 077
  tmp="${cache_file}.$$"
  jq -n --arg t "$token" --argjson e "$exp_epoch" '{token:$t, expires_epoch:$e}' >"$tmp" 2>/dev/null \
    && mv -f "$tmp" "$cache_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
fi

emit "$token"
