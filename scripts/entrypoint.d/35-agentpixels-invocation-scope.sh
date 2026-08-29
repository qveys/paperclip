#!/usr/bin/env bash
#
# entrypoint-patch-agentpixels-invocation-scope.sh
#
# Fix INVOCATION_SCOPE_DENIED for the Agent Pixels plugin
# (@agent-pixels/paperclip-plugin). The plugin ships a PRE-BUILT worker.js with
# its plugin-sdk runtime *inlined* (bundled) — there is no nested
# node_modules/@paperclipai/plugin-sdk file to swap (unlike live-analytics), so
# neutralize-nested-plugin-sdk.sh can't help it.
#
# Root cause: host SDK 2026.609 enforces an "invocation scope" protocol. When the
# host calls into the worker (e.g. the getData UI bridge for character-settings),
# it tags the inbound message with `paperclipInvocation = {id, scope}`. Any
# worker->host callback made WHILE that invocation is active (e.g. agents.list)
# must echo the id back as a TOP-LEVEL `paperclipInvocationId` string, or the host
# rejects it ("the worker referenced a missing, expired, or unknown invocation
# scope"). The bundled (older) worker runtime predates this protocol and never
# echoes the id -> every scoped callback is denied -> Settings page returns 502.
#
# Fix (surgical, in the inlined runtime): capture the inbound
# `message.paperclipInvocation.id` into an AsyncLocalStorage around each inbound
# request/onEvent handler, and have callHost() attach it as top-level
# `paperclipInvocationId` on outbound requests. AsyncLocalStorage propagates the
# id across the handler's awaits down to the nested host calls.
#
# Runs at every boot. The plugin lives in the ./data volume (not the image), so
# re-applying each boot makes the fix survive image rebuilds AND plugin
# reinstalls/updates. Idempotent (marker) + fail-SOFT (never aborts boot) + writes
# via temp+rename (worker.js may be owned by another uid).
set -uo pipefail

# Shared helpers (pc_warn) + the anchor-patch engine (lib/patch.js, require'd from
# the here-doc below).
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="agentpixels-scope"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

PLUGIN_GLOB="${AGENTPIXELS_PLUGIN_GLOB:-/paperclip/.paperclip/plugins/local/agent-pixels-*/dist/worker.js}"

shopt -s nullglob
matches=( $PLUGIN_GLOB )
shopt -u nullglob

if [ "${#matches[@]}" -eq 0 ]; then
  pc_warn "worker not found ($PLUGIN_GLOB) — skipping (plugin not installed?)."
  exit 0
fi

for WORKER in "${matches[@]}"; do
  [ -f "$WORKER" ] || continue
  WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { echo "[agentpixels-scope] WARN: node patch step failed for a worker — continuing startup." >&2; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PAPERCLIP_INVOCATION_SCOPE_PATCH';

// Anchors: only patch a bundle that actually has the runtime shape we expect.
// applyPatch validates ALL five up-front, so a single missing anchor (plugin
// version bump) leaves the worker untouched (soft) without a half-applied edit.
const A1 = 'import { randomUUID } from "node:crypto";';
const A2 = '  let nextOutboundId = 1;';
const A3 = '        const request = createRequest(method, params, id);\n        sendMessage(request);';
const A4 = '    } else if (isJsonRpcRequest(message)) {\n      handleHostRequest(message).catch((err) => {';
const A5 = '      } else if (notif.method === "onEvent" && notif.params) {\n        handleOnEvent(notif.params).catch((err) => {';

// Atomic write (atomic: true): worker.js may be owned by another uid so an
// in-place write could EACCES; the parent dir is ours so applyPatch swaps via
// temp+rename.
applyPatch({
  file, marker: MARKER, mode: 'soft', atomic: true, prefix: 'agentpixels-scope',
  edits: [
    // 1) import AsyncLocalStorage (alias to avoid any collision in the bundle scope)
    { label: 'A1', anchor: A1,
      replacement: A1 + '\nimport { AsyncLocalStorage as __PcALS } from "node:async_hooks"; // ' + MARKER },
    // 2) one ALS instance per worker runtime, holding the current invocation id
    { label: 'A2', anchor: A2,
      replacement: A2 + '\n  const __pcInvocationStore = new __PcALS(); // ' + MARKER },
    // 3) outbound: echo the active invocation id as top-level paperclipInvocationId
    { label: 'A3', anchor: A3,
      replacement:
        '        const request = createRequest(method, params, id);\n' +
        '        const __pcInvId = __pcInvocationStore.getStore(); // ' + MARKER + '\n' +
        '        if (__pcInvId) request.paperclipInvocationId = __pcInvId;\n' +
        '        sendMessage(request);' },
    // 4) inbound requests: run the handler inside the invocation scope
    { label: 'A4', anchor: A4,
      replacement:
        '    } else if (isJsonRpcRequest(message)) {\n' +
        '      const __pcInv = message.paperclipInvocation && message.paperclipInvocation.id; // ' + MARKER + '\n' +
        '      __pcInvocationStore.run(__pcInv, () => handleHostRequest(message)).catch((err) => {' },
    // 5) inbound onEvent notifications: same treatment
    { label: 'A5', anchor: A5,
      replacement:
        '      } else if (notif.method === "onEvent" && notif.params) {\n' +
        '        const __pcInvN = notif.paperclipInvocation && notif.paperclipInvocation.id; // ' + MARKER + '\n' +
        '        __pcInvocationStore.run(__pcInvN, () => handleOnEvent(notif.params)).catch((err) => {' },
  ],
});
NODE
done
