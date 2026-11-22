#!/usr/bin/env node
// patch-registry.js — Registers custom adapters (qwen_local, vibe_local)
// into the Paperclip server adapter registry and shared constants.
//
// Usage: node patch-registry.js <paperclipai_root>
//
// This script modifies the compiled JS files in place. It is idempotent:
// running it multiple times will not duplicate entries.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("Usage: node patch-registry.js <paperclipai_root>");
  process.exit(1);
}

const CUSTOM_TYPES = ["qwen_local", "vibe_local"];

// ─── 1. Patch AGENT_ADAPTER_TYPES in shared/constants ───────────────────────

const constantsPath = join(root, "node_modules/@paperclipai/shared/dist/constants.js");
let constants = readFileSync(constantsPath, "utf-8");

for (const adapterType of CUSTOM_TYPES) {
  if (!constants.includes(`"${adapterType}"`)) {
    constants = constants.replace(
      `"hermes_local"`,
      `"hermes_local","${adapterType}"`
    );
  }
}
writeFileSync(constantsPath, constants);
console.log("[patch] constants.js — AGENT_ADAPTER_TYPES updated");

// ─── 2. Patch AGENT_ADAPTER_TYPES in main dist/index.js (CLI) ──────────────

const mainIndexPath = join(root, "dist/index.js");
let mainIndex = readFileSync(mainIndexPath, "utf-8");

for (const adapterType of CUSTOM_TYPES) {
  if (!mainIndex.includes(`"${adapterType}"`)) {
    mainIndex = mainIndex.replace(
      `"hermes_local"`,
      `"hermes_local","${adapterType}"`
    );
  }
}
writeFileSync(mainIndexPath, mainIndex);
console.log("[patch] dist/index.js — AGENT_ADAPTER_TYPES updated");

// ─── 3. Patch server adapter registry ───────────────────────────────────────

const registryPath = join(root, "node_modules/@paperclipai/server/dist/adapters/registry.js");
let registry = readFileSync(registryPath, "utf-8");

const ADAPTERS_DIR = "/usr/local/lib/paperclip-custom-adapters";

const adapterDefs = {
  qwen_local: {
    varName: "qwenLocalAdapter",
    importPath: `${ADAPTERS_DIR}/qwen-local/index.js`,
  },
  vibe_local: {
    varName: "vibeLocalAdapter",
    importPath: `${ADAPTERS_DIR}/vibe-local/index.js`,
  },
};

// Add imports at the top (after the last existing import)
const importLines = [];
const adapterObjectLines = [];

for (const [adapterType, def] of Object.entries(adapterDefs)) {
  if (registry.includes(def.varName)) {
    console.log(`[patch] registry.js — ${adapterType} already registered, skipping`);
    continue;
  }

  importLines.push(
    `import { type as ${def.varName}Type, execute as ${def.varName}Execute, testEnvironment as ${def.varName}TestEnv, models as ${def.varName}Models, agentConfigurationDoc as ${def.varName}Doc } from "${def.importPath}";`
  );

  adapterObjectLines.push(`const ${def.varName} = {
    type: ${def.varName}Type,
    execute: ${def.varName}Execute,
    testEnvironment: ${def.varName}TestEnv,
    models: ${def.varName}Models,
    agentConfigurationDoc: ${def.varName}Doc,
};`);
}

if (importLines.length > 0) {
  // Insert imports after the last existing import line
  const lastImportIdx = registry.lastIndexOf("\nimport ");
  const nextNewline = registry.indexOf("\n", lastImportIdx + 1);
  registry =
    registry.slice(0, nextNewline + 1) +
    importLines.join("\n") +
    "\n" +
    registry.slice(nextNewline + 1);

  // Insert adapter object definitions before `const adaptersByType`
  registry = registry.replace(
    "const adaptersByType",
    adapterObjectLines.join("\n") + "\nconst adaptersByType"
  );

  // Add to the adaptersByType map array
  registry = registry.replace(
    "    hermesLocalAdapter,",
    `    hermesLocalAdapter,\n    ${Object.values(adapterDefs).map((d) => d.varName).join(",\n    ")},`
  );
}

writeFileSync(registryPath, registry);
console.log("[patch] registry.js — custom adapters registered");

// ─── 4. Patch DEFAULT_INSTRUCTIONS_PATH_KEYS in routes/agents.js ────────────

const agentsRoutePath = join(root, "node_modules/@paperclipai/server/dist/routes/agents.js");
let agentsRoute = readFileSync(agentsRoutePath, "utf-8");

for (const adapterType of CUSTOM_TYPES) {
  if (!agentsRoute.includes(`${adapterType}:`)) {
    agentsRoute = agentsRoute.replace(
      `pi_local: "instructionsFilePath",`,
      `pi_local: "instructionsFilePath", ${adapterType}: "instructionsFilePath",`
    );
  }
}
writeFileSync(agentsRoutePath, agentsRoute);
console.log("[patch] routes/agents.js — instructionsFilePath keys updated");

console.log("\n✓ All patches applied successfully");
