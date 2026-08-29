#!/usr/bin/env bash
#
# neutralize-nested-plugin-sdk.sh
#
# Durable fix for plugin INVOCATION_SCOPE_DENIED.
#
# Symptom: a plugin worker loops on 502 "not allowed to perform state.get:
#   the worker referenced a missing, expired, or unknown invocation scope".
# Root cause: the plugin bundles its OWN nested copy of @paperclipai/plugin-sdk
#   (and /shared) under  <plugin>/node_modules/@paperclipai/. Node resolves the
#   worker's bare `import "@paperclipai/plugin-sdk"` to that nested copy instead
#   of the host-hoisted one. When the nested SDK predates the company-scoped
#   invocation handshake, it never attaches the scope token and the current host
#   rejects every bridge call (state.get, etc.).
#
# Invariant enforced here: EVERY plugin worker must resolve @paperclipai/{plugin-sdk,
#   shared} to the SINGLE host-hoisted copy. We:
#     (a) sync npm `overrides` in the plugins package.json to the live host SDK
#         version  -> any future plugin (re)install/update dedupes to the host
#         copy and never creates a nested one (durable across reinstall/update);
#     (b) neutralise (rename -> .sdkbak) any nested copy whose version differs
#         from the host  -> immediate cure for whatever is already on disk, and
#         the catch-all for SDKs vendored inside a published tarball (which
#         `overrides` cannot touch).
#
# Runs at every container boot from docker-entrypoint.sh, AFTER ./data is mounted
# — so it is durable across restart / recreate / rebuild, self-heals on a host
# version bump (it reads the host version dynamically), and re-applies after any
# plugin reinstall/update on the next boot. Idempotent. Fail-soft: it must never
# block application startup.
#
# Manual run / override for testing:
#   PLUGIN_NODE_MODULES=/path/to/node_modules ./neutralize-nested-plugin-sdk.sh
set -uo pipefail

# Shared logging helpers (pc_log). This here-doc rewrites package.json#overrides
# (not an anchor-patch), so it does NOT use lib/patch.js.
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="neutralize-nested-sdk"

PLUGROOT="${PLUGIN_NODE_MODULES:-/paperclip/.paperclip/plugins/node_modules}"
PKGJSON="${PLUGIN_PACKAGE_JSON:-$(dirname "$PLUGROOT")/package.json}"
HOIST_PKG="$PLUGROOT/@paperclipai/plugin-sdk/package.json"

log() { pc_log "$@"; }

# --- preconditions (all non-fatal: never block boot) -------------------------
if [ ! -d "$PLUGROOT" ]; then
  log "no plugin node_modules ($PLUGROOT) — nothing to do"
  exit 0
fi
if [ ! -f "$HOIST_PKG" ]; then
  log "WARN: no hoisted @paperclipai/plugin-sdk at $HOIST_PKG — skipping"
  exit 0
fi

HOST_VER="$(node -p "require('$HOIST_PKG').version" 2>/dev/null || true)"
if [ -z "$HOST_VER" ]; then
  log "WARN: cannot read host SDK version — skipping"
  exit 0
fi
log "host-hoisted @paperclipai/plugin-sdk = $HOST_VER"

# --- (a) sync npm overrides to the live host version -------------------------
# Pins @paperclipai/{plugin-sdk,shared} for every (transitive) dependency so a
# future `npm install` in this dir dedupes to the host copy. Idempotent: only
# rewrites package.json when the desired override differs from what's there.
if [ -f "$PKGJSON" ]; then
  PKGJSON="$PKGJSON" HOST_VER="$HOST_VER" node <<'NODE' || log "WARN: overrides sync failed (non-fatal)"
const fs = require('fs');
const file = process.env.PKGJSON;
const ver = process.env.HOST_VER;
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const ov = pkg.overrides || (pkg.overrides = {});
let changed = false;
for (const dep of ['@paperclipai/plugin-sdk', '@paperclipai/shared']) {
  if (ov[dep] !== ver) { ov[dep] = ver; changed = true; }
}
if (changed) {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[neutralize-nested-sdk] overrides synced to ' + ver + ' in ' + file);
} else {
  console.log('[neutralize-nested-sdk] overrides already at ' + ver);
}
NODE
else
  log "WARN: $PKGJSON not found — skipping overrides sync"
fi

# --- (b) neutralise nested copies that differ from the host ------------------
# Match only NESTED sdk copies (two node_modules in the path); the hoisted copy
# has a single node_modules and is intentionally left alone.
found_any=0
while IFS= read -r pkg; do
  found_any=1
  sdkdir="$(dirname "$pkg")"          # .../@paperclipai/plugin-sdk
  scopedir="$(dirname "$sdkdir")"     # .../@paperclipai
  ver="$(node -p "require('$pkg').version" 2>/dev/null || echo '?')"
  if [ "$ver" = "$HOST_VER" ]; then
    log "ok (matches host): $sdkdir [$ver]"
    continue
  fi
  for mod in plugin-sdk shared; do
    src="$scopedir/$mod"
    if [ -d "$src" ] && [ ! -e "$src.sdkbak" ]; then
      if mv "$src" "$src.sdkbak"; then
        log "neutralised: $src [$ver != host $HOST_VER] -> $src.sdkbak"
      else
        log "WARN: failed to rename $src (permissions?) — leaving as-is"
      fi
    fi
  done
done < <(find "$PLUGROOT" -path '*/node_modules/*/node_modules/@paperclipai/plugin-sdk/package.json' 2>/dev/null)

[ "$found_any" = "0" ] && log "no nested @paperclipai/plugin-sdk found — all clean"
log "done"
exit 0
