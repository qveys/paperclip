#!/usr/bin/env bash
# Auto-réparation durable de l'adapter externe "hermes_local".
#
# L'adapter (@paperclip-custom/adapter-hermes-local) est BAKÉ dans l'image sous
# /opt/paperclip/adapter-hermes-local. Ce script, lancé à chaque boot (fail-SOFT),
# reconstitue côté volume :
#   1) copie/maj du package dans <HOME>/adapter-plugins/node_modules/<pkg>
#   2) symlink hermes-paperclip-adapter → server node_modules (résolution ESM)
#   3) upsert du record dans adapter-plugins.json (chargé par buildExternalAdapters)
#
# Idempotent — survit aux rebuild / recreate / reboot / wipe volume.

set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="hermes-adapter"
PC_ADAPTER_REGISTRY_LIB="$(dirname "$(readlink -f "$0")")/../lib/adapter-registry.js"

PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
IMAGE_PKG="/opt/paperclip/adapter-hermes-local"
PKG_NAME="@paperclip-custom/adapter-hermes-local"
ADAPTER_TYPE="hermes_local"

PLUGINS_DIR="$PAPERCLIP_HOME/adapter-plugins"
NM_DIR="$PLUGINS_DIR/node_modules"
DEST_PKG="$NM_DIR/$PKG_NAME"
STORE="$PAPERCLIP_HOME/adapter-plugins.json"
# hermes-paperclip-adapter is shipped scoped as @paperclipai/hermes-paperclip-adapter
SERVER_NM="/usr/local/lib/node_modules/paperclipai/node_modules"

log() { pc_log "$@"; }

# 1) Déployer / mettre à jour le package sur le volume depuis la copie image.
if [ -d "$IMAGE_PKG" ]; then
  mkdir -p "$DEST_PKG" || { log "mkdir $DEST_PKG échoué, ignoré"; }
  if [ -d "$DEST_PKG" ]; then
    rm -f "$DEST_PKG/index.js" "$DEST_PKG/package.json"; cp "$IMAGE_PKG/package.json" "$IMAGE_PKG/index.js" "$DEST_PKG/" 2>/dev/null \
      && log "package synchronisé depuis l'image" \
      || log "synchro package partielle (ignoré)"
  fi
else
  log "copie image $IMAGE_PKG absente ; on s'appuie sur le volume s'il existe"
fi

# 2) Symlink hermes-paperclip-adapter pour la résolution ESM.
# Le package est scopé @paperclipai/hermes-paperclip-adapter ; on le lie sans scope
# pour que l'import ESM "hermes-paperclip-adapter/server" se résolve correctement.
HERMES_ADAPTER_SRC="$SERVER_NM/@paperclipai/hermes-paperclip-adapter"
if [ -d "$HERMES_ADAPTER_SRC" ]; then
  ln -sfn "$HERMES_ADAPTER_SRC" "$NM_DIR/hermes-paperclip-adapter" 2>/dev/null \
    && log "symlink hermes-paperclip-adapter OK" \
    || log "symlink hermes-paperclip-adapter échoué (ignoré)"
else
  log "hermes-paperclip-adapter introuvable dans server node_modules (bump de version ?) ; symlink ignoré"
fi

# 3) Upsert du record dans adapter-plugins.json.
if [ -d "$DEST_PKG" ]; then
  STORE="$STORE" PKG_NAME="$PKG_NAME" ADAPTER_TYPE="$ADAPTER_TYPE" node <<NODE \
    && log "record upserté dans le store" \
    || log "upsert record échoué (ignoré)"
const { upsertAdapterRecord } = require("$PC_ADAPTER_REGISTRY_LIB");
upsertAdapterRecord(process.env.STORE, process.env.PKG_NAME, process.env.ADAPTER_TYPE);
NODE
else
  log "package absent du volume ; record non touché"
fi

log "terminé"
exit 0
