#!/usr/bin/env bash
# patch-mdxeditor-toolbar.sh — Add full MDXEditor toolbar (KitchenSinkToolbar) to Paperclip.
#
# Usage:
#   ./patch-mdxeditor-toolbar.sh [--force] [--target <server-pkg-path>]
#
# Options:
#   --force    Apply patch even when version is not in the known-compatible list.
#   --target   Override the @paperclipai/server package path (default: auto-detected).
#
# Exit codes:
#   0  Patch applied (or already applied).
#   1  Error — incompatible version (use --force), build failure, or missing tools.
set -euo pipefail

# Shared helpers: pc_log/pc_warn/pc_die, pc_find_server_pkg, pc_assets_have_toolbar,
# PC_TOOLBAR_MARKER_*. From build.d/ the lib is one level up.
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="patch"

# ── Configuration ────────────────────────────────────────────────────────────

PATCH_MARKER_FILE="$PC_TOOLBAR_MARKER_FILE"
PATCH_MARKER_CSS="$PC_TOOLBAR_MARKER_CSS"
# Versions where this patch was tested and works. New versions auto-enabled with warning.
KNOWN_VERSIONS=("2026.529.0" "2026.609.0" "2026.618.0")
REPO_URL="https://github.com/paperclipai/paperclip.git"

# ── Argument parsing ─────────────────────────────────────────────────────────

FORCE=false
SERVER_PKG_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=true
      shift
      ;;
    --target)
      [[ -n "${2:-}" ]] || { echo "[patch] --target requires a path argument" >&2; exit 1; }
      SERVER_PKG_ARG="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--force] [--target <server-pkg-path>]"
      exit 0
      ;;
    *)
      echo "[patch] Unknown argument: $1" >&2
      echo "Usage: $0 [--force] [--target <server-pkg-path>]" >&2
      exit 1
      ;;
  esac
done

# ── Logging ───────────────────────────────────────────────────────────────────

log()  { pc_log "$@"; }
warn() { pc_warn "$@"; }
die()  { pc_die "$@"; }

check_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1 — install it and retry."
}

# ── Locate server package ─────────────────────────────────────────────────────

find_server_pkg() {
  local p
  if [[ -n "$SERVER_PKG_ARG" ]]; then
    p="$(pc_find_server_pkg "$SERVER_PKG_ARG")" || die "--target path not found: $SERVER_PKG_ARG"
  else
    p="$(pc_find_server_pkg)" || die "Cannot locate @paperclipai/server package. Use --target <path> to specify it."
  fi
  printf '%s\n' "$p"
}

# ── Idempotency ───────────────────────────────────────────────────────────────

check_already_patched() {
  local server_pkg="$1"
  if [[ -f "$server_pkg/ui-dist/$PATCH_MARKER_FILE" ]]; then
    return 0
  fi
  # Marker also lives in the separate paperclip-toolbar.<hash>.css under assets.
  pc_assets_have_toolbar "$server_pkg/ui-dist/assets"
}

# ── Version detection ─────────────────────────────────────────────────────────

get_version() {
  local pkg_json="$1/package.json"
  [[ -f "$pkg_json" ]] || die "package.json not found: $pkg_json"
  node -e "
    const pkg = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(pkg.version);
  " "$pkg_json"
}

check_version_compat() {
  local version="$1"
  for v in "${KNOWN_VERSIONS[@]}"; do
    [[ "$v" == "$version" ]] && return 0
  done
  return 1
}

# ── Backup ────────────────────────────────────────────────────────────────────

backup_ui_dist() {
  local server_pkg="$1"
  local ts
  ts=$(date +%Y%m%d_%H%M%S)
  local backup_dir="/tmp/paperclip-toolbar-backup-${ts}"
  log "Creating backup: $backup_dir" >&2
  cp -r "$server_pkg/ui-dist" "$backup_dir"
  echo "$backup_dir"
}

# ── Rollback ──────────────────────────────────────────────────────────────────

rollback() {
  local server_pkg="$1"
  local backup_dir="$2"
  if [[ -n "$backup_dir" ]] && [[ -d "$backup_dir" ]]; then
    log "Rolling back to backup: $backup_dir"
    if [[ -w "$server_pkg" ]]; then
      rm -rf "$server_pkg/ui-dist"
      cp -r "$backup_dir" "$server_pkg/ui-dist"
    else
      sudo rm -rf "$server_pkg/ui-dist"
      sudo cp -r "$backup_dir" "$server_pkg/ui-dist"
    fi
    log "Rollback complete. Original ui-dist restored."
  else
    warn "No backup to restore — ui-dist may be in a broken state."
  fi
}

# ── Source patch ──────────────────────────────────────────────────────────────

apply_source_patch() {
  local src_file="$1"
  [[ -f "$src_file" ]] || die "MarkdownEditor.tsx not found: $src_file"

  if grep -q "toolbarPlugin" "$src_file" 2>/dev/null; then
    log "toolbarPlugin already present in source — skipping source patch step."
    return
  fi

  log "Patching $(basename "$src_file")..."

  node - "$src_file" << 'PATCH_JS'
const fs = require('fs');
const filePath = process.argv[2];
let src = fs.readFileSync(filePath, 'utf8');

// ── Step 1: Add toolbar imports to the @mdxeditor/editor import block ──
const OLD_IMPORT_CLOSE = `  type RealmPlugin,\n} from "@mdxeditor/editor";`;
const NEW_IMPORT_CLOSE = `  type RealmPlugin,
  // PAPERCLIP-TOOLBAR-PATCH-v1
  toolbarPlugin,
  KitchenSinkToolbar,
  diffSourcePlugin,
  frontmatterPlugin,
  directivesPlugin,
  AdmonitionDirectiveDescriptor,
} from "@mdxeditor/editor";`;

if (src.includes(OLD_IMPORT_CLOSE)) {
  src = src.replace(OLD_IMPORT_CLOSE, NEW_IMPORT_CLOSE);
} else {
  src = src.replace(
    /} from "@mdxeditor\/editor";/,
    `  // PAPERCLIP-TOOLBAR-PATCH-v1
  toolbarPlugin,
  KitchenSinkToolbar,
  diffSourcePlugin,
  frontmatterPlugin,
  directivesPlugin,
  AdmonitionDirectiveDescriptor,
} from "@mdxeditor/editor";`
  );
}

// ── Step 2: Add toolbar plugins to the plugins array ──
const OLD_PLUGINS_END = `      markdownShortcutPlugin(),\n    ];`;
const NEW_PLUGINS_END = `      markdownShortcutPlugin(),
      // PAPERCLIP-TOOLBAR-PATCH-v1
      frontmatterPlugin(),
      directivesPlugin({
        directiveDescriptors: [AdmonitionDirectiveDescriptor],
      }),
      diffSourcePlugin({ viewMode: "rich-text" }),
      toolbarPlugin({
        toolbarContents: () => <KitchenSinkToolbar />,
      }),
    ];`;

if (src.includes(OLD_PLUGINS_END)) {
  src = src.replace(OLD_PLUGINS_END, NEW_PLUGINS_END);
} else {
  const fallbackRe = /(    const all: RealmPlugin\[\] = \[[\s\S]*?markdownShortcutPlugin\(\),\s*\n)(\s*\];)/;
  if (fallbackRe.test(src)) {
    src = src.replace(fallbackRe, (_, body, close) => {
      return body +
        `      // PAPERCLIP-TOOLBAR-PATCH-v1\n` +
        `      frontmatterPlugin(),\n` +
        `      directivesPlugin({\n` +
        `        directiveDescriptors: [AdmonitionDirectiveDescriptor],\n` +
        `      }),\n` +
        `      diffSourcePlugin({ viewMode: "rich-text" }),\n` +
        `      toolbarPlugin({\n` +
        `        toolbarContents: () => <KitchenSinkToolbar />,\n` +
        `      }),\n` +
        close;
    });
  } else {
    process.stderr.write('[patch] WARNING: Could not locate plugins array closing — patch may be incomplete.\n');
  }
}

fs.writeFileSync(filePath, src, 'utf8');
process.stdout.write('[patch] Source patch applied to ' + require('path').basename(filePath) + '\n');
PATCH_JS
}

# ── CSS injection ─────────────────────────────────────────────────────────────

inject_toolbar_css() {
  local dist_dir="$1"

  # Toolbar CSS lives in a single source-of-truth file next to this script so it
  # can be tweaked without touching shell here-docs. It begins with the
  # PAPERCLIP-TOOLBAR-PATCH marker comment that the idempotency / verification
  # checks grep for.
  local css_src=""
  for cand in \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/assets/mdxeditor-toolbar.css" \
    "/opt/paperclip/build.d/assets/mdxeditor-toolbar.css" \
    "/opt/paperclip/mdxeditor-toolbar.css"; do
    if [[ -f "$cand" ]]; then css_src="$cand"; break; fi
  done
  if [[ -z "$css_src" ]]; then
    warn "mdxeditor-toolbar.css not found beside script or in /opt/paperclip — skipping CSS injection."
    return
  fi

  local index="$dist_dir/index.html"
  if [[ ! -f "$index" ]]; then
    warn "index.html not found in $dist_dir — skipping CSS injection."
    return
  fi

  # IMPORTANT: do NOT append to the Vite-built CSS. That file is served
  # `Cache-Control: immutable, max-age=1y`, but its content hash is computed by
  # Vite BEFORE our append — so editing it in place leaves the URL unchanged while
  # the content differs, and every cache layer (browser, Cloudflare/cloudflared,
  # service worker) serves the stale version forever. Instead we ship our CSS as
  # its OWN file named with a hash of ITS content, and link it from index.html
  # (which is served `no-cache`). Any change to the CSS → new hash → new URL →
  # caches bust correctly, and the immutable directive becomes truthful.
  local hash out_name
  hash=$(sha256sum "$css_src" | cut -c1-12)
  out_name="paperclip-toolbar.${hash}.css"
  cp "$css_src" "$dist_dir/assets/$out_name"
  log "Wrote toolbar stylesheet assets/$out_name"

  # Drop any previous paperclip-toolbar <link> (stale hash), then inject the new
  # one right AFTER the main Vite stylesheet so it wins on equal specificity.
  sed -i '/paperclip-toolbar\.[^"]*\.css/d' "$index"
  sed -i "s#\(<link rel=\"stylesheet\"[^>]*href=\"/assets/index-[A-Za-z0-9_-]*\.css\"[^>]*>\)#\1\n    <link rel=\"stylesheet\" href=\"/assets/${out_name}\">#" "$index"

  if grep -q "$out_name" "$index"; then
    log "Linked toolbar stylesheet into index.html"
  else
    warn "Could not inject <link> into index.html (main stylesheet pattern not found) — toolbar CSS not loaded."
  fi
}

# ── Resolve workspace references ─────────────────────────────────────────────

resolve_workspace_refs() {
  local ui_dir="$1"
  node -e "
    const fs = require('fs');
    const pkgPath = process.argv[1] + '/package.json';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let changed = 0;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [k, v] of Object.entries(pkg[section] || {})) {
        if (typeof v === 'string' && v.startsWith('workspace:')) {
          pkg[section][k] = v.replace(/^workspace:/, '') || '*';
          changed++;
        }
      }
    }
    delete pkg.scripts.prepack;
    delete pkg.scripts.postpack;

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    process.stderr.write('[patch] Resolved ' + changed + ' workspace: references.\n');
  " "$ui_dir"
}

# ── Derive version pins from the monorepo lockfile ───────────────────────────
# The single source of truth for a mutually-consistent @assistant-ui graph is
# the monorepo's own pnpm-lock.yaml: it pins the EXACT versions paperclip builds
# and ships with. Once we drop that lockfile to build ui standalone, every
# @assistant-ui dep otherwise floats to the newest in-range version and the graph
# self-conflicts — e.g. react@0.14.14 imports "@assistant-ui/tap/react" (a subpath
# that only exists on the tap-0.5.x line), while a floated store/core pulls
# "@assistant-ui/tap/react-shim/compiler-runtime" (tap 0.8+ only). No single tap
# exports both, so Vite dies with a "Missing specifier" error. react-shim is a
# tap-fiber-aware React wrapper (NOT a plain re-export), so shimming it onto an
# older tap would build but corrupt runtime behaviour — pinning the whole family
# to the locked era is the only correct fix.
#
# Rather than hardcode versions (which rot at every server bump), we read them
# back from the lockfile and pin every @assistant-ui/* + assistant-stream/cloud
# package that resolves to a SINGLE version. Writes overrides to BOTH
# pnpm-workspace.yaml (pnpm 11 reads overrides only from there) and
# package.json#overrides (npm fallback), plus a .paperclip-pins.json the
# post-install assertion verifies against.
write_lockfile_pins() {
  local ui_dir="$1"
  local lockfile="$2"
  node - "$ui_dir" "$lockfile" << 'PINS_JS'
const fs = require('fs');
const uiDir = process.argv[2];
const lockfile = process.argv[3];

if (!fs.existsSync(lockfile)) {
  process.stderr.write('[patch] WARNING: monorepo lockfile not found (' + lockfile + ') — cannot derive pins.\n');
  process.exit(0);
}

// Collect every "<pkg>@<version>" token for the assistant-ui family. A package
// is only safe to pin if the lockfile resolved it to exactly one version.
const text = fs.readFileSync(lockfile, 'utf8');
const re = /(@assistant-ui\/[a-z0-9-]+|assistant-stream|assistant-cloud)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
const versions = {};
let m;
while ((m = re.exec(text)) !== null) {
  (versions[m[1]] ||= new Set()).add(m[2]);
}

const pins = {};
for (const [pkg, set] of Object.entries(versions)) {
  if (set.size === 1) pins[pkg] = [...set][0];
  else process.stderr.write('[patch] note: ' + pkg + ' has ' + set.size + ' versions in lockfile [' + [...set].join(', ') + '] — left to float.\n');
}

if (Object.keys(pins).length === 0) {
  process.stderr.write('[patch] WARNING: derived 0 pins from lockfile — build may float and break.\n');
  process.exit(0);
}

// 1) package.json#overrides (npm fallback path)
const pkgPath = uiDir + '/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.overrides = Object.assign({}, pkg.overrides, pins);
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

// 2) pnpm-workspace.yaml overrides (pnpm 11 source of truth)
const yaml = 'overrides:\n' +
  Object.entries(pins).map(([k, v]) => `  "${k}": "${v}"`).join('\n') + '\n';
fs.writeFileSync(uiDir + '/pnpm-workspace.yaml', yaml);

// 3) pins manifest for the post-install assertion
fs.writeFileSync(uiDir + '/.paperclip-pins.json', JSON.stringify(pins, null, 2));

process.stderr.write('[patch] Derived ' + Object.keys(pins).length + ' version pins from monorepo lockfile:\n');
for (const [k, v] of Object.entries(pins)) process.stderr.write('[patch]   ' + k + '@' + v + '\n');
PINS_JS
}

# ── npm / pnpm install ────────────────────────────────────────────────────────

install_deps() {
  local ui_dir="$1"
  cd "$ui_dir"

  resolve_workspace_refs "$ui_dir"

  local repo_root
  repo_root=$(cd "$ui_dir/.." && pwd)

  # Derive the @assistant-ui version pins from the monorepo lockfile BEFORE we
  # delete it (see write_lockfile_pins). This writes pnpm-workspace.yaml +
  # package.json#overrides + .paperclip-pins.json.
  write_lockfile_pins "$ui_dir" "$repo_root/pnpm-lock.yaml"

  rm -f "$repo_root/pnpm-workspace.yaml" "$repo_root/pnpm-lock.yaml" 2>/dev/null || true

  if command -v pnpm >/dev/null 2>&1; then
    log "Installing UI dependencies with pnpm..."
    NODE_ENV= pnpm install --no-frozen-lockfile 2>&1 | tail -10 || true
    if [[ ! -d "$ui_dir/node_modules" ]]; then
      die "pnpm install produced no node_modules"
    fi
    return
  fi

  log "pnpm not found — using npm..."
  NODE_ENV= npm install --legacy-peer-deps --ignore-scripts 2>&1 | tail -10 || true
  if [[ ! -d "$ui_dir/node_modules" ]]; then
    die "npm install produced no node_modules"
  fi
}

# ── Assert the version overrides actually took ───────────────────────────────
# pnpm has, in the past, silently ignored the pnpm-workspace.yaml overrides when
# ui_dir is not recognised as the install root, letting @assistant-ui/store float
# to 0.2.18 (which needs tap 0.8+) while tap stays at 0.5.14 -> the Vite build
# then dies on the missing "./react-shim/compiler-runtime" subpath. Catch that
# here, loudly, BEFORE the multi-minute build instead of deep in Rollup output.
assert_pinned_versions() {
  local ui_dir="$1"
  node - "$ui_dir" << 'ASSERT_JS'
const fs = require('fs');
const path = require('path');
const uiDir = process.argv[2];

// Expected versions come from .paperclip-pins.json, derived from the monorepo
// lockfile by write_lockfile_pins. If absent, there is nothing to assert.
const pinsPath = path.join(uiDir, '.paperclip-pins.json');
if (!fs.existsSync(pinsPath)) {
  process.stderr.write('[patch] WARNING: .paperclip-pins.json missing — skipping pin assertion.\n');
  process.exit(0);
}
const expect = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));

function resolvedVersions(nodeModules, pkgName) {
  const found = new Set();
  const direct = path.join(nodeModules, pkgName, 'package.json');
  if (fs.existsSync(direct)) found.add(JSON.parse(fs.readFileSync(direct, 'utf8')).version);
  const pnpmDir = path.join(nodeModules, '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      const nested = path.join(pnpmDir, entry, 'node_modules', pkgName, 'package.json');
      if (fs.existsSync(nested)) found.add(JSON.parse(fs.readFileSync(nested, 'utf8')).version);
    }
  }
  return [...found];
}

const nm = path.join(uiDir, 'node_modules');
let bad = false;
for (const [pkg, want] of Object.entries(expect)) {
  const got = resolvedVersions(nm, pkg);
  if (got.length === 0) {
    process.stderr.write(`[patch] WARNING: ${pkg} not found in node_modules (skipping assertion).\n`);
    continue;
  }
  if (got.length !== 1 || got[0] !== want) {
    process.stderr.write(`[patch] ERROR: ${pkg} resolved to [${got.join(', ')}], expected exactly ${want}. Override did not take.\n`);
    bad = true;
  } else {
    process.stderr.write(`[patch] OK: ${pkg}@${want} pinned correctly.\n`);
  }
}
process.exit(bad ? 1 : 0);
ASSERT_JS
}

# ── Fix missing package exports (standalone build workaround) ─────────────────

fix_missing_exports() {
  local ui_dir="$1"
  log "Fixing missing package exports for standalone build..."

  node - "$ui_dir" << 'FIX_EXPORTS_JS'
const fs = require('fs');
const path = require('path');
const uiDir = process.argv[2];

// Walk node_modules (including pnpm .pnpm store) looking for packages
// that are missing subpath exports referenced by the codebase.
const fixes = [
  {
    pkg: '@assistant-ui/tap',
    subpath: './react-shim',
    shimContent: 'export * from "react";\nexport { default } from "react";\n',
    shimFile: 'react-shim.mjs'
  }
];

function findPackageDirs(nodeModules, pkgName) {
  const dirs = [];
  // Direct path
  const direct = path.join(nodeModules, pkgName);
  if (fs.existsSync(path.join(direct, 'package.json'))) {
    dirs.push(direct);
  }
  // pnpm .pnpm store
  const pnpmDir = path.join(nodeModules, '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    try {
      const entries = fs.readdirSync(pnpmDir);
      for (const entry of entries) {
        const nested = path.join(pnpmDir, entry, 'node_modules', pkgName);
        if (fs.existsSync(path.join(nested, 'package.json'))) {
          dirs.push(nested);
        }
      }
    } catch (e) { /* ignore permission errors */ }
  }
  return dirs;
}

let totalFixed = 0;

for (const fix of fixes) {
  const pkgDirs = findPackageDirs(path.join(uiDir, 'node_modules'), fix.pkg);
  for (const pkgDir of pkgDirs) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const exports = pkg.exports || {};

      // Check if the subpath already exists
      if (exports[fix.subpath]) continue;

      // Create the shim file
      const shimPath = path.join(pkgDir, fix.shimFile);
      fs.writeFileSync(shimPath, fix.shimContent, 'utf8');

      // Add to exports map
      if (typeof exports === 'object' && !Array.isArray(exports)) {
        pkg.exports = pkg.exports || {};
        pkg.exports[fix.subpath] = {
          import: './' + fix.shimFile,
          default: './' + fix.shimFile
        };
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2), 'utf8');
        process.stderr.write('[patch] Fixed missing export ' + fix.subpath + ' in ' + pkgDir + '\n');
        totalFixed++;
      }
    } catch (e) {
      process.stderr.write('[patch] WARNING: Could not fix ' + fix.pkg + ' at ' + pkgDir + ': ' + e.message + '\n');
    }
  }
}

process.stderr.write('[patch] Fixed ' + totalFixed + ' missing package exports.\n');
FIX_EXPORTS_JS
}

# ── Build ─────────────────────────────────────────────────────────────────────

build_ui() {
  local ui_dir="$1"
  cd "$ui_dir"

  log "Running Vite build (NODE_ENV=production)..."
  NODE_ENV=production node_modules/.bin/vite build 2>&1
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  log "MDXEditor KitchenSinkToolbar patch — starting"

  check_command node
  check_command git

  local server_pkg
  server_pkg=$(find_server_pkg)
  log "Server package: $server_pkg"

  local ui_dist="$server_pkg/ui-dist"
  [[ -d "$ui_dist" ]] || die "ui-dist directory not found: $ui_dist"

  if check_already_patched "$server_pkg"; then
    log "✓ Toolbar patch already applied — nothing to do."
    exit 0
  fi

  local version
  version=$(get_version "$server_pkg")
  log "Detected @paperclipai/server version: $version"

  if ! check_version_compat "$version"; then
    warn "⚠ Version $version is NOT in the tested list [${KNOWN_VERSIONS[*]}]"
    warn "  Proceeding anyway (this may fail if the patch is incompatible with this version)"
    warn "  If it fails, report to ops and we'll update KNOWN_VERSIONS."
    # Auto-enable for new versions — don't block
    FORCE=true
  fi

  local git_tag="v${version}"

  tmp_dir=$(mktemp -d -t paperclip-toolbar-patch.XXXXXX)
  log "Temp workspace: $tmp_dir"

  local backup_dir=""

  cleanup() {
    log "Cleaning temp workspace..."
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT

  on_error() {
    local exit_code=$?
    log "Encountered error (exit $exit_code) — rolling back..."
    rollback "$server_pkg" "$backup_dir"
    log "✗ Patch failed. Check the output above for details."
    exit 1
  }
  trap on_error ERR

  backup_dir=$(backup_ui_dist "$server_pkg")

  log "Cloning $REPO_URL at $git_tag..."
  git clone \
    --depth 1 \
    --branch "$git_tag" \
    --filter=blob:none \
    --sparse \
    "$REPO_URL" \
    "$tmp_dir/repo" \
    2>&1 | grep -v "^$" | tail -5
  wait  # Ensure git clone fully exits before proceeding

  cd "$tmp_dir/repo"
  git sparse-checkout init --cone
  local sparse_out
  sparse_out=$(git sparse-checkout set ui 2>&1)
  echo "$sparse_out" | tail -3
  wait  # Ensure git sparse-checkout fully exits

  local repo_dir="$tmp_dir/repo"
  local ui_dir="$repo_dir/ui"
  local src_file="$ui_dir/src/components/MarkdownEditor.tsx"

  [[ -f "$src_file" ]] || die "MarkdownEditor.tsx not found: $src_file"
  log "Source located: $src_file"

  apply_source_patch "$src_file"

  install_deps "$ui_dir"

  # Fail loud if the @assistant-ui version pins did not take (see comment above
  # assert_pinned_versions) — cheaper to catch here than after the Vite build.
  assert_pinned_versions "$ui_dir"

  # Fix missing exports from workspace packages that don't resolve
  # correctly when installed standalone (outside the monorepo)
  fix_missing_exports "$ui_dir"

  build_ui "$ui_dir"

  local dist_dir="$ui_dir/dist"
  [[ -f "$dist_dir/index.html" ]] || die "Vite build failed — $dist_dir/index.html not found."

  inject_toolbar_css "$dist_dir"

  log "Replacing ui-dist with new build output..."
  if [[ -w "$ui_dist" ]]; then
    rm -rf "$ui_dist"
    cp -r "$dist_dir" "$ui_dist"
    printf "version=%s\napplied=%s\n" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$ui_dist/$PATCH_MARKER_FILE"
  else
    log "ui-dist is not writable by current user — using sudo..."
    sudo rm -rf "$ui_dist"
    sudo cp -r "$dist_dir" "$ui_dist"
    printf "version=%s\napplied=%s\n" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      | sudo tee "$ui_dist/$PATCH_MARKER_FILE" > /dev/null
  fi

  [[ -f "$ui_dist/$PATCH_MARKER_FILE" ]] || die "Patch marker file missing after copy."
  if grep -rqlF "$PATCH_MARKER_CSS" "$ui_dist/assets" 2>/dev/null; then
    log "CSS marker verified ✓"
  else
    warn "CSS marker not found in any assets CSS — CSS injection may need manual verification."
  fi
  if grep -q "paperclip-toolbar\..*\.css" "$ui_dist/index.html" 2>/dev/null; then
    log "Toolbar stylesheet <link> verified in index.html ✓"
  else
    warn "Toolbar stylesheet <link> missing from index.html — toolbar CSS will not load."
  fi

  log ""
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "✓ MDXEditor toolbar patch applied successfully!"
  log "  Version:  $version"
  log "  Backup:   $backup_dir"
  log "  Marker:   $ui_dist/$PATCH_MARKER_FILE"
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log ""
  log "Restart Paperclip to apply:"
  log "  paperclipai restart"
  log "  — or via Docker: docker restart <container>"
  log ""
  log "To roll back manually:"
  log "  rm -rf '$ui_dist' && cp -r '$backup_dir' '$ui_dist'"
}

main "$@"
