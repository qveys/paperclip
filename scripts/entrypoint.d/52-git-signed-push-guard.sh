#!/usr/bin/env bash
# boot step — patch git-signed-push-guard
#
# Ne contient AUCUNE logique : il exécute le payload qui vit sur le volume
# (data/patches/git-signed-push-guard/apply.sh -> /paperclip/patches/... au
# runtime), qui dépose GIT.md à côté de l'AGENTS.md de chaque agent, ajoute le
# renvoi dans AGENTS.md, et corrige le skill git-workflow.md. Réapplique donc
# la doctrine aux agents créés depuis le dernier boot — c'est pour ça que
# c'est un entrypoint.d et pas un one-shot.
#
# L'autre moitié du patch (le shim `git` qui bloque `git push`) est côté
# image, installée par build.d/120-git-signed-push-guard-shim.sh — CE fichier
# et le shim sont désormais tous les deux bakés via le Dockerfile, donc
# survivent aux rebuilds. Avant ce commit, le shim avait été posé à la main
# via `docker cp` sur un container vivant : invisible dans le repo, donc perdu
# au rebuild suivant, silencieusement — exactement le symptôme qui a motivé ce
# commit ("Commits must have verified signatures" sur les PR d'agents).
#
# Fail-soft : sort toujours 0.
set -uo pipefail

PAYLOAD=/paperclip/patches/git-signed-push-guard/apply.sh

if [ -x "$PAYLOAD" ]; then
  "$PAYLOAD" || echo "[52-git-signed-push-guard] payload en erreur — ignoré"
elif [ -f "$PAYLOAD" ]; then
  bash "$PAYLOAD" || echo "[52-git-signed-push-guard] payload en erreur — ignoré"
else
  echo "[52-git-signed-push-guard] payload absent: $PAYLOAD"
fi

exit 0
