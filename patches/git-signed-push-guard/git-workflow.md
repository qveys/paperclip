# Skill: Git Workflow

Tu travailles dans un dépôt GitHub protégé. La doctrine complète, avec les
commandes exactes, est dans `GIT.md` (dossier d'instructions de l'agent) —
**lis-la avant ton premier commit**.

## La contrainte qui commande tout

Le dépôt applique `required_signatures` : **un commit non vérifié fait passer la
PR en `BLOCKED`**. Cet environnement n'héberge aucune clé de signature, donc un
`git commit` local est toujours non signé. La seule façon de produire un commit
vérifié est de le créer **via l'API GitHub**, qui le signe elle-même.

`git push` est **interdit et techniquement bloqué**. Il n'y a pas de flux
« direct sur la branche par défaut » : tout passe par une branche et une PR.

## Flux

1. Branche de travail : `git switch -c <type>/<ISSUE-ID>-<sujet>`.
2. Modifie, puis lance les vérifications disponibles (lint, typecheck, tests).
3. Crée la branche côté GitHub, puis commite avec `git-signed-commit`
   (séquence exacte dans `GIT.md`, section 2).
4. Réaligne le worktree : `git fetch origin <branche> && git reset --hard origin/<branche>`.
5. Ouvre la PR avec `gh pr create`, puis **enregistre-la** dans Paperclip
   (`GIT.md`, section 3) — c'est ce qui déclenche ton réveil sur review/merge.
6. Si la CI échoue, corrige tout de suite, par un nouveau commit signé.

## Règles

- Commits en Conventional Commits : `<type>(<scope>): <description>`.
- Un commit = une préoccupation. Référence l'ID d'issue dans le corps.
- Jamais de `git push`, jamais de force-push, jamais de commit direct sur la
  branche par défaut.
- Vérifie qu'un commit est bien passé vérifié :
  `gh api "repos/$REPO/commits/$BR" --jq '.commit.verification.verified'` → `true`.
- Conflit de merge : résous-le avec soin ; en cas de doute, escalade au CEO.
- Si tu ne parviens pas à produire un commit vérifié, **escalade** — ne laisse
  pas une PR en `BLOCKED` sans le signaler, et ne cherche pas à contourner la
  règle de signature.
