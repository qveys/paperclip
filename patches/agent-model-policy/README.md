# agent-model-policy

Politique durable **rôle → modèle Omniroute** pour tous les agents Paperclip.

## Fichiers
- `policy.json` — source de vérité (modèles autorisés, mapping rôle/titre)
- `apply.cjs` — met à jour `agents.adapter_config.model` + `maxTurnsPerRun`
- `apply.sh` — wrapper fail-soft (attend Postgres)

## Boot
`scripts/entrypoint.d/58-agent-model-policy.bg.sh` exécute ce payload en arrière-plan après démarrage.

## Manuel
```bash
docker exec paperclip-paperclip-1 bash /paperclip/patches/agent-model-policy/apply.sh
docker exec paperclip-paperclip-1 node /paperclip/patches/agent-model-policy/apply.cjs --dry-run
```

## Budgets
Non gérés ici — Omniroute.
