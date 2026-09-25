# `entrypoint.d/` — boot-time steps (fail-SOFT)

`docker-entrypoint.sh` runs every `*.sh` here in filename order at container
start, then `exec`s the app. These patch/setup things that live in the `./data`
volume (`/paperclip/...`) — plugins, gitconfig, adapters — which the image can't
touch at build time, and which a plugin reinstall or volume wipe would undo. So
they re-apply **every boot** (idempotent, via a marker check).

**Policy: fail-SOFT.** `set -uo pipefail` (no `-e`); on any trouble they log a
warning and `exit 0`. A boot step must **never** keep the app from starting.

## Conventions

- **Order** = the `NN-` numeric prefix (lexicographic glob).
- **`*.bg.sh`** runs in the **background** (output to
  `/tmp/entrypoint-<name>.log`) — use it for slow work that must not delay
  startup. Everything else runs foreground.
- Adding/removing a step = adding/removing a file here. The entrypoint is
  generic; **don't edit it** for a new step.

## Current steps

| Step | Marker | Purpose |
|------|--------|---------|
| `01-postgres-cleanup.sh` | (none — deleting a stale lock is inherently idempotent) | Removes stale embedded-Postgres `postmaster.pid` / `.s.PGSQL.*.lock` files left by an unclean shutdown (SIGKILL/OOM/host reboot). |
| `05-mdxeditor.bg.sh` | `TOOLBAR_PATCH_V1` | Background safety-net re-run of `build.d/30-mdxeditor-toolbar.sh` (instant no-op once baked). Since 30's rebuild wholesale-replaces `ui-dist/` (wiping `build.d/50-agentanalytics-tracker.sh`'s injection into the same `index.html`), a real re-run also re-invokes 50 afterwards. |
| `10-telegram-worker-patches.sh` | `PAPERCLIP_AGENT_TOPICS_V3` + `PAPERCLIP_TELEGRAM_V4` | Two independently-gated passes on `paperclip-plugin-telegram/dist/worker.js` (same one-file-multiple-passes pattern as `37-company-wizard-secret-resolve.sh`): per-agent Telegram topic routing, then agent-name/issue/duration-enriched run cards with same-run edit-in-place. Order is deliberate — see file header. |
| `30-neutralize-nested-plugin-sdk.sh` | (rename `.sdkbak`) | Force every plugin worker onto the host-hoisted `@paperclipai/plugin-sdk` (fixes `INVOCATION_SCOPE_DENIED`). |
| `35-agentpixels-invocation-scope.sh` | `PAPERCLIP_INVOCATION_SCOPE_PATCH` | Same scope fix for Agent Pixels, whose SDK is *inlined* (no nested copy to swap). |
| `37-company-wizard-secret-resolve.sh` | `PC_COMPANY_WIZARD_SECRET_RESOLVE_v1` + `PC_COMPANY_WIZARD_ANTHROPIC_SECRET_RESOLVE_v1` | Two independently-gated passes on `@yesterday-ai/paperclip-plugin-company-wizard/dist/worker.js`: resolve the `secret_ref` for `paperclipPassword`, then for `anthropicApiKey` — the plugin declares both with `"format":"secret-ref"` but never calls `ctx.secrets.resolve()` on them. |
| `40-register-junie-adapter.sh` | (upsert record) | Deploy the `junie_local` adapter to the volume + register it. Shares its `adapter-plugins.json` upsert logic with `45-` via `lib/adapter-registry.js`. |
| `45-register-hermes-adapter.sh` | (upsert record) | Deploy the `hermes_local` adapter to the volume + register it. Structurally identical to `40-` (deploy image copy → symlink → registry upsert), same shared `lib/adapter-registry.js` helper. |
| `46-register-antigravity-adapter.sh` | (upsert record) | Deploy the `antigravity_local` adapter (Google Antigravity CLI, `agy`) to the volume + register it. Structurally identical to `40-` (same `@paperclipai/adapter-utils` import, same symlink + registry upsert). |
| `50-github-app.sh` | (idempotent git config + regenerated config file) | Wire the *global* GitHub App: resolve the binding from the container env (falling back to `$HOME/.config/github-app/config`), regenerate that file from the env so the **agent** runtime — which does not inherit `GITHUB_APP_*` — can still mint, install the credential helper + bot identity, then self-check by actually minting an installation token. The mint is the only step exercising app id + installation id + key + proxy egress together; the local git config alone "succeeds" even when the binding is broken, which is how MYH-203 spent 11 days blaming GitHub for a `:?` guard. |
| `55-hermes-synthetic-run.bg.sh` | (SQL `ON CONFLICT DO NOTHING`) | Inserts a synthetic `heartbeat_runs` row for Hermes's permanent MCP session, avoiding an FK-constraint 500 when Hermes creates/updates issues. Polls Postgres up to 60s since it isn't up yet when foreground steps run; soft runtime dependency on `45-` having registered a `hermes_local` agent. |
| `56-junie-omniroute-models.sh` | (deterministic rewrite) | Writes junie_local's standalone custom-model profiles (`$JUNIE_HOME/models/omniroute-*.json`) so `--model custom:omniroute-*` routes to Omniroute. |
| `57-junie-cli-update.bg.sh` | version check (`sort -V` vs `MIN_VERSION`) | Re-installs the Junie CLI via the official installer if the bundled version is below a known-good floor. The base image ships 1831.35, whose standalone custom-model path (`--model custom:...`) fails locally ("Authorization failed. Check the credentials.") before any network call, regardless of apiKey/apiType/baseUrl — fixed in 2651.3. Junie's binary lives on the `./data` volume, not the image, so a from-scratch rebuild reverts to the broken bundled version; this re-heals it every boot. |
| `60-github-webhook-server.bg.sh` | (persistent server) | Background HTTP server on port 3101: receives GitHub App webhooks, verifies HMAC, invokes agent heartbeats on PR events. Needs `GITHUB_WEBHOOK_SECRET`. |

## Adding a boot step

1. Name it `NN-short-name.sh` (pick `NN` to order vs. the table above; append
   `.bg.sh` for background).
2. `set -uo pipefail`; optionally
   `source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"`.
3. Guard with a unique marker; on any failure, warn and `exit 0` — never abort.
