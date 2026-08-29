#!/usr/bin/env bash
# Auto-réparation durable de l'adapter externe "antigravity_local".
#
# L'adapter (package @paperclip-custom/adapter-antigravity-local) est BAKÉ dans
# l'image sous /opt/paperclip/adapter-antigravity-local, mais Paperclip charge
# les adapters externes depuis le volume ./data (PAPERCLIP_HOME/adapter-plugins).
# Ce script, lancé à chaque boot (fail-SOFT), reconstitue tout ce qui doit
# vivre côté volume :
#   1) copie/maj du package dans <HOME>/adapter-plugins/node_modules/<pkg>
#   2) symlink @paperclipai -> node_modules du serveur (résolution ESM de
#      @paperclipai/adapter-utils depuis le package)
#   3) upsert du record dans <HOME>/adapter-plugins.json (chargé par
#      buildExternalAdapters au démarrage du serveur)
#
# Idempotent. Ne bloque JAMAIS le démarrage (aucun `set -e`). Survit aux
# rebuild / recreate / reboot ET à un wipe du volume (re-déploie depuis l'image).
# Même pattern que 40-register-junie-adapter.sh (même import
# @paperclipai/adapter-utils, donc même symlink requis).

set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="antigravity-adapter"
PC_ADAPTER_REGISTRY_LIB="$(dirname "$(readlink -f "$0")")/../lib/adapter-registry.js"

PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
IMAGE_PKG="/opt/paperclip/adapter-antigravity-local"
PKG_NAME="@paperclip-custom/adapter-antigravity-local"
ADAPTER_TYPE="antigravity_local"

PLUGINS_DIR="$PAPERCLIP_HOME/adapter-plugins"
NM_DIR="$PLUGINS_DIR/node_modules"
DEST_PKG="$NM_DIR/$PKG_NAME"
STORE="$PAPERCLIP_HOME/adapter-plugins.json"
SERVER_SCOPE="/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai"

log() { pc_log "$@"; }

# 1) Déployer / mettre à jour le package sur le volume depuis la copie image.
if [ -d "$IMAGE_PKG" ]; then
  mkdir -p "$DEST_PKG" || { log "mkdir $DEST_PKG échoué, ignoré"; }
  if [ -d "$DEST_PKG" ]; then
    # cp -u : ne réécrit que si la source image est plus récente (idempotent).
    cp -u "$IMAGE_PKG/package.json" "$IMAGE_PKG/index.js" "$DEST_PKG/" 2>/dev/null \
      && log "package synchronisé depuis l'image" \
      || log "synchro package partielle (ignoré)"
  fi
else
  log "copie image $IMAGE_PKG absente ; on s'appuie sur le volume s'il existe"
fi

# 2) Symlink @paperclipai pour la résolution ESM de @paperclipai/adapter-utils.
if [ -d "$SERVER_SCOPE" ]; then
  ln -sfn "$SERVER_SCOPE" "$NM_DIR/@paperclipai" 2>/dev/null \
    && log "symlink @paperclipai OK" \
    || log "symlink @paperclipai échoué (ignoré)"
else
  log "scope serveur $SERVER_SCOPE introuvable (bump de version ?) ; symlink ignoré"
fi

# 3) Upsert du record dans adapter-plugins.json (sans dépendance externe).
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
