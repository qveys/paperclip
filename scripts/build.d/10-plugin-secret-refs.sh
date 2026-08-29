#!/usr/bin/env bash
#
# patch-plugin-secret-refs.sh
#
# Historically re-enabled Paperclip plugin secret-ref resolution: upstream had
# shipped a fail-closed kill switch ("Plugin secret references are disabled
# until company-scoped plugin config lands") in services/plugin-secrets-handler.js
# (resolve() threw unconditionally) and routes/plugins.js (POST /plugins/:id/config
# returned 422 for any config containing a secret-ref).
#
# 2026-08-20: upstream shipped the real fix — company-scoped secret bindings
# (companySecretBindings table, bindingContext/accessContext) replace the old
# kill switch entirely. PLUGIN_SECRET_REFS_DISABLED_MESSAGE no longer exists
# anywhere in dist/. Both anchors this patch used to lift are gone, so steps 1
# (worker-side resolve()) and 2 (config-save guard) are removed — verified via
# `docker run --rm --entrypoint sh ghcr.io/hostinger/hvps-paperclip:latest`
# against the current image before dropping them.
#
# What remains below (still needed, anchors verified unchanged):
#   3. plugin-host-services.js -> route plugin http.outbound through the Squid
#      egress proxy (upstream connects direct to a resolved IP, which fails in
#      a proxy-only egress network).
#
# A second gate lives in app.js: `secrets.resolve` RPC is capability-gated on
# `secrets.read-ref` (host-client-factory). Some plugins declare
# format:"secret-ref" config fields WITHOUT declaring the capability
# (e.g. company-wizard) — their resolve() calls are then denied. We grant
# secrets.read-ref implicitly to any plugin whose instanceConfigSchema
# declares at least one secret-ref field: if the operator can store a ref in
# its config, the worker must be able to resolve it.
#
# Idempotent + fail-loud: if an upstream anchor changes (version bump) the build
# FAILS instead of silently shipping an unpatched/broken image.
set -euo pipefail

# Shared helpers (pc_die) + constants (PC_SERVER_DIST_DEFAULT) + the anchor-patch
# engine (lib/patch.js, require'd from the here-doc below).
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="secret-refs"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

BASE="${PAPERCLIP_SERVER_DIST:-$PC_SERVER_DIST_DEFAULT}"
HOSTSVC="${HOSTSVC_OVERRIDE:-$BASE/services/plugin-host-services.js}"
APP="${APP_OVERRIDE:-$BASE/app.js}"

for f in "$HOSTSVC" "$APP"; do
  [ -f "$f" ] || pc_die "target not found: $f"
done

HOSTSVC_FILE="$HOSTSVC" APP_FILE="$APP" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE'
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const PROXY_MARKER = 'PAPERCLIP_PROXY_PATCH';
const CAP_MARKER = 'PAPERCLIP_SECRET_REF_CAP_PATCH';

// Thin wrapper so each call reads like the original patch(file, edits, marker).
const patch = (file, edits, marker) =>
  applyPatch({ file, marker, mode: 'loud', prefix: 'secret-refs', edits });

// --- 3. plugin http.outbound -> honour the egress proxy ----------------------
// Upstream resolves DNS locally and connects directly to the pinned IP, which
// bypasses the Squid proxy and fails in a proxy-only egress network
// (EAI_AGAIN). When a proxy is configured, route through it via undici
// ProxyAgent; SSRF is then enforced by the proxy allowlist.
const hostsvc = process.env.HOSTSVC_FILE;
patch(hostsvc, [
  {
    label: 'http-outbound-proxy',
    anchor:
      '            async fetch(params) {\n' +
      '                // SSRF protection: validate protocol whitelist + block private IPs.\n' +
      '                // Resolve once, then connect directly to that IP to prevent DNS rebinding.\n' +
      '                const target = await validateAndResolveFetchUrl(params.url);',
    replacement:
      '            async fetch(params) {\n' +
      '                // ' + PROXY_MARKER + ': proxy-only egress (Squid). Route plugin outbound\n' +
      '                // through the configured proxy; SSRF enforced by the proxy allowlist.\n' +
      '                const __proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;\n' +
      '                // ' + PROXY_MARKER + ': honour NO_PROXY. Explicitly-trusted hosts (e.g. an\n' +
      '                // internal self-hosted backend on a non-Safe port like :8888) talk DIRECT —\n' +
      '                // Squid only allows ports 80/443 and the SSRF guard blocks private IPs, so an\n' +
      '                // internal service is otherwise unreachable. NO_PROXY is the operator trust list.\n' +
      '                const __noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);\n' +
      '                let __host = "";\n' +
      '                try { __host = new URL(params.url).hostname; } catch (_e) {}\n' +
      '                const __bypass = !!__host && __noProxy.some((p) => { const q = p.charAt(0) === "." ? p.slice(1) : p; return __host === q || __host.endsWith("." + q); });\n' +
      '                if (__bypass) {\n' +
      '                    const { fetch: __ufetch } = await import("undici");\n' +
      '                    const __controller = new AbortController();\n' +
      '                    const __timeout = setTimeout(() => __controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);\n' +
      '                    try {\n' +
      '                        const __init = params.init ?? {};\n' +
      '                        const __res = await __ufetch(params.url, { ...__init, signal: __controller.signal });\n' +
      '                        const __body = await __res.text();\n' +
      '                        const __headers = {};\n' +
      '                        __res.headers.forEach((v, k) => { __headers[k] = v; });\n' +
      '                        return { status: __res.status, statusText: __res.statusText, headers: __headers, body: __body };\n' +
      '                    }\n' +
      '                    finally {\n' +
      '                        clearTimeout(__timeout);\n' +
      '                    }\n' +
      '                }\n' +
      '                if (__proxy) {\n' +
      '                    const { fetch: __ufetch, ProxyAgent: __ProxyAgent } = await import("undici");\n' +
      '                    const __controller = new AbortController();\n' +
      '                    const __timeout = setTimeout(() => __controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);\n' +
      '                    try {\n' +
      '                        const __init = params.init ?? {};\n' +
      '                        const __res = await __ufetch(params.url, { ...__init, signal: __controller.signal, dispatcher: new __ProxyAgent(__proxy) });\n' +
      '                        const __body = await __res.text();\n' +
      '                        const __headers = {};\n' +
      '                        __res.headers.forEach((v, k) => { __headers[k] = v; });\n' +
      '                        return { status: __res.status, statusText: __res.statusText, headers: __headers, body: __body };\n' +
      '                    }\n' +
      '                    finally {\n' +
      '                        clearTimeout(__timeout);\n' +
      '                    }\n' +
      '                }\n' +
      '                // SSRF protection: validate protocol whitelist + block private IPs.\n' +
      '                // Resolve once, then connect directly to that IP to prevent DNS rebinding.\n' +
      '                const target = await validateAndResolveFetchUrl(params.url);',
  },
], PROXY_MARKER);

// --- 4. implicit secrets.read-ref capability ---------------------------------
// A plugin whose instanceConfigSchema declares format:"secret-ref" fields must
// be able to resolve them at runtime, even when upstream forgot to declare
// secrets.read-ref in the manifest (e.g. company-wizard <=0.1.16).
const appFile = process.env.APP_FILE;
patch(appFile, [
  {
    label: 'implicit-secret-ref-capability',
    anchor:
      '            return createHostClientHandlers({\n' +
      '                pluginId,\n' +
      '                capabilities: manifest.capabilities,\n' +
      '                services,\n' +
      '            });',
    replacement:
      '            // ' + CAP_MARKER + ': grant secrets.read-ref implicitly to plugins whose\n' +
      '            // config schema declares format:"secret-ref" fields — the operator can\n' +
      '            // store a ref in their config, so the worker must be able to resolve it.\n' +
      '            const __pcCaps = [...(manifest.capabilities ?? [])];\n' +
      '            let __pcHasSecretRefFields = false;\n' +
      '            try { __pcHasSecretRefFields = JSON.stringify(manifest.instanceConfigSchema ?? {}).includes(\'"format":"secret-ref"\'); } catch { }\n' +
      '            if (__pcHasSecretRefFields && !__pcCaps.includes("secrets.read-ref")) __pcCaps.push("secrets.read-ref");\n' +
      '            return createHostClientHandlers({\n' +
      '                pluginId,\n' +
      '                capabilities: __pcCaps,\n' +
      '                services,\n' +
      '            });',
  },
], CAP_MARKER);
NODE
