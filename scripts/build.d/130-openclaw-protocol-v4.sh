#!/usr/bin/env bash
# 130-openclaw-protocol-v4.sh — bump the GLOBAL @paperclipai/adapter-openclaw-gateway
# install to gateway protocol v4 at build time (root).
#
# WHY build.d/ and not entrypoint.d/: entrypoint.d/42-openclaw-protocol-v4.sh runs
# as the non-root `node` user, but this install lives under
# /usr/local/lib/node_modules/paperclipai/... (root:root, from `npm install -g`
# during the base image build) — `sed -i` there fails with "Permission denied"
# creating its temp file, SILENTLY (docker-entrypoint.sh is fail-soft by design,
# so the warning scrolls by unnoticed in boot logs). Exactly the bug that reset
# this adapter back to PROTOCOL_VERSION=3 after a 2026-08-15 rebuild — the
# runtime hook had only ever "worked" because the global install had been
# hand-patched once via `docker exec -u root` and happened to survive until
# that rebuild reset it.
#
# The npx-cache copies (/paperclip/.npm/_npx/*/node_modules/@paperclipai/...,
# owned by `node` since they're populated at runtime) stay covered by the
# entrypoint.d hook + /paperclip/patches/openclaw-protocol-v4/apply.sh — that
# path doesn't exist at build time, so it can't be handled here.
#
# Adapter 2026.626.0 hardcodes v3; the OpenClaw gateway on macbook-openclaw
# (>=2026.6.x) only accepts connects whose [minProtocol,maxProtocol] includes 4.
# Becomes an idempotent no-op once upstream ships v4 natively — remove this step
# and the entrypoint.d/data/patches counterparts then.
#
# Fail-LOUD: shipping the image with this still at v3 breaks the Orchestrator's
# openclaw_gateway adapter silently until the next agent run fails — don't ship
# that quietly.
set -euo pipefail

ADIR="/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/adapter-openclaw-gateway/dist"

[ -f "$ADIR/server/execute.js" ] || {
  echo "130-openclaw-protocol-v4: adapter introuvable, rien à patcher: $ADIR" >&2
  exit 0
}

if grep -q "PROTOCOL_VERSION = 4" "$ADIR/server/execute.js"; then
  echo "130-openclaw-protocol-v4: déjà en v4 (adapter upstream à jour ?) -> $ADIR"
  exit 0
fi

sed -i 's/const PROTOCOL_VERSION = 3;/const PROTOCOL_VERSION = 4;/' "$ADIR/server/execute.js"
sed -i 's/minProtocol: 3,/minProtocol: 4,/; s/maxProtocol: 3,/maxProtocol: 4,/' "$ADIR/server/test.js"

grep -q "PROTOCOL_VERSION = 4" "$ADIR/server/execute.js" || {
  echo "130-openclaw-protocol-v4: sed n'a pas pris sur execute.js — adapter a peut-être changé" >&2
  exit 1
}

echo "130-openclaw-protocol-v4: adapter patché -> v4 ($ADIR)"
