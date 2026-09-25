#!/usr/bin/env bash
# Wire GitHub App auth (my-paperclip-company) for paperclip agents at boot.
# Idempotent + fail-soft: never blocks startup. The global git config lands in
# $HOME/.gitconfig, which must resolve inside the ./data volume (HOME=/app/data
# in .env) — which is why this must happen at runtime and not at build time (the
# image's own copy is masked by the mount). Cf. mémoire
# single-file-bind-mount-inode / paperclip-mcp-setup.
#
# Four things happen here, in order:
#   1. resolve the App binding (container env, else the generated config file),
#   2. re-generate that config file from the env, because the *agent* runtime env
#      does not inherit GITHUB_APP_* — without the file every agent-side mint
#      aborts at github-app-token.sh's `:?` guard before touching api.github.com
#      (that was MYH-203: 11 days blamed on lost App auth, actually this),
#   3. install the credential helper + bot identity,
#   4. prove the binding works by actually minting a token (MYH-337), so a broken
#      binding is a visible boot warning instead of an agent-level mystery days
#      later.
set -uo pipefail

# Shared logging helpers (pc_log/pc_warn). No anchor-patch here — just git config.
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="github-app"

TOKEN_HELPER=/opt/paperclip/bin/github-app-token.sh
CFG="${GITHUB_APP_CONFIG:-${HOME:-/paperclip}/.config/github-app/config}"

# --- 1. resolve the binding: env first, config file as fallback ---------------
# Only consulted when the env is silent, so the container env stays authoritative
# and a stale generated file can never shadow it.
if [ -z "${GITHUB_APP_ID:-}" ] && [ -f "$CFG" ]; then
  # shellcheck disable=SC1090
  . "$CFG" 2>/dev/null || pc_warn "could not source $CFG"
fi

PEM="${GITHUB_APP_PRIVATE_KEY_FILE:-/paperclip/.config/github-app/key.pem}"

if [ -z "${GITHUB_APP_ID:-}" ]; then
  pc_warn "GITHUB_APP_ID unset in env and absent from $CFG — skipping (no agent gh/git auth)"
  exit 0
fi
if [ ! -r "$PEM" ]; then
  pc_warn "private key $PEM not readable — skipping"
  exit 0
fi
chmod 600 "$PEM" 2>/dev/null || true

slug="${GITHUB_APP_SLUG:-my-paperclip-company}"

# --- 2. materialize the binding for the agent runtime ------------------------
# Agents get a curated env that drops GITHUB_APP_*, so this on-disk file is the
# only channel that reaches them. Regenerated every boot => self-healing after a
# volume wipe or a key rotation, with the container env as the source of truth.
# NOTE: deliberately NOT next to key.pem — that directory is a read-only bind
# mount (compose mounts ./data/.config/github-app :ro).
cfg_dir="$(dirname "$CFG")"
if mkdir -p "$cfg_dir" 2>/dev/null; then
  chmod 700 "$cfg_dir" 2>/dev/null || true
  tmp="${CFG}.$$"
  (
    umask 077
    {
      printf '%s\n' \
        "# github-app-token.sh App config — GENERATED AT BOOT by entrypoint.d/50-github-app.sh." \
        "# Do not hand-edit: every restart overwrites it from the container env." \
        "# NON-SECRET: app id / installation id / account / slug / key path only." \
        "# The private key stays at GITHUB_APP_PRIVATE_KEY_FILE (SOPS -> bind mount)." \
        "#" \
        "# Why this file exists: the agent runtime env does not inherit GITHUB_APP_*," \
        "# so without it every agent-side token mint aborts at the ':?' guard in" \
        "# github-app-token.sh before ever reaching api.github.com (MYH-203/MYH-337)." \
        "#" \
        "# ':=' (not plain assignment) so the documented \"env wins over file\" contract" \
        "# in github-app-token.sh holds when the container env does supply these."
      printf ': "${%s:=%s}"\n' \
        GITHUB_APP_ID               "$GITHUB_APP_ID" \
        GITHUB_APP_PRIVATE_KEY_FILE "$PEM" \
        GITHUB_APP_SLUG             "$slug"
      for v in GITHUB_APP_INSTALLATION_ID GITHUB_APP_ACCOUNT GITHUB_APP_BOT_USER_ID; do
        if [ -n "${!v:-}" ]; then
          printf ': "${%s:=%s}"\n' "$v" "${!v}"
        fi
      done
    } >"$tmp"
  ) 2>/dev/null
  if [ -s "$tmp" ]; then
    chmod 600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$CFG" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; pc_warn "cannot install $CFG"; }
  else
    rm -f "$tmp" 2>/dev/null || true
    pc_warn "could not write $CFG — agents may not resolve the App"
  fi
else
  pc_warn "cannot create $cfg_dir — agents may not resolve the App"
fi

# --- 3a. git credential helper ------------------------------------------------
# Mints an installation token on demand. The leading empty value resets any
# inherited/earlier helper for this host — including the
# `!/usr/bin/gh auth git-credential` that `gh auth setup-git` installs, which
# bypasses the /opt/paperclip/bin/gh shim and so never receives a GH_TOKEN
# (MYH-337). The gh shim now intercepts `gh auth setup-git` to stop that
# recurring mid-boot-cycle.
for host in github.com gist.github.com; do
  git config --global --unset-all "credential.https://${host}.helper" 2>/dev/null || true
  git config --global --add    "credential.https://${host}.helper" ''
  git config --global --add    "credential.https://${host}.helper" "!${TOKEN_HELPER} get"
  git config --global "credential.https://${host}.useHttpPath" false 2>/dev/null || true
done

# --- 3b. commit identity = the App bot, so commits/pushes attribute to the App -
git config --global user.name "${slug}[bot]" 2>/dev/null || true
if [ -n "${GITHUB_APP_BOT_USER_ID:-}" ]; then
  git config --global user.email "${GITHUB_APP_BOT_USER_ID}+${slug}[bot]@users.noreply.github.com" 2>/dev/null || true
else
  git config --global user.email "${slug}[bot]@users.noreply.github.com" 2>/dev/null || true
fi

pc_log "configured (app=${GITHUB_APP_ID}, installation=${GITHUB_APP_INSTALLATION_ID:-auto}, helper + bot identity set)"

# --- 4. self-check: actually mint a token -------------------------------------
# Everything above is local config, so it "succeeds" even when the binding is
# broken. Minting is the only check that exercises app id + installation id + key
# + proxy egress together. Bounded and fail-soft: worst case it adds ~25s to a
# boot that is already broken, and it never changes the exit status.
#
# Own cache dir, discarded afterwards: this step runs as root (pre-`gosu node`),
# and a root-owned 0600 cache file in /tmp would make every later agent mint fall
# back to uncached minting. PAPERCLIP_AGENT_ID is cleared so the per-agent App
# registry cannot redirect the check away from the global App.
# `-p /tmp` fallback: a TMPDIR pointing at a directory that does not exist yet
# would otherwise skip the check silently — the exact class of invisible gap this
# self-check was added to close.
selfcheck_cache="$(mktemp -d 2>/dev/null || mktemp -d -p /tmp 2>/dev/null || true)"
if [ -n "$selfcheck_cache" ]; then
  if tok="$(GITHUB_APP_CACHE_DIR="$selfcheck_cache" \
            GITHUB_APP_CONFIG="$CFG" \
            PAPERCLIP_AGENT_ID= \
            timeout 25 "$TOKEN_HELPER" 2>&1)" && [ "${tok#ghs_}" != "$tok" ]; then
    # Prove the token is usable, not merely well-formed: a suspended or
    # uninstalled App can still get this far. Best-effort, short timeout.
    repos="$(curl -sS --max-time 15 \
               -H "Authorization: token $tok" \
               -H "Accept: application/vnd.github+json" \
               "https://api.github.com/installation/repositories?per_page=1" 2>/dev/null \
             | jq -r '.total_count // "?"' 2>/dev/null || true)"
    pc_log "self-check OK — minted an installation token as ${slug}[bot] (repos accessible: ${repos:-?})"
  else
    # On failure $tok holds stderr, never a token. Truncated anyway so a stray
    # response body cannot be logged in full.
    pc_warn "self-check FAILED — cannot mint an installation token: $(printf '%.300s' "${tok:-no output}")"
    pc_warn "agent gh/git/PR operations will be unauthenticated until this is fixed"
  fi
  rm -rf "$selfcheck_cache" 2>/dev/null || true
else
  pc_warn "self-check skipped (no writable temp dir)"
fi

exit 0
