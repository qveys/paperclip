#!/usr/bin/env bash
# 120-git-signed-push-guard-shim.sh — install the `git` shim that blocks
# unsigned `git push` from inside agent worktrees.
#
# SYMPTOM: agent PRs land BLOCKED on GitHub with "Commits must have verified
#   signatures." — this container has no signing key (no ~/.ssh, no gpg), so a
#   local `git commit` (whatever the agent's coding CLI does under the hood)
#   is always unsigned. GitHub only marks a commit "Verified" when it's
#   created THROUGH THE API (GraphQL createCommitOnBranch) with an App
#   installation token — that's what scripts/bin/git-signed-commit.sh does.
#   A plain `git push`, even authenticated via the GitHub App credential
#   helper, lands an unsigned commit and trips `required_signatures`.
#
# FIX: shim `git` ahead of /usr/bin/git on PATH. It refuses `git push` (rc=1,
#   prints the git-signed-commit sequence) and passes every other subcommand
#   straight through to the real binary — see scripts/bin/git-shim.sh for the
#   full rationale. This is the enforcement half of the
#   `git-signed-push-guard` patch; the doctrine half (GIT.md deployed next to
#   each agent's AGENTS.md, git-workflow.md skill fix) is boot-time volume
#   work done by entrypoint.d/52-git-signed-push-guard.sh against the payload
#   at data/patches/git-signed-push-guard/.
#
# WHY build.d/ (image) and not entrypoint.d/ (volume): /opt/paperclip/bin is
#   root-owned image territory, same rationale as the acpx bin-link patch
#   (70-acpx-local-bin-links.sh). Prior to this script the shim was installed
#   by hand (`docker cp` into a running container) — which is why it silently
#   vanished on the very next `docker compose build` (image-side files don't
#   survive a rebuild unless they're baked in here). Baking it in is the fix
#   for that recurrence, not just for the original gap.
#
# Fail-LOUD: an agent silently able to `git push` unsigned again is exactly
#   the regression this exists to prevent — don't ship that image quietly.
set -euo pipefail

# COPY ./scripts/ /opt/paperclip/ (Dockerfile) already put bin/git-shim.sh here.
SRC="/opt/paperclip/bin/git-shim.sh"
DST="/opt/paperclip/bin/git"

[ -f "$SRC" ] || { echo "120-git-signed-push-guard-shim: source manquante: $SRC" >&2; exit 1; }

install -m 755 "$SRC" "$DST"
rm -f "$SRC"

# Sanity: the shim must resolve ahead of the real git and must refuse push.
resolved="$(command -v git)"
[ "$resolved" = "$DST" ] || {
  echo "120-git-signed-push-guard-shim: $DST ne prime pas sur PATH (résolu: $resolved)" >&2
  exit 1
}
push_rc=0
git push >/dev/null 2>&1 || push_rc=$?
[ "$push_rc" -eq 1 ] || {
  echo "120-git-signed-push-guard-shim: le shim n'a pas bloqué 'git push' (rc=$push_rc)" >&2
  exit 1
}

echo "120-git-signed-push-guard-shim: shim installé -> $DST"
