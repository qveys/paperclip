#!/usr/bin/env bash
# boot step — apply hindsight plugin patches (multiCompanyConfig + secret_ref)
#
# Idempotent and fail-soft.
set -uo pipefail

PAYLOAD=/app/patches/hindsight-plugin/apply.sh

if [ -x "$PAYLOAD" ]; then
  "$PAYLOAD" || echo "[38-hindsight-plugin] payload en erreur — ignoré"
elif [ -f "$PAYLOAD" ]; then
  sh "$PAYLOAD" || echo "[38-hindsight-plugin] payload en erreur — ignoré"
else
  echo "[38-hindsight-plugin] payload absent: $PAYLOAD"
fi

exit 0
