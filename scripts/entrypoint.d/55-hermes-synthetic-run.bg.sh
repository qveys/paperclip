#!/usr/bin/env bash
# 55-hermes-synthetic-run.bg.sh
#
# Background script: insère une row synthétique dans heartbeat_runs pour la session permanente
# de l'agent Hermes (MCP). Cela élimine les erreurs FK 500 quand Hermes crée/met à jour des issues.
#
# Pourquoi .bg.sh : Postgres démarre dans le processus Node.js de l'app, indisponible
# pendant les scripts synchrones. Ce background script poll jusqu'à disponibilité.
#
# Idempotent: ON CONFLICT DO NOTHING + marqueur fichier évitent les ré-insertions.

set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="hermes-synthetic-run"

PAPERCLIP_COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
SYNTHETIC_RUN_ID="00000000-0000-0000-0000-000000000001"
POSTGRES_HOST="127.0.0.1"
POSTGRES_PORT="54329"
POSTGRES_USER="paperclip"
POSTGRES_PASSWORD="paperclip"
POSTGRES_DB="paperclip"

log() { pc_log "$@"; }
warn() { pc_warn "$@"; }

# 1. Vérifications préalables
if [ -z "$PAPERCLIP_COMPANY_ID" ]; then
  warn "PAPERCLIP_COMPANY_ID non défini — impossible de créer la run synthétique"
  exit 0
fi

# 2. Poll postgres jusqu'à disponibilité (max 60s)
log "attente de postgres (127.0.0.1:54329)..."
RETRIES=0
MAX_RETRIES=30

while [ $RETRIES -lt $MAX_RETRIES ]; do
  if timeout 2 bash -c ">/dev/tcp/127.0.0.1/54329" 2>/dev/null; then
    log "postgres accessible"
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 2
done

if [ $RETRIES -eq $MAX_RETRIES ]; then
  warn "postgres non accessible après 60s — synthetic run non créée (ignoré)"
  exit 0
fi

# 3. Requête: créer la run synthétique + lire agent_id hermes
log "création/vérification de la run synthétique..."

RESULT=$(
  PGPASSWORD="$POSTGRES_PASSWORD" node <<'NODEJS' 2>/dev/null || echo "ERROR"
try {
  const postgres = require('/usr/local/lib/node_modules/paperclipai/node_modules/postgres');
  const sql = postgres({
    host: '127.0.0.1',
    port: 54329,
    username: 'paperclip',
    password: 'paperclip',
    database: 'paperclip',
  });

  (async () => {
    try {
      // 1. Chercher l'agent hermes dans la table agents
      const agents = await sql`
        SELECT id FROM agents WHERE adapter_type = 'hermes_local' LIMIT 1
      `;

      if (!agents || agents.length === 0) {
        console.log("NO_AGENT");
        await sql.end();
        process.exit(0);
      }

      const agentId = agents[0].id;

      // 2. Insérer la run synthétique
      const companyId = process.env.PAPERCLIP_COMPANY_ID;
      const runId = '00000000-0000-0000-0000-000000000001';

      await sql`
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status, invocation_source)
        VALUES (${runId}, ${companyId}, ${agentId}, 'running', 'external')
        ON CONFLICT (id) DO NOTHING
      `;

      console.log("OK");
      await sql.end();
      process.exit(0);
    } catch (e) {
      console.log("ERROR: " + e.message);
      await sql.end();
      process.exit(1);
    }
  })();
} catch (e) {
  console.log("ERROR: " + e.message);
  process.exit(1);
}
NODEJS
)

case "$RESULT" in
  OK)
    log "run synthétique créée/confirmée avec succès"
    ;;
  NO_AGENT)
    warn "agent hermes_local introuvable en BD — run synthétique non créée (ignoré)"
    ;;
  ERROR)
    warn "erreur lors de la création de la run synthétique (ignoré)"
    ;;
  *)
    warn "résultat inattendu: $RESULT (ignoré)"
    ;;
esac

log "terminé"
exit 0
