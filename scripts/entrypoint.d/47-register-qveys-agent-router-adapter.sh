#!/usr/bin/env bash
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="qveys-router-adapter"
PC_ADAPTER_REGISTRY_LIB="$(dirname "$(readlink -f "$0")")/../lib/adapter-registry.js"

PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
IMAGE_PKG="/opt/paperclip/adapter-qveys-agent-router"
PKG_NAME="@paperclip-custom/adapter-qveys-agent-router"
ADAPTER_TYPE="qveys_agent_router"
PLUGINS_DIR="$PAPERCLIP_HOME/adapter-plugins"
NM_DIR="$PLUGINS_DIR/node_modules"
DEST_PKG="$NM_DIR/$PKG_NAME"
STORE="$PAPERCLIP_HOME/adapter-plugins.json"

mkdir -p "$DEST_PKG" || { pc_log "mkdir $DEST_PKG échoué"; exit 0; }
rm -f "$DEST_PKG/package.json" "$DEST_PKG/index.js" "$DEST_PKG/ui-parser.cjs"
cp "$IMAGE_PKG/package.json" "$IMAGE_PKG/index.js" "$IMAGE_PKG/ui-parser.cjs" "$DEST_PKG/" 2>/dev/null \
  && pc_log "package synchronisé depuis l'image (index+ui-parser)" \
  || pc_log "synchro package partielle (ignoré)"

if [ -d "$DEST_PKG" ]; then
  STORE="$STORE" PKG_NAME="$PKG_NAME" ADAPTER_TYPE="$ADAPTER_TYPE" node <<NODE \
    && pc_log "record upserté dans le store" \
    || pc_log "upsert record échoué (ignoré)"
const { upsertAdapterRecord } = require("$PC_ADAPTER_REGISTRY_LIB");
upsertAdapterRecord(process.env.STORE, process.env.PKG_NAME, process.env.ADAPTER_TYPE);
NODE
fi

pc_log "terminé"
exit 0
