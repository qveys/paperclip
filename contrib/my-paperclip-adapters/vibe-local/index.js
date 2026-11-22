// Vibe Local adapter — wraps Mistral Vibe CLI as a Paperclip adapter.
// Derives from the process adapter with vibe-specific defaults and validation.

import { execute as processExecute } from "../process/execute.js";
import {
  asString,
  asNumber,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
} from "../utils.js";

const DEFAULT_COMMAND = "vibe";

// ── Metadata ────────────────────────────────────────────────────────────────

export const type = "vibe_local";
export const label = "Vibe / Mistral (local)";
export const models = [
  { id: "devstral-2", label: "Devstral 2" },
];

export const agentConfigurationDoc = `# vibe_local adapter

Runs the Mistral Vibe CLI locally (powered by Devstral).

Core fields:
- command  (string, optional): path to the vibe binary (default: "vibe")
- cwd      (string, required): working directory (absolute path)
- env      (object, optional): environment variables (supports secret refs)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec   (number, optional): SIGTERM grace period

Notes:
- Vibe uses --prompt for non-interactive mode and --output json for structured output.
- Authentication via MISTRAL_API_KEY env var or ~/.vibe/.env.
`;

// ── Execute ─────────────────────────────────────────────────────────────────

export function execute(ctx) {
  const config = { ...ctx.config };
  if (!config.command) config.command = DEFAULT_COMMAND;
  return processExecute({ ...ctx, config });
}

// ── Test Environment ────────────────────────────────────────────────────────

function summarizeStatus(checks) {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(ctx) {
  const checks = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, DEFAULT_COMMAND);
  const cwd = asString(config.cwd, process.cwd());

  // Check working directory
  try {
    await ensureAbsoluteDirectory(cwd);
    checks.push({
      code: "vibe_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "vibe_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Check command resolves
  const envConfig = parseObject(config.env);
  const env = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "vibe_cli_found",
      level: "info",
      message: `Vibe CLI is executable: ${command}`,
    });
  } catch {
    checks.push({
      code: "vibe_cli_missing",
      level: "error",
      message: `Vibe CLI not found: ${command}`,
      hint: "Install with: pip install mistral-vibe",
    });
  }

  // Check API key
  const hasKey =
    runtimeEnv.MISTRAL_API_KEY || config.env?.MISTRAL_API_KEY;
  if (hasKey) {
    checks.push({
      code: "vibe_api_key_present",
      level: "info",
      message: "MISTRAL_API_KEY detected",
    });
  } else {
    checks.push({
      code: "vibe_api_key_missing",
      level: "warn",
      message: "No MISTRAL_API_KEY found",
      hint: "Set MISTRAL_API_KEY in agent env or run 'vibe --setup'",
    });
  }

  return {
    adapterType: type,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
