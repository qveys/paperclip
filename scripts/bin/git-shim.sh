#!/usr/bin/env bash
# git — shim Paperclip (patch: git-signed-push-guard)
#
# Pourquoi : ce conteneur n'héberge aucune clé de signature (pas de ~/.ssh,
# pas de gpg). Tout commit créé localement sort donc NON signé, et un
# `git push` le fait atterrir sur un dépôt protégé par `required_signatures`
# → la PR passe en BLOCKED, silencieusement, et il faut re-signer à la main.
#
# Ce shim transforme cet échec silencieux et tardif en échec immédiat et
# explicite : `git push` est refusé, avec la marche à suivre. Le commit
# vérifié se fait par `git-signed-commit` (mutation GraphQL
# createCommitOnBranch : c'est GitHub qui signe).
#
# Toute autre sous-commande est passée telle quelle à /usr/bin/git.
# Échappatoire opérateur : PAPERCLIP_ALLOW_UNSIGNED_PUSH=1 git push ...
#
# /opt/paperclip/bin précède /usr/bin dans le PATH du conteneur : ce fichier
# masque donc /usr/bin/git pour les agents. Même pattern que le shim `gh`.
set -uo pipefail

REAL=/usr/bin/git

# Repérer la sous-commande en sautant les options globales de git.
# En cas de doute on laisse passer (fail-open) : ne jamais casser git.
sub=""
i=1
while [ "$i" -le "$#" ]; do
  a="${!i}"
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace)
      i=$((i + 2)); continue ;;
    -*)
      i=$((i + 1)); continue ;;
    *)
      sub="$a"; break ;;
  esac
done

if [ "$sub" = "push" ] && [ "${PAPERCLIP_ALLOW_UNSIGNED_PUSH:-0}" != "1" ]; then
  cat >&2 <<'MSG'
git push est BLOQUÉ dans cet environnement.

Aucune clé de signature n'existe ici : un commit poussé par git est non signé,
et les dépôts exigent des commits vérifiés (required_signatures). La PR
partirait en BLOCKED.

Publie par l'API GitHub, qui signe le commit pour toi :

  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
  BR=$(git rev-parse --abbrev-ref HEAD)

  # la branche doit exister sur GitHub :
  gh api "repos/$REPO/branches/$BR" >/dev/null 2>&1 || \
    gh api "repos/$REPO/git/refs" -f ref="refs/heads/$BR" \
      -f sha="$(gh api "repos/$REPO/git/ref/heads/$BASE" --jq .object.sha)"

  # git-signed-commit lit le WORKING TREE, pas les commits locaux :
  git log --oneline "origin/$BR..HEAD" | grep -q . && git reset --soft "origin/$BR"
  git add -A
  git-signed-commit -m "type(scope): sujet"
  git fetch origin "$BR" && git reset --hard "origin/$BR"

Détail complet : instructions/GIT.md
MSG
  exit 1
fi

exec "$REAL" "$@"
