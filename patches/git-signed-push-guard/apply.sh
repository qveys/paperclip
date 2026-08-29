#!/usr/bin/env bash
set -euo pipefail
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for INSTANCES_DIR in "/paperclip/instances" "/app/data/instances"; do
  [ -d "$INSTANCES_DIR" ] || continue
  find "$INSTANCES_DIR" -type d -path "*/companies/*/agents/*" | while read -r agent_dir; do
    instr_dir="$agent_dir/instructions"
    mkdir -p "$instr_dir"
    cp "$PATCH_DIR/GIT.md" "$instr_dir/GIT.md"
    cp "$PATCH_DIR/git-workflow.md" "$instr_dir/git-workflow.md"
  done
done
