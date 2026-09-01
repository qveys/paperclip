#!/usr/bin/env bash
# agent-prompt-diet payload — fail-soft
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[agent-prompt-diet] $*"; }
export PC_COMPANIES_ROOT="${PC_COMPANIES_ROOT:-/paperclip/instances/default/companies}"
node "$DIR/apply.cjs" "$@" 2>&1 | tee /tmp/agent-prompt-diet-apply.log | tail -n 40
log "done (full log: /tmp/agent-prompt-diet-apply.log)"
exit 0
