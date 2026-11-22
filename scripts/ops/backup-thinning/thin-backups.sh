#!/bin/sh
# Thin Paperclip database dumps (vps-openclaw retention policy C25, decision D13).
#
# Target rotation: 24 hourly + 7 daily + 4 weekly.
# Paperclip only offers "keep every dump for N days" (N = 3, 7 or 14) plus
# weekly/monthly. With the UI set to Daily = 7 days, Weekly = 4 weeks, this
# script removes the hourly dumps older than KEEP_HOURS, keeping only the
# latest dump of each calendar day. Paperclip prunes beyond 7 days.
#
# Runs inside the backup-thinning container (see docker-compose.yml), every
# INTERVAL_SECONDS. DRY_RUN=1 only prints what would be removed.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/data/instances/default/data/backups}
KEEP_HOURS=${KEEP_HOURS:-24}
DRY_RUN=${DRY_RUN:-0}
INTERVAL_SECONDS=${INTERVAL_SECONDS:-3600}

thin() {
  cd "$BACKUP_DIR"
  cutoff=$(( $(date +%s) - KEEP_HOURS * 3600 ))
  seen=" "
  kept=0
  removed=0
  # Newest first, so the first dump met for a given day is the one kept.
  for f in $(ls -1 | grep -E '^paperclip-[0-9]{8}-[0-9]{6}\.sql\.gz$' | sort -r); do
    if [ "$(stat -c %Y "$f")" -ge "$cutoff" ]; then
      kept=$((kept + 1)); continue
    fi
    day=$(echo "$f" | cut -d- -f2)
    case "$seen" in
      *" $day "*)
        if [ "$DRY_RUN" = 1 ]; then echo "would remove $f"; else rm -f -- "$f"; echo "removed $f"; fi
        removed=$((removed + 1)) ;;
      *)
        seen="$seen$day "; kept=$((kept + 1)) ;;
    esac
  done
  echo "$(date -u +%FT%TZ) kept=$kept removed=$removed dry_run=$DRY_RUN"
}

if [ "${1:-}" = "--once" ]; then
  thin
  exit 0
fi

while :; do
  thin || echo "$(date -u +%FT%TZ) thinning failed" >&2
  sleep "$INTERVAL_SECONDS"
done
