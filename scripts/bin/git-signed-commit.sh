#!/usr/bin/env bash
# git-signed-commit — create a GitHub-**verified** (GPG-signed) commit from a
# GitHub App identity, without managing any signing key.
#
# Why this exists: a plain `git commit` + `git push` over HTTPS with an App
# installation token lands an UNVERIFIED commit, which branch protections that
# require "Commits must have verified signatures" reject. Commits created
# through the GitHub API with an installation token are signed by GitHub
# automatically and show as "Verified". This helper drives the GraphQL
# `createCommitOnBranch` mutation via the already-authenticated `gh` shim.
#
# It does NOT use local `git commit`: it reads the *current working-tree*
# contents of the given files and creates one signed commit on top of the
# remote branch tip. Use plain git for inspect/diff/branch; use this for the
# commit that must land verified.
#
# Usage:
#   git-signed-commit -m "msg" [file ...]        # files default to staged set
#   git-signed-commit -m "msg" -b BRANCH -r OWNER/REPO file1 file2
#   git-signed-commit -m "msg" -d path/to/delete # -d (repeatable) = delete a path
#
# Options:
#   -m MSG     commit message (first line = headline, rest = body). Required.
#   -r REPO    OWNER/REPO. Default: derived from `origin` remote.
#   -b BRANCH  target branch. Default: current branch (must exist on remote).
#   -d PATH    delete this path (repeatable). Paths are repo-root-relative.
#   FILE...    add/update these paths from the working tree. If omitted, uses
#              the staged set (`git diff --cached --name-only`). Deleted-on-disk
#              staged paths are sent as deletions automatically.
#
# Requires: gh (authenticated), jq, base64, git. Egress: api.github.com.
set -euo pipefail

die() { echo "git-signed-commit: $*" >&2; exit 1; }
command -v gh  >/dev/null || die "gh not found on PATH"
command -v jq  >/dev/null || die "jq not found on PATH"
command -v git >/dev/null || die "git not found on PATH"

MSG="" ; REPO="" ; BRANCH="" ; DELS=()
ADDS_ARG=()
while [ $# -gt 0 ]; do
  case "$1" in
    -m) MSG="${2:?-m needs a message}"; shift 2 ;;
    -r) REPO="${2:?-r needs OWNER/REPO}"; shift 2 ;;
    -b) BRANCH="${2:?-b needs a branch}"; shift 2 ;;
    -d) DELS+=("${2:?-d needs a path}"); shift 2 ;;
    --) shift; while [ $# -gt 0 ]; do ADDS_ARG+=("$1"); shift; done ;;
    -*) die "unknown option: $1" ;;
    *)  ADDS_ARG+=("$1"); shift ;;
  esac
done
[ -n "$MSG" ] || die "missing -m MESSAGE"

# repo root so paths are normalised relative to it
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git work tree"
cd "$ROOT"

# default repo from origin (supports https and ssh remotes)
if [ -z "$REPO" ]; then
  url="$(git remote get-url origin 2>/dev/null)" || die "no origin remote; pass -r OWNER/REPO"
  REPO="$(printf '%s' "$url" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')"
fi
[[ "$REPO" == */* ]] || die "repo must be OWNER/REPO, got '$REPO'"

# default branch = current
[ -n "$BRANCH" ] || BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || die "cannot determine branch; pass -b BRANCH"

# default file set = staged
ADDS=() ; STAGED_DELS=()
if [ "${#ADDS_ARG[@]}" -eq 0 ] && [ "${#DELS[@]}" -eq 0 ]; then
  while IFS= read -r f; do [ -n "$f" ] || continue
    if [ -f "$f" ]; then ADDS+=("$f"); else STAGED_DELS+=("$f"); fi
  done < <(git diff --cached --name-only)
  [ "${#ADDS[@]}" -gt 0 ] || [ "${#STAGED_DELS[@]}" -gt 0 ] || die "nothing staged and no files given"
else
  for f in "${ADDS_ARG[@]}"; do
    if [ -f "$f" ]; then ADDS+=("$f"); else STAGED_DELS+=("$f"); fi  # missing-on-disk -> deletion
  done
fi
DELS+=("${STAGED_DELS[@]}")

# expected head oid = current REMOTE tip of the branch (commit lands on top of it)
HEAD_OID="$(gh api "repos/${REPO}/branches/${BRANCH}" --jq '.commit.sha' 2>/dev/null)" \
  || die "branch '${BRANCH}' not found on ${REPO} (create it first: gh api repos/${REPO}/git/refs -f ref=refs/heads/${BRANCH} -f sha=<base-sha>)"

# build the GraphQL request. File contents can be large/binary, so they travel
# through temp files (jq --rawfile / --slurpfile), never as argv — otherwise
# base64 of a big file blows ARG_MAX ("Argument list too long").
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT

# additions as NDJSON; each file's base64 is read with --rawfile (off the argv path)
: > "$TMPD/adds.ndjson"
for f in "${ADDS[@]:-}"; do
  [ -n "$f" ] || continue
  base64 -w0 "$f" > "$TMPD/b64"
  jq -n --arg p "$f" --rawfile c "$TMPD/b64" '{path:$p, contents:$c}' >> "$TMPD/adds.ndjson"
done

# deletions as NDJSON
: > "$TMPD/dels.ndjson"
for d in "${DELS[@]:-}"; do
  [ -n "$d" ] || continue
  jq -n --arg p "$d" '{path:$p}' >> "$TMPD/dels.ndjson"
done

headline="${MSG%%$'\n'*}"
body=""; case "$MSG" in *$'\n'*) body="${MSG#*$'\n'}";; esac
body="${body#$'\n'}"            # drop the blank line that separates headline from body
printf '%s' "$body" > "$TMPD/body"

read -r -d '' QUERY <<'GQL' || true
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}
GQL

# --slurpfile reads a (possibly empty) NDJSON file into an array; empty file -> []
jq -n \
  --arg q "$QUERY" --arg repo "$REPO" --arg branch "$BRANCH" --arg oid "$HEAD_OID" \
  --arg headline "$headline" --rawfile body "$TMPD/body" \
  --slurpfile adds "$TMPD/adds.ndjson" --slurpfile dels "$TMPD/dels.ndjson" \
  '{query:$q, variables:{input:{
      branch:{repositoryNameWithOwner:$repo, branchName:$branch},
      expectedHeadOid:$oid,
      message:({headline:$headline} + (if ($body|length)==0 then {} else {body:$body} end)),
      fileChanges:{additions:$adds, deletions:$dels}}}}' > "$TMPD/req.json"

resp="$(gh api graphql --input "$TMPD/req.json")" \
  || die "GraphQL call failed: $resp"

if printf '%s' "$resp" | jq -e '.errors' >/dev/null 2>&1; then
  die "GitHub rejected the commit: $(printf '%s' "$resp" | jq -c '.errors')"
fi

oid="$(printf '%s' "$resp" | jq -r '.data.createCommitOnBranch.commit.oid')"
curl_url="$(printf '%s' "$resp" | jq -r '.data.createCommitOnBranch.commit.url')"
echo "signed commit ${oid} on ${REPO}@${BRANCH}"
echo "${curl_url}"
echo "tip: run 'git fetch origin ${BRANCH}' to sync your local tree with the new commit."
