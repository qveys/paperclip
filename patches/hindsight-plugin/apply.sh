#!/bin/sh
# Deploy the fixed Hindsight plugin build onto the running Paperclip volume.
#
# Replaces dist/manifest.js (format: "secret-ref" and secret_ref object schema)
# and dist/worker.js (multiCompanyConfig: true, per-company config resolution,
# and companyId + configPath passed to ctx.secrets.resolve).
#
# Idempotent and marker-gated: preserves .orig backups taken on first run.
set -eu

DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
TARGET_DIR="/paperclip/.paperclip/plugins/node_modules/@vectorize-io/hindsight-paperclip/dist"

[ -d "$TARGET_DIR" ] || { echo "[hindsight-plugin] plugin dir absent ($TARGET_DIR) — skipping"; exit 0; }

SRC_M="$DIR/manifest.js"
SRC_W="$DIR/worker.js"

for f in "$SRC_M" "$SRC_W"; do
  [ -f "$f" ] || { echo "[hindsight-plugin] missing source $f — skipping"; exit 0; }
done

# Take pristine backups once if not already taken
for n in manifest worker; do
  if [ ! -f "$TARGET_DIR/$n.js.orig" ] && [ -f "$TARGET_DIR/$n.js" ]; then
    cp "$TARGET_DIR/$n.js" "$TARGET_DIR/$n.js.orig"
  fi
done

# Check if already up-to-date
if grep -q 'multiCompanyConfig: true' "$TARGET_DIR/worker.js" 2>/dev/null && grep -q 'format: "secret-ref"' "$TARGET_DIR/manifest.js" 2>/dev/null; then
  echo "[hindsight-plugin] already up-to-date"
  exit 0
fi

cp "$SRC_M" "$TARGET_DIR/manifest.js"
cp "$SRC_W" "$TARGET_DIR/worker.js"
chown node:node "$TARGET_DIR/manifest.js" "$TARGET_DIR/worker.js" 2>/dev/null || true

echo "[hindsight-plugin] applied successfully (multiCompanyConfig + secret_ref support)"
exit 0
