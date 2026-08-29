# GIT.md — Règles & Commits

## 1. Règle d'or

- Les dépôts appliquent une règle **`required_signatures`** : tout commit non vérifié fait passer la PR en `BLOCKED`. Cette règle ne sera **pas** désactivée et n'a **pas** de dérogation.
- Cet environnement ne contient **aucune clé de signature** (pas de `~/.ssh`, pas de `gpg`) : un `git commit` local sort **toujours** non signé.
- Le seul moyen de produire un commit vérifié est le helper **`git-signed-commit`**, qui crée le commit **via l'API GitHub** — c'est GitHub qui le signe, avec l'identité de la GitHub App.
- **`git push` est interdit** et techniquement bloqué : il échouera avec un message te renvoyant ici.

## 2. Publier du travail — la séquence complète

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
BR=$(git rev-parse --abbrev-ref HEAD)

# 2.1 — La branche doit exister SUR GitHub avant tout commit signé.
gh api "repos/$REPO/branches/$BR" >/dev/null 2>&1 || \
  gh api "repos/$REPO/git/refs" \
    -f ref="refs/heads/$BR" \
    -f sha="$(gh api "repos/$REPO/git/ref/heads/$BASE" --jq .object.sha)"

# 2.2 — Le helper lit le WORKING TREE, pas tes commits locaux.
#       Si tu as déjà commité en local, défais le commit en gardant les fichiers :
git log --oneline "origin/$BR..HEAD" | grep -q . && git reset --soft "origin/$BR"

git add -A
git-signed-commit -m "type(scope): sujet

Corps optionnel.

Co-Authored-By: Paperclip <noreply@paperclip.ing>"

# 2.3 — Réaligner le worktree local sur le commit signé qui vient d'être créé.
git fetch origin "$BR" && git reset --hard "origin/$BR"
```

Répète 2.2 + 2.3 pour chaque commit. Vérifie le résultat :

```bash
gh api "repos/$REPO/commits/$BR" --jq '.commit.verification.verified'   # doit afficher: true
```

## 3. Ouvrir la PR, puis l'enregistrer

```bash
gh pr create --base "$BASE" --head "$BR" --title "..." --body "..."
```

Enregistrement **obligatoire** — c'est ce qui permet le réveil automatique sur commentaire, review ou merge :

```bash
PR_URL=$(gh pr view --json url -q .url)
curl -sS -X PATCH "$PAPERCLIP_BASE_URL/issues/$PAPERCLIP_TASK_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"comment\":\"PR: $PR_URL\"}"
```

## 4. Interdits

- Pas de `git push`, sous aucune forme (ni `--force`, ni `--tags`, ni push de branche).
- Pas de commit ni de PR mergée directement sur la branche par défaut : tout passe par une PR.
- Pas de secrets en clair dans un commit, un message ou une PR.
- Ne demande jamais à un humain de committer ou de merger à ta place : escalade selon le `chainOfCommand`.

## 5. Limites connues du helper

- **Modes de fichiers** : l'API GitHub ne transporte pas le bit exécutable. Un *nouveau* script arrive en `100644`. S'il doit être exécutable, corrige-le après coup :
  `gh api "repos/$REPO/git/trees" ...` ou signale-le dans la PR.
- **Renommages** : envoyés comme une suppression + un ajout, l'historique ne montre pas le rename.
- **Volume** : la requête est plafonnée autour de 40 Mo. Découpe un très gros changement en plusieurs commits.

## 6. Secours si `git-signed-commit` est absent

```bash
OID=$(gh api "repos/$REPO/branches/$BR" --jq .commit.sha)
# puis 'gh api graphql' avec la mutation createCommitOnBranch :
#   input: { branch:{repositoryNameWithOwner, branchName}, expectedHeadOid: $OID,
#            message:{headline, body},
#            fileChanges:{ additions:[{path, contents:<base64>}], deletions:[{path}] } }
```

Si même cette voie échoue, **escalade** — ne contourne pas la règle de signature et ne laisse pas une PR en `BLOCKED` sans le signaler.
