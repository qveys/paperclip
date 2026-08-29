#!/usr/bin/env bash
#
# 110-company-wizard-action-timeout.sh
#
# Bug: every plugin `performAction` RPC call is capped at the hardcoded
# `DEFAULT_RPC_TIMEOUT_MS = 30_000` in services/plugin-worker-manager.js — the
# route handlers in routes/plugins.js (`POST /plugins/:pluginId/bridge/action`
# and `POST /plugins/:pluginId/actions/:key`) call
# `bridgeDeps.workerManager.call(plugin.id, "performAction", {...})` without
# ever passing the optional 4th `timeoutMs` argument the manager already
# supports (`call(pluginId, method, params, timeoutMs)`).
#
# The company-wizard plugin's `ai-chat` action (the Clipper interview) drives
# an LLM call through this RPC. Its final turn ("generate the configuration
# now") asks for a large multi-paragraph companyDescription plus a thorough
# goal description reproducing the full user brief — routinely > 30s through
# Squid — so the RPC times out with a 502 `TIMEOUT` and the whole interview is
# lost. Observed 2026-07-15 on plugin 8551b2d2-b7d0-40c9-aae1-1b49a4da9688
# (yesterday-ai.paperclip-plugin-company-wizard, actionKey "ai-chat").
#
# Fix: at both call sites, pass a longer timeoutMs (120s) specifically when
# the action key is "ai-chat" — currently unique to company-wizard among
# installed plugins — leaving the 30s default untouched for every other
# action so a genuinely hung/unresponsive plugin worker is still caught fast.
#
# Build-time, idempotent, fail-loud.
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="company-wizard-timeout"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

BASE="${PAPERCLIP_SERVER_DIST:-$PC_SERVER_DIST_DEFAULT}"
PLUGINS_ROUTE="${PLUGINS_ROUTE_OVERRIDE:-$BASE/routes/plugins.js}"

[ -f "$PLUGINS_ROUTE" ] || pc_die "target not found: $PLUGINS_ROUTE"

PLUGINS_ROUTE="$PLUGINS_ROUTE" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE'
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const MARKER = 'PAPERCLIP_ACTION_TIMEOUT_PATCH';

applyPatch({
  file: process.env.PLUGINS_ROUTE,
  marker: MARKER,
  mode: 'loud',
  prefix: 'company-wizard-timeout',
  edits: [
    {
      label: 'generic bridge/action route: longer timeout for ai-chat',
      anchor:
`        const companyId = assertPluginBridgeScope(req, body.companyId);
        try {
            const result = await bridgeDeps.workerManager.call(plugin.id, "performAction", {
                key: body.key,
                params: actionParamsWithAuthorizedCompanyScope(body.params, companyId),
                actorContext: performActionActorContext(req, companyId),
                renderEnvironment: body.renderEnvironment ?? null,
            });
            res.json({ data: result });
        }`,
      replacement:
`        const companyId = assertPluginBridgeScope(req, body.companyId);
        try {
            const pcActionTimeoutMs = body.key === "ai-chat" ? 120_000 : undefined; /* ${MARKER} */
            const result = await bridgeDeps.workerManager.call(plugin.id, "performAction", {
                key: body.key,
                params: actionParamsWithAuthorizedCompanyScope(body.params, companyId),
                actorContext: performActionActorContext(req, companyId),
                renderEnvironment: body.renderEnvironment ?? null,
            }, pcActionTimeoutMs);
            res.json({ data: result });
        }`,
    },
    {
      label: 'actions/:key route: longer timeout for ai-chat',
      anchor:
`        const body = req.body;
        const companyId = assertPluginBridgeScope(req, body?.companyId);
        try {
            const result = await bridgeDeps.workerManager.call(plugin.id, "performAction", {
                key,
                params: actionParamsWithAuthorizedCompanyScope(body?.params, companyId),
                actorContext: performActionActorContext(req, companyId),
                renderEnvironment: body?.renderEnvironment ?? null,
            });
            res.json({ data: result });
        }`,
      replacement:
`        const body = req.body;
        const companyId = assertPluginBridgeScope(req, body?.companyId);
        try {
            const pcActionTimeoutMs = key === "ai-chat" ? 120_000 : undefined; /* ${MARKER} */
            const result = await bridgeDeps.workerManager.call(plugin.id, "performAction", {
                key,
                params: actionParamsWithAuthorizedCompanyScope(body?.params, companyId),
                actorContext: performActionActorContext(req, companyId),
                renderEnvironment: body?.renderEnvironment ?? null,
            }, pcActionTimeoutMs);
            res.json({ data: result });
        }`,
    },
  ],
});
NODE
