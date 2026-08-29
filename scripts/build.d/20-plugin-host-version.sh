#!/usr/bin/env bash
#
# patch-plugin-host-version.sh
#
# Report the REAL host version to the plugin compatibility gate.
#
# Bug in the shipped build: index.js calls createApp(db, {...}) WITHOUT passing
# `hostVersion`, so app.js falls back to the hardcoded literal:
#     hostVersion: opts.hostVersion ?? "0.0.0",
# The plugin loader (services/plugin-loader.js, step 6) then compares a plugin's
# declared minimum host version against "0.0.0" and rejects any plugin that
# requires a real version, e.g.:
#     "Plugin tomismeta.paperclip-aperture requires host version 2026.525.0 or
#      newer, but this server is running 0.0.0"
# even though the server genuinely IS 2026.609.0 (>= 2026.525.0).
#
# Fix: replace the "0.0.0" fallback with the actual server version, read at build
# time from @paperclipai/server/package.json (the authoritative version of the
# image we are building). `opts.hostVersion ?? <ver>` still honours an explicit
# value if a future build starts wiring one through.
#
# Build-time, idempotent, fail-loud: if the anchor disappears on an upstream bump
# (and the patch marker is absent), the build FAILS instead of silently shipping
# an image that rejects version-gated plugins.
set -euo pipefail

# Shared helpers (pc_die) + constants (PC_SERVER_DIST_DEFAULT) + the anchor-patch
# engine (lib/patch.js, require'd from the here-doc below).
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="host-version"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

BASE="${PAPERCLIP_SERVER_DIST:-$PC_SERVER_DIST_DEFAULT}"
APP="${APP_OVERRIDE:-$BASE/app.js}"
PKG="${PKG_OVERRIDE:-$BASE/../package.json}"

for f in "$APP" "$PKG"; do
  [ -f "$f" ] || pc_die "target not found: $f"
done

APP_FILE="$APP" PKG_FILE="$PKG" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE'
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const MARKER = 'PAPERCLIP_HOST_VERSION_PATCH';
const app = process.env.APP_FILE;
const ver = require(process.env.PKG_FILE).version;

if (!ver || ver === '0.0.0') {
  console.error('[host-version] FATAL: server package.json version is missing/0.0.0 ("' + ver + '") — cannot derive host version.');
  process.exit(1);
}

applyPatch({
  file: app,
  marker: MARKER,
  mode: 'loud',
  prefix: 'host-version',
  edits: [{
    anchor: 'hostVersion: opts.hostVersion ?? "0.0.0",',
    replacement: 'hostVersion: opts.hostVersion ?? "' + ver + '", /* ' + MARKER + ': real server version, was "0.0.0" */',
  }],
});
NODE
