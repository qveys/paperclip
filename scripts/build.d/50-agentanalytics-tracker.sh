#!/usr/bin/env bash
# 50-agentanalytics-tracker.sh — Inject the Agent Analytics website tracker into
# the served Paperclip SPA shell (ui-dist/index.html).
#
# WHY a build.d/ (image) patch and not entrypoint.d/ (volume):
#   ui-dist/index.html lives in the IMAGE (/usr/local/lib/.../@paperclipai/server),
#   not in the ./data volume. It is root-owned; the boot entrypoint runs as `node`
#   and could not write it. So the edit must happen here, at build, as root —
#   exactly like 30-mdxeditor-toolbar.sh.
#
# WHAT it injects (before </head>):
#   <script defer src="https://api.agentanalytics.sh/tracker.js"
#     data-project="…" data-token="aat_…" data-track-spa="true" …></script>
#   The token is the PUBLIC client-side project token (aat_*) — safe to bake.
#   data-track-spa is REQUIRED: Paperclip is a React/Vite SPA, so without it only
#   the first page view is sent (route changes via pushState would be missed).
#   Beacons go to api.agentanalytics.sh/track/batch from the VISITOR's browser
#   (not via Squid). NB: paperclip.qveys.cloud sits behind Cloudflare Access, so
#   only authenticated users are ever tracked (internal usage, not public web).
#
# Override at build via env/ARG: AA_TRACKER_PROJECT / AA_TRACKER_TOKEN.
# Empty token => graceful SKIP (no failure): lets the image build without a
# tracker configured. Fail-LOUD only on a real anchor drift (missing </head>).
#
# Idempotent: re-running is a no-op once the marker comment is present.
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="aa-tracker"

# ── Configuration (public token — overridable at build) ──────────────────────
AA_TRACKER_PROJECT="${AA_TRACKER_PROJECT:-paperclip}"
AA_TRACKER_TOKEN="${AA_TRACKER_TOKEN:-aat_f52f83a0d2723fb36b19fe64794b31ec6f43cb5dc50c7c62}"
MARKER="AGENT_ANALYTICS_TRACKER_V1"

# ── Locate the served SPA shell ──────────────────────────────────────────────
pkg="$(pc_find_server_pkg)" || pc_die "@paperclipai/server package not found"
INDEX_HTML="$pkg/ui-dist/index.html"
[ -f "$INDEX_HTML" ] || pc_die "ui-dist/index.html not found at $INDEX_HTML"

if [ -z "$AA_TRACKER_TOKEN" ]; then
  pc_log "AA_TRACKER_TOKEN empty — skipping tracker injection (not configured)"
  exit 0
fi

# ── Idempotency ──────────────────────────────────────────────────────────────
if grep -qF "$MARKER" "$INDEX_HTML"; then
  pc_log "tracker already present in $INDEX_HTML — no-op"
  exit 0
fi

# ── Inject before </head> (fail-loud if the anchor is gone) ───────────────────
INDEX_HTML="$INDEX_HTML" MARKER="$MARKER" \
AA_TRACKER_PROJECT="$AA_TRACKER_PROJECT" AA_TRACKER_TOKEN="$AA_TRACKER_TOKEN" \
node <<'NODE'
const fs = require("fs");
const file = process.env.INDEX_HTML;
const marker = process.env.MARKER;
const project = process.env.AA_TRACKER_PROJECT;
const token = process.env.AA_TRACKER_TOKEN;

const html = fs.readFileSync(file, "utf8");
const anchor = "</head>";
if (!html.includes(anchor)) {
  console.error(`[aa-tracker] ERROR: anchor '${anchor}' not found in ${file}`);
  process.exit(1);
}

const snippet =
  `    <!-- ${marker} START -->\n` +
  `    <script defer src="https://api.agentanalytics.sh/tracker.js"\n` +
  `      data-project="${project}"\n` +
  `      data-token="${token}"\n` +
  `      data-track-spa="true"\n` +
  `      data-track-vitals="true"\n` +
  `      data-track-errors="true"></script>\n` +
  `    <!-- ${marker} END -->\n  `;

// Insert before the LAST </head> (there is only one, but be precise).
const idx = html.lastIndexOf(anchor);
const out = html.slice(0, idx) + snippet + html.slice(idx);
fs.writeFileSync(file, out);
console.log(`[aa-tracker] injected tracker (project=${project}) into ${file}`);
NODE

pc_log "done"
