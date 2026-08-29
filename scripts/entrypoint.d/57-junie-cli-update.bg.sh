#!/usr/bin/env bash
# 57-junie-cli-update.bg.sh
#
# Keeps the JetBrains Junie CLI binary at (or above) MIN_VERSION at every boot.
#
# The base image ships Junie 1831.35 (26.06.01), whose standalone custom-model
# path (`--model custom:...`, used by junie_local to reach Omniroute via
# entrypoint.d/56-junie-omniroute-models.sh) is broken: it fails locally with
# "Authorization failed. Check the credentials." BEFORE any network request is
# even attempted, regardless of apiKey value/syntax, apiType, or baseUrl
# (confirmed live: a local unauthenticated echo server on 127.0.0.1 received
# zero requests across every variant tested). Confirmed fixed in 2651.3
# (26.8.10) via the official installer -- same profile then round-trips a real
# request through Omniroute successfully.
#
# junie's CLI binary lives under $HOME/.local/{bin,share/junie} -- on the
# ./data volume, NOT baked into the image -- so it reverts to the old bundled
# version on a from-scratch rebuild (volume wipe). This script re-applies the
# fix on every boot. Runs in the background (network download) so it never
# delays agent readiness. Fail-soft: never blocks container startup.
#
# Log: /tmp/entrypoint-57-junie-cli-update.log

set -uo pipefail
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="junie-cli-update"

MIN_VERSION="2651.3"
INSTALL_URL="https://junie.jetbrains.com/install.sh"

if ! command -v junie >/dev/null 2>&1; then
  pc_log "commande junie introuvable, rien à mettre à jour"
  exit 0
fi

current_version="$(junie --list-versions 2>/dev/null | awk '/\(current\)/{print $1}')"
if [ -z "$current_version" ]; then
  pc_warn "impossible de déterminer la version courante de junie, on tente quand même l'installateur"
elif [ "$(printf '%s\n%s\n' "$MIN_VERSION" "$current_version" | sort -V | tail -1)" = "$current_version" ]; then
  pc_log "junie déjà à jour (version=$current_version >= $MIN_VERSION), rien à faire"
  exit 0
else
  pc_log "junie obsolète (version=$current_version < $MIN_VERSION), mise à jour en cours"
fi

installer="$(mktemp /tmp/junie-install.XXXXXX.sh)" || { pc_warn "mktemp échoué, abandon"; exit 0; }
trap 'rm -f "$installer"' EXIT

if ! curl -fsSL "$INSTALL_URL" -o "$installer"; then
  pc_warn "téléchargement de $INSTALL_URL échoué, ignoré (junie reste en $current_version)"
  exit 0
fi

if bash "$installer"; then
  new_version="$(junie --list-versions 2>/dev/null | awk '/\(current\)/{print $1}')"
  pc_log "junie mis à jour avec succès (version=${new_version:-inconnue})"
else
  pc_warn "l'installateur junie a échoué, ignoré (junie reste en $current_version)"
fi

exit 0
