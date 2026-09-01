#!/usr/bin/env bash
# payload volume — applique la politique modèle à tous les agents (DB).
# Fail-soft : exit 0 toujours quand appelé depuis entrypoint.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[agent-model-policy] $*"; }

# Attendre postgres embarqué (jusqu'à ~60s)
wait_pg() {
  local i
  for i in $(seq 1 60); do
    if node -e '
      const pg=require("/usr/local/lib/node_modules/paperclipai/node_modules/pg");
      const c=new pg.Client({host:"127.0.0.1",port:54329,user:"paperclip",password:"paperclip",database:"paperclip"});
      c.connect().then(()=>c.query("select 1")).then(()=>{c.end(); process.exit(0)}).catch(()=>process.exit(1));
    ' 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! wait_pg; then
  log "postgres indisponible — abandon (fail-soft)"
  exit 0
fi

export PC_MODEL_POLICY_PATH="$DIR/policy.json"
if [ ! -f "$PC_MODEL_POLICY_PATH" ]; then
  log "policy absente: $PC_MODEL_POLICY_PATH"
  exit 0
fi

node "$DIR/apply.cjs" "$@" 2>&1 | tee /tmp/agent-model-policy-apply.log | tail -n 5
rc=${PIPESTATUS[0]:-0}
log "apply.cjs exit=$rc (log: /tmp/agent-model-policy-apply.log)"
exit 0
