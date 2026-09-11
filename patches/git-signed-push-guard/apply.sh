#!/usr/bin/env bash
set -euo pipefail
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# GIT.md est déposé À CÔTÉ de l'AGENTS.md de l'agent — c'est ce que promet le
# renvoi ajouté dans AGENTS.md ("apply GIT.md (same folder)"), et ça couvre les
# deux dispositions rencontrées en prod : agent à plat (AGENTS.md à la racine
# du home, cas MyHousekeeper) et agent dont tout le doctrine vit dans un
# sous-dossier (cas des companies identifiées par UUID).
#
# Ne PAS revenir à `find -type d -path "*/companies/*/agents/*"` + `mkdir -p
# "$agent_dir/instructions"` : les `*` d'un -path traversent les `/`, donc ce
# motif matchait TOUT dossier sous agents/ — y compris les instructions/ créés
# au boot précédent. Résultat : un niveau d'imbrication de plus à chaque
# démarrage du conteneur (1799 dossiers redondants / 3598 fichiers dupliqués
# constatés le 2026-09-11, profondeur 26).
#
# Contrepartie assumée : un agent sans AGENTS.md ne reçoit pas GIT.md. Il n'a
# de toute façon rien pour y renvoyer.
for INSTANCES_DIR in "/paperclip/instances" "/app/data/instances"; do
  [ -d "$INSTANCES_DIR" ] || continue
  find "$INSTANCES_DIR" -type f -path "*/companies/*/agents/*" -name AGENTS.md | while read -r agents_md; do
    home_dir="$(dirname "$agents_md")"
    cp "$PATCH_DIR/GIT.md" "$home_dir/GIT.md"
    cp "$PATCH_DIR/git-workflow.md" "$home_dir/git-workflow.md"
  done
done
