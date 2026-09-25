#!/usr/bin/env bash
# Expose Omniroute à junie_local via custom models (OpenAICompletion).
# Écrit un profil par modèle de l'allowlist ci-dessous.
# Fail-soft, idempotent.
set -uo pipefail
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="junie-omniroute-models"

MODELS_DIR="${PAPERCLIP_HOME:-/paperclip}/.junie/models"
mkdir -p "$MODELS_DIR" || { pc_log "mkdir $MODELS_DIR échoué, abandon"; exit 0; }

# Allowlist des combos Omniroute exposés à junie_local
MODELS=(
  "best-free:auto/best-free"
  "claude-sonnet:auto/claude-sonnet"
  "fast:auto/fast"
  "chat:auto/chat"
  "claude-opus:auto/claude-opus"
  "coding:auto/coding"
  "pro-fast:auto/pro-fast"
  "pro-chat:auto/pro-chat"
  "pro-coding:auto/pro-coding"
  "pro-reasoning:auto/pro-reasoning"
  "pro-vision:auto/pro-vision"
  "best-coding-fast:auto/best-coding-fast"
  "best-chat:auto/best-chat"
  "best-vision:auto/best-vision"
  "best-fast:auto/best-fast"
  "best-reasoning:auto/best-reasoning"
  "best-coding:auto/best-coding"
  "auto:auto"
  "sonnet:auto/claude-sonnet"
  "opus:auto/claude-opus"
  "reasoning:auto/pro-reasoning"
)

write_profile() {
  local name="$1" model_id="$2"
  local file="$MODELS_DIR/omniroute-${name}.json"
  cat > "$file" <<JSON || { pc_log "écriture $file échouée (ignoré)"; return; }
{
  "baseUrl": "https://omniroute.quentinveys.be/v1/chat/completions",
  "id": "${model_id}",
  "apiType": "OpenAICompletion",
  "apiKey": "\${OMNIROUTE_API_KEY}"
}
JSON
  pc_log "profil: omniroute-${name} -> ${model_id} (--model custom:omniroute-${name})"
}

for entry in "${MODELS[@]}"; do
  name="${entry%%:*}"
  mid="${entry#*:}"
  write_profile "$name" "$mid"
done

pc_log "terminé (${#MODELS[@]} profils)"
exit 0
