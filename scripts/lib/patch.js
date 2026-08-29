'use strict';
// lib/patch.js — shared "anchor patch" engine for the Paperclip image scripts.
//
// Generalises the per-script boilerplate that every build.d/ and entrypoint.d/
// Node here-doc used to re-implement by hand: read file -> idempotency-marker
// check -> locate literal source anchor(s) -> replace -> write. The big
// anchor/replacement string literals STAY in each caller's here-doc (so they
// remain reviewable and byte-exact); only this plumbing is shared.
//
// require()'d from a here-doc via a bash-exported path so it resolves at BOTH
// build and boot (same tree-preserving COPY as lib/common.sh):
//     PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"
//     ... PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE'
//       const { applyPatch } = require(process.env.PC_PATCH_LIB);
//
// applyPatch({ file, marker, edits, mode, atomic, prefix }) -> boolean
//   file    : path to patch (string, required)
//   marker  : unique idempotency marker; if already in the file -> skip + false
//   edits   : [{ anchor, replacement, label?, optional? }] applied in order.
//             Replacement uses String.prototype.replace(anchor, replacement)
//             — first occurrence, same semantics every caller already relied on.
//   mode    : 'loud' (build) -> a missing REQUIRED anchor prints FATAL and
//                                process.exit(1) (fail the build).
//             'soft' (boot)  -> a missing REQUIRED anchor prints WARN and
//                                returns false WITHOUT writing (boot continues).
//   atomic  : true -> write via <file>.tmp + rename (volume files may be owned by
//             another uid: parent dir is ours, so an atomic swap succeeds and
//             normalises ownership). false (default) -> writeFileSync in place.
//   prefix  : log tag, emitted as `[prefix] …` to match the bash-side logging.
//
// Invariant: ALL anchors are validated against the original source before any
// replacement, so a partial/failed match never writes a half-patched file.
// Returns true if it wrote the patch, false if it skipped (already patched, or a
// soft-mode required-anchor miss, or nothing left to apply).
const fs = require('fs');

function applyPatch(opts) {
  const file = opts.file;
  const marker = opts.marker;
  const edits = opts.edits || [];
  const mode = opts.mode || 'loud';
  const atomic = !!opts.atomic;
  const prefix = opts.prefix || 'patch';
  const log = (m) => console.log('[' + prefix + '] ' + m);
  const warn = (m) => console.error('[' + prefix + '] ' + m);

  const src0 = fs.readFileSync(file, 'utf8');
  if (marker && src0.includes(marker)) {
    log('already patched (' + marker + '), skipping: ' + file);
    return false;
  }

  // Validate every anchor up-front (against the untouched source).
  const toApply = [];
  for (const e of edits) {
    const label = e.label ? ' (' + e.label + ')' : '';
    if (src0.includes(e.anchor)) {
      toApply.push(e);
      continue;
    }
    if (e.optional) {
      warn('WARN: optional anchor not found' + label + ' in ' + file + ' — that edit skipped.');
      continue;
    }
    if (mode === 'soft') {
      warn('WARN: anchor not found' + label + ' in ' + file + ' (plugin version changed?) — leaving file untouched.');
      return false;
    }
    warn('FATAL: anchor not found' + label + ' in ' + file + ' — upstream layout changed, review before shipping.');
    process.exit(1);
  }

  if (toApply.length === 0) {
    log('nothing to apply: ' + file);
    return false;
  }

  let src = src0;
  for (const e of toApply) src = src.replace(e.anchor, e.replacement);

  if (atomic) {
    const tmp = file + '.pcpatch.tmp';
    fs.writeFileSync(tmp, src);
    fs.renameSync(tmp, file);
  } else {
    fs.writeFileSync(file, src);
  }
  log('applied to ' + file);
  return true;
}

module.exports = { applyPatch };
