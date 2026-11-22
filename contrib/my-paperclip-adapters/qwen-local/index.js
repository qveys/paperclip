// Qwen Local adapter — wraps @qwen-code/qwen-code CLI as a Paperclip adapter.
// Derives from the process adapter with qwen-specific defaults and validation.

import { execute as processExecute } from "../process/execute.js";
import {
  asString,
  asNumber,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
} from "../utils.js";

const DEFAULT_COMMAND = "qwen";

// ── Metadata ────────────────────────────────────────────────────────────────

export const type = "qwen_local";
export const label = "Qwen (local)";
export const models = [
  { id: "qwen3-coder", label: "Qwen 3 Coder" },
];

export const agentConfigurationDoc = `# qwen_local adapter

Runs the Qwen Code CLI locally.

Core fields:
- command  (string, optional): path to the qwen binary (default: "qwen")
- cwd      (string, required): working directory (absolute path)
- env      (object, optional): environment variables (supports secret refs)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec   (number, optional): SIGTERM grace period
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
      code: "qwen_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "qwen_cwd_invalid",
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
      code: "qwen_cli_found",
      level: "info",
      message: `Qwen CLI is executable: ${command}`,
    });
  } catch {
    checks.push({
      code: "qwen_cli_missing",
      level: "error",
      message: `Qwen CLI not found: ${command}`,
      hint: "Install with: npm install -g @qwen-code/qwen-code",
    });
  }

  // Check API key
  const hasKey =
    runtimeEnv.DASHSCOPE_API_KEY ||
    runtimeEnv.QWEN_API_KEY ||
    config.env?.DASHSCOPE_API_KEY;
  if (hasKey) {
    checks.push({
      code: "qwen_api_key_present",
      level: "info",
      message: "API key detected",
    });
  } else {
    checks.push({
      code: "qwen_api_key_missing",
      level: "warn",
      message: "No DASHSCOPE_API_KEY or QWEN_API_KEY found",
      hint: "Set DASHSCOPE_API_KEY in agent env or system environment",
    });
  }

  return {
    adapterType: type,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
