#!/usr/bin/env bash
# Supprime les fichiers lock PostgreSQL laissés par un arrêt brutal du container
# (SIGKILL, reboot hôte, OOM). Doit tourner avant que Paperclip ne démarre postgres.
# Fail-soft : ne bloque jamais le démarrage.
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="postgres-cleanup"

PID_FILE="${PAPERCLIP_HOME:-/paperclip}/instances/default/db/postmaster.pid"

if [ -f "$PID_FILE" ]; then
  rm -f "$PID_FILE" && pc_log "supprimé postmaster.pid obsolète" \
                    || pc_warn "impossible de supprimer $PID_FILE (on continue)"
fi

# Globbing sur le port au cas où il changerait
for lock in /tmp/.s.PGSQL.*.lock; do
  [ -e "$lock" ] || continue
  rm -f "$lock" && pc_log "supprimé lock socket obsolète: $lock" \
                 || pc_warn "impossible de supprimer $lock (on continue)"
done

exit 0
