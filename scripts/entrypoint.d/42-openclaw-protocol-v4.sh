#!/usr/bin/env bash
# boot step — patch openclaw-protocol-v4
#
# Ne contient AUCUNE logique : il exécute le payload qui vit sur le volume
# (data/patches/openclaw-protocol-v4/apply.sh -> /paperclip/patches/... au
# runtime), qui bascule @paperclipai/adapter-openclaw-gateway (global install
# + npx caches) de PROTOCOL_VERSION 3 à 4 — l'adaptateur 2026.626.0 hardcode
# v3, la gateway OpenClaw (>=2026.6.x) n'accepte que les connexions dont
# [minProtocol,maxProtocol] inclut 4. Idempotent (sed no-op si déjà patché
# ou si un futur adaptateur ships v4 nativement), donc c'est un entrypoint.d
# et pas un one-shot : réapplique après chaque `docker exec` de rebuild du
# node_modules (npx cache régénéré).
#
# Ce fichier avait été posé à la main via `docker exec` sur un container
# vivant (2026-07-04) : invisible dans le repo, donc perdu silencieusement
# au premier `make build` qui a suivi (2026-08-15) — exactement le symptôme
# documenté dans 52-git-signed-push-guard.sh. Ce commit le bake dans le repo
# pour qu'il survive aux rebuilds.
#
# Devient obsolète (et un no-op inoffensif) quand l'adaptateur upstream livre
# nativement PROTOCOL_VERSION 4 — supprimer ce hook et le payload à ce
# moment-là.
#
# Fail-soft : sort toujours 0.
set -uo pipefail

PAYLOAD=/paperclip/patches/openclaw-protocol-v4/apply.sh

if [ -x "$PAYLOAD" ]; then
  "$PAYLOAD" || echo "[42-openclaw-protocol-v4] payload en erreur — ignoré"
elif [ -f "$PAYLOAD" ]; then
  bash "$PAYLOAD" || echo "[42-openclaw-protocol-v4] payload en erreur — ignoré"
else
  echo "[42-openclaw-protocol-v4] payload absent: $PAYLOAD"
fi

exit 0
