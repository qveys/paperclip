#!/usr/bin/env bash
# Génère les secrets (tmpfs) depuis 1Password puis démarre le service.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export OP_SERVICE_ACCOUNT_TOKEN="$(cat ~/.config/op/sa-token)"
cd "$(dirname "$0")"
umask 077
op inject -i secrets.env.tpl -o /run/user/1000/paperclip.env -f >/dev/null
printf "ANTHROPIC_API_KEY=%s\n" "$(cat "$HOME/.config/cliproxy/access-key")" >> /run/user/1000/paperclip.env
docker compose up -d "$@"
