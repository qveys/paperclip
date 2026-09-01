# agent-prompt-diet

Réécrit `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md` en versions minces (lazy docs, pas de bulk-read).

- Marqueur `<!-- agent-prompt-diet:v1 -->`
- Backup one-shot `*.pre-diet.bak`
- Conserve la section git-signed (`GIT.md` non touché)
- Source git : `scripts/patches/agent-prompt-diet/` (COPY → `/opt/paperclip/patches/`)
- Runtime volume : `/paperclip/patches/agent-prompt-diet/`

```bash
docker exec paperclip-paperclip-1 node /paperclip/patches/agent-prompt-diet/apply.cjs --dry-run
docker exec paperclip-paperclip-1 bash /paperclip/patches/agent-prompt-diet/apply.sh
```
