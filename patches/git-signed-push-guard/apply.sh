#!/usr/bin/env bash
set -euo pipefail
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCES_DIR="/paperclip/instances"
[ -d "$INSTANCES_DIR" ] || exit 0
find "$INSTANCES_DIR" -type d -path "*/companies/*/agents/*" | while read -r agent_dir; do
  instr_dir="$agent_dir/instructions"
  mkdir -p "$instr_dir"
  cp "$PATCH_DIR/GIT.md" "$instr_dir/GIT.md"
  cp "$PATCH_DIR/git-workflow.md" "$instr_dir/git-workflow.md"
done
