#!/usr/bin/env bash
#
# 40-plugin-ui-static-uuid.sh
#
# Fix HTTP 500 on the plugin UI asset route when a plugin is addressed by its
# KEY instead of its database UUID.
#
# Route: GET /_plugins/:pluginId/ui/*filePath  (routes/plugin-ui-static.js)
# It documents accepting EITHER a UUID or a plugin key (e.g. "agent-pixels.camera")
# and is meant to do: getById(pluginId) first, and on an "invalid uuid" Postgres
# error (SQLSTATE 22P02) fall through to getByKey(pluginId).
#
# Bug: the fallback never fires. The shipped code inspects `error.code`, but the
# current drizzle-orm wraps the driver error in a DrizzleQueryError whose own
# `.code` is undefined — the real PostgresError (code "22P02") sits on
# `error.cause`. So `maybeCode !== "22P02"` is always true → the error is
# rethrown → 500. Symptom: Agent Pixels UI ("Failed to fetch character index:
# 500") because its asset URLs use the plugin key, not the UUID. Any key-addressed
# plugin asset is affected.
#
# Fix: walk the `.cause` chain (a few levels, defensively) when extracting the
# error code, so the getById->getByKey fallback works again. UUID lookups are
# unaffected (they never hit the catch); a genuine non-22P02 DB error still
# rethrows.
#
# Build-time, idempotent, fail-loud: if the anchor disappears on an upstream bump
# (and the marker is absent), FAIL the build rather than ship an image that 500s
# on key-addressed plugin UIs.
set -euo pipefail

# Shared helpers (pc_die) + constants (PC_SERVER_DIST_DEFAULT) + the anchor-patch
# engine (lib/patch.js, require'd from the here-doc below).
source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="ui-static-uuid"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

BASE="${PAPERCLIP_SERVER_DIST:-$PC_SERVER_DIST_DEFAULT}"
TARGET="${TARGET_OVERRIDE:-$BASE/routes/plugin-ui-static.js}"

[ -f "$TARGET" ] || pc_die "target not found: $TARGET"

TARGET_FILE="$TARGET" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE'
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const MARKER = 'PAPERCLIP_UI_STATIC_UUID_PATCH';
const file = process.env.TARGET_FILE;

const anchor =
'            const maybeCode = typeof error === "object" && error !== null && "code" in error\n' +
'                ? error.code\n' +
'                : undefined;\n' +
'            if (maybeCode !== "22P02") {\n' +
'                throw error;\n' +
'            }';

const replacement =
'            // ' + MARKER + ': drizzle-orm wraps the driver error, so the 22P02\n' +
'            // (invalid uuid syntax) code lives on error.cause, not error.code.\n' +
'            // Walk the cause chain so the getById -> getByKey fallback fires.\n' +
'            let __pcErr = error, __pcCode;\n' +
'            for (let __i = 0; __pcErr && __i < 6; __i++, __pcErr = __pcErr.cause) {\n' +
'                if (typeof __pcErr === "object" && __pcErr !== null && "code" in __pcErr && __pcErr.code) { __pcCode = __pcErr.code; break; }\n' +
'            }\n' +
'            if (__pcCode !== "22P02") {\n' +
'                throw error;\n' +
'            }';

applyPatch({ file, marker: MARKER, mode: 'loud', prefix: 'ui-static-uuid',
             edits: [{ anchor, replacement }] });
NODE
