// lib/adapter-registry.js — shared upsert logic for adapter-plugins.json.
//
// Used by entrypoint.d/40-register-junie-adapter.sh and
// entrypoint.d/45-register-hermes-adapter.sh, which otherwise duplicate this
// exact upsert-by-type logic verbatim for their own external adapter package.
const fs = require("fs");

function upsertAdapterRecord(store, packageName, type) {
  let arr = [];
  try {
    const raw = fs.readFileSync(store, "utf8").trim();
    if (raw) arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  const idx = arr.findIndex((r) => r && r.type === type);
  const record = {
    packageName,
    type,
    version: "0.1.0",
    installedAt: idx >= 0 && arr[idx].installedAt ? arr[idx].installedAt : new Date().toISOString(),
  };
  if (idx >= 0) arr[idx] = { ...arr[idx], ...record };
  else arr.push(record);
  fs.writeFileSync(store, JSON.stringify(arr, null, 2) + "\n");
}

module.exports = { upsertAdapterRecord };
