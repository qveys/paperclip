# `build.d/` — build-time scripts (fail-LOUD)

Run **once** by the `Dockerfile` (`RUN /opt/paperclip/build.d/NN-*.sh`) at image
build, where egress is direct (not via the runtime Squid proxy). Two kinds live
here:

- **Server / UI patches** — rewrite the installed `@paperclipai/server` (and its
  `ui-dist`) baked into the image. They edit `/usr/local/lib/node_modules/...` —
  image-side files that the `./data` volume masks at runtime, which is why these
  run at build, not boot.
- **Baked runtimes & CLIs** — install external binaries (Grok, Cursor, Ollama)
  under `/opt/paperclip` so the built-in adapters/agents can spawn them. They go
  **outside** the `./data` volume (on the `node` user's PATH) so they survive a
  volume wipe and aren't re-downloaded at every boot.

**Policy: fail-LOUD.** `set -euo pipefail`. Patches locate a literal source
*anchor* and rewrite it; if an upstream version bump moves the anchor (and the
idempotency marker is absent), the patch **exits non-zero and the build fails** —
deliberately, so a broken image is never shipped. CLI installers fail the build
on any download/exec error rather than shipping an image whose runs all die on
first spawn. Everything here is idempotent (marker / working-binary check) and
re-runnable.

## Server / UI patches

| Script | Marker | What it fixes |
|--------|--------|----------------|
| `10-plugin-secret-refs.sh` | `PAPERCLIP_SECRET_REF_PATCH` / `PAPERCLIP_PROXY_PATCH` | Lifts the upstream secret-ref kill switch (Telegram/Slack/Discord) + routes plugin `http.outbound` through the Squid proxy. |
| `20-plugin-host-version.sh` | `PAPERCLIP_HOST_VERSION_PATCH` | Reports the real server version to the plugin compat gate (was hardcoded `0.0.0`, rejecting version-gated plugins). |
| `30-mdxeditor-toolbar.sh` | `TOOLBAR_PATCH_V1` + CSS `PAPERCLIP-TOOLBAR-PATCH-v1` | Builds & injects the MDXEditor KitchenSinkToolbar into `ui-dist`. CSS source lives in `assets/`. |
| `40-plugin-ui-static-uuid.sh` | `PAPERCLIP_UI_STATIC_UUID_PATCH` | Fixes a 500 on key-addressed plugin UI assets — walks `error.cause` so the `getById→getByKey` fallback fires (e.g. Agent Pixels UI). |
| `50-agentanalytics-tracker.sh` | `AGENT_ANALYTICS_TRACKER_V1` | Injects the Agent Analytics tracker into the served SPA shell (`ui-dist/index.html`). |
| `70-acpx-local-bin-links.sh` | (re-links `.bin`, `ln -sf`) | Repairs the `acpx-local` adapter's package-local `node_modules/.bin` symlinks (hoisted deps → `exit 127`, e.g. Claude ACP). |
| `100-agent-label-permission-grant.sh` | `PAPERCLIP_ISSUE_LABELS_UPDATE_ANY_PATCH` | Lets an agent (e.g. Triage Bot) label an issue owned by a different agent when the PATCH body is `labelIds`-only AND it holds a new `issue:labels:update_any` grant. Also adds `PATCH /companies/:companyId/agents/:agentId/permissions` — the only way to grant a `principalPermissionGrants` row to an agent principal (the sibling members route only targets `companyMemberships`, which agents never have). |

## Baked runtimes & CLIs

Idempotency is a working-binary check (re-run with `--force` to reinstall).

| Script | Installs | For |
|--------|----------|-----|
| `60-grok-cli.sh` | `grok` → `/opt/paperclip/bin/grok` | built-in `grok_local` adapter. |
| `80-cursor-cli.sh` | `cursor-agent` + `cursor` → `/opt/paperclip/bin` (bundle in `cursor-agent-app/`) | built-in `cursor` adapter (set `command: cursor-agent`). |
| `90-ollama-cli.sh` | `ollama` → `/opt/paperclip/bin/ollama` (runner libs in `/opt/paperclip/lib/ollama`) | local LLM server (`ollama serve`, API `127.0.0.1:11434`) + CLI. CPU-only by default (GPU runners pruned); set `OLLAMA_PRUNE_GPU=0` to keep CUDA/ROCm. |

## Adding a build patch

1. Name it `NN-short-name.sh`, after the patches it depends on.
2. `set -euo pipefail`; if you need shared helpers,
   `source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"` (gives `pc_die`,
   `pc_find_server_pkg`, …).
3. Guard with a unique marker (patches) or a working-binary check (CLIs) so
   re-runs are no-ops; fail loud if the anchor is missing.
4. Wire it with a `RUN /opt/paperclip/build.d/NN-...sh` line in the `Dockerfile`.

`30-mdxeditor-toolbar.sh` is also invoked at boot by
`entrypoint.d/05-mdxeditor.bg.sh` as an idempotent safety net (instant no-op once
the marker is present).
