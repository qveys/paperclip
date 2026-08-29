// @paperclip-custom/adapter-antigravity-local
//
// External Paperclip adapter that runs the Antigravity CLI (agy) locally.
// Modeled on @paperclip-custom/adapter-junie-local (CLI-based, local execution).
// agy --print outputs plain text to stdout (no JSON stream).

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  readAdapterExecutionTarget,
  adapterExecutionTargetIsRemote,
  runAdapterExecutionTargetProcess,
  resolveAdapterExecutionTargetTimeoutSec,
  ensureAdapterExecutionTargetCommandResolvable,
  resolveAdapterExecutionTargetCommandForLogs,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  readPaperclipIssueWorkModeFromContext,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";

export const TYPE = "antigravity_local";
export const DEFAULT_MODEL = "auto";
const DEFAULT_COMMAND = "agy";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_SILENCE_TIMEOUT_SEC = 30;
const CLAUDE_CODE_NESTING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
];

const MODELS = [
  { id: "auto", label: "Auto (Antigravity default)" },
];

const AUTH_REQUIRED_RE =
  /(?:please\s+sign\s+in|sign\s+in\s+to|launch\s+the\s+cli\s+without\s+arguments\s+to\s+sign\s+in|authentication\s+required|not\s+authenticated|unauthorized|oauth|opening\s+browser|please\s+open\s+the\s+following\s+url)/i;

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Session codec (conversation resume via --conversation <id>)
// ---------------------------------------------------------------------------
export const sessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const conversationId =
      readNonEmptyString(raw.conversationId) ??
      readNonEmptyString(raw.conversation_id) ??
      readNonEmptyString(raw.sessionId);
    if (!conversationId) return null;
    const cwd = readNonEmptyString(raw.cwd);
    return { conversationId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params) {
    if (!params) return null;
    const conversationId =
      readNonEmptyString(params.conversationId) ??
      readNonEmptyString(params.conversation_id) ??
      readNonEmptyString(params.sessionId);
    if (!conversationId) return null;
    const cwd = readNonEmptyString(params.cwd);
    return { conversationId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params) {
    if (!params) return null;
    return (
      readNonEmptyString(params.conversationId) ??
      readNonEmptyString(params.conversation_id) ??
      readNonEmptyString(params.sessionId)
    );
  },
};

// ---------------------------------------------------------------------------
// Config schema (UI form)
// ---------------------------------------------------------------------------
export function getConfigSchema() {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_MODEL,
        hint: "Antigravity model id. 'auto' uses the default model.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute fallback working directory. Paperclip workspaces override this at runtime.",
      },
      {
        key: "skipPermissions",
        label: "Skip permissions",
        type: "select",
        options: [
          { value: "true", label: "Yes (--dangerously-skip-permissions)" },
          { value: "false", label: "No (prompt for permissions)" },
        ],
        default: "true",
        hint: "Auto-approve tool permission requests. Required for non-interactive heartbeats.",
      },
      {
        key: "sandbox",
        label: "Sandbox mode",
        type: "select",
        options: [
          { value: "false", label: "No" },
          { value: "true", label: "Yes" },
        ],
        default: "false",
        hint: "Run with terminal restrictions enabled.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Absolute path to a markdown instructions file prepended to the run prompt.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Run prompt template. Defaults to the standard Paperclip agent prompt.",
      },
      {
        key: "command",
        label: "Command",
        type: "text",
        default: DEFAULT_COMMAND,
        hint: "Defaults to 'agy'.",
      },
      {
        key: "extraArgs",
        label: "Extra CLI args",
        type: "textarea",
        hint: "Additional agy CLI args (JSON array of strings).",
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Optional JSON object of environment values.",
      },
      { key: "timeoutSec", label: "Timeout seconds", type: "number", default: DEFAULT_TIMEOUT_SEC },
      { key: "graceSec", label: "SIGTERM grace seconds", type: "number", default: 20 },
      {
        key: "silenceTimeoutSec",
        label: "Silence timeout seconds",
        type: "number",
        default: DEFAULT_SILENCE_TIMEOUT_SEC,
        hint: "Seconds of stdout silence after which agy is proactively terminated and output returned as success. Prevents hang when agy fails to exit after printing.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Runtime command spec
// ---------------------------------------------------------------------------
export function getRuntimeCommandSpec(config) {
  const command = asString(config?.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  return { command, detectCommand: command, installCommand: null };
}

// ---------------------------------------------------------------------------
// Environment test
// ---------------------------------------------------------------------------
export async function testEnvironment(ctx) {
  const config = parseObject(ctx?.config);
  const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx?.executionTarget,
    legacyRemoteExecution: ctx?.executionTransport?.remoteExecution,
  });
  const cwd = asString(config.cwd, process.cwd());
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env })).filter(([, v]) => typeof v === "string"),
  );

  const checks = [];
  let ok = true;

  // Check command resolvable
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: null,
      timeoutSec: 15,
    });
    checks.push({ label: `Command "${command}" resolvable`, ok: true });
  } catch (err) {
    ok = false;
    checks.push({
      label: `Command "${command}" resolvable`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Check auth: agy stores state in ~/.gemini/antigravity-cli/
  // No explicit token — relies on prior interactive OAuth login.
  const agyHome = path.join(process.env.HOME || "/root", ".gemini", "antigravity-cli");
  let hasConversationsDir = false;
  try {
    const stat = await fs.stat(agyHome);
    hasConversationsDir = stat.isDirectory();
  } catch {
    // directory doesn't exist
  }

  if (hasConversationsDir) {
    checks.push({
      label: "Antigravity CLI data directory found",
      ok: true,
      detail: `${agyHome} exists.`,
    });
  } else {
    checks.push({
      label: "Antigravity CLI data directory found",
      ok: false,
      detail: `${agyHome} not found. Run \`agy\` once interactively to initialize.`,
    });
  }

  // Auth check: try `agy models` — if it fails with "sign in", auth is missing
  // Skip this probe if the command isn't even resolvable.
  if (checks[0]?.ok) {
    try {
      const probe = await runAdapterExecutionTargetProcess("env-test", executionTarget, command, ["models"], {
        cwd,
        env: {},
        timeoutSec: 15,
        graceSec: 5,
      });
      const combined = `${probe.stdout || ""}\n${probe.stderr || ""}`;
      if (AUTH_REQUIRED_RE.test(combined)) {
        ok = false;
        checks.push({
          label: "Antigravity OAuth authenticated",
          ok: false,
          detail: "Not signed in. Run `agy` interactively to complete OAuth sign-in.",
        });
      } else if ((probe.exitCode ?? 0) === 0) {
        checks.push({ label: "Antigravity OAuth authenticated", ok: true });
      } else {
        checks.push({
          label: "Antigravity OAuth authenticated",
          ok: false,
          detail: combined.trim().split("\n")[0] || `Exit code ${probe.exitCode}`,
        });
        ok = false;
      }
    } catch (err) {
      checks.push({
        label: "Antigravity OAuth authenticated",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }
  }

  return {
    ok,
    checks,
    summary: ok ? "Antigravity CLI is ready." : "Antigravity CLI environment is not fully configured.",
  };
}

// ---------------------------------------------------------------------------
// Detect auth-required from process output
// ---------------------------------------------------------------------------
function detectAuthRequired(stdout, stderr) {
  const haystack = `${stdout || ""}\n${stderr || ""}`;
  return AUTH_REQUIRED_RE.test(haystack);
}

// ---------------------------------------------------------------------------
// Parse conversation ID from agy output
// agy may print the conversation id in its output. Scan for common patterns.
// ---------------------------------------------------------------------------
function parseConversationId(stdout, stderr) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  // agy logs conversation id patterns like "Conversation ID: abc123" or similar
  const match = combined.match(/(?:conversation\s+(?:id|ID)[:\s]+)([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Streaming process runner with silence-based kill
// ---------------------------------------------------------------------------
// agy --print can hang after printing its response (WaitForConversationFullyIdle
// never completes). This runner detects when stdout goes silent and proactively
// SIGTERMs agy, returning captured stdout as a successful result.
async function runAgyWithSilenceKill(command, args, opts) {
  const { cwd, env, timeoutSec, graceSec = 20, silenceTimeoutMs = 30000, onLog, onSpawn } = opts;

  const rawMerged = { ...process.env, ...env };
  for (const key of CLAUDE_CODE_NESTING_VARS) delete rawMerged[key];
  const mergedEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(rawMerged)).filter(([, v]) => typeof v === "string"),
  );

  return new Promise((resolve) => {
    const child = nodeSpawn(command, args, {
      cwd,
      env: mergedEnv,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const startedAt = new Date().toISOString();
    const processGroupId =
      process.platform !== "win32" && typeof child.pid === "number" ? child.pid : null;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let silenceKilled = false;
    let settled = false;
    let silenceTimer = null;
    let logChain = Promise.resolve();

    const killPg = (signal) => {
      try {
        if (processGroupId) process.kill(-processGroupId, signal);
        else child.kill(signal);
      } catch {}
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      if (processTimer) clearTimeout(processTimer);
      resolve(result);
    };

    const processTimer =
      timeoutSec > 0
        ? setTimeout(() => {
            if (settled) return;
            timedOut = true;
            if (silenceTimer) clearTimeout(silenceTimer);
            killPg("SIGTERM");
            setTimeout(() => killPg("SIGKILL"), Math.max(1, graceSec) * 1000);
          }, timeoutSec * 1000)
        : null;

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (stdout.trim().length === 0) return;
      silenceTimer = setTimeout(() => {
        if (settled) return;
        silenceKilled = true;
        killPg("SIGTERM");
        setTimeout(() => killPg("SIGKILL"), Math.max(1, graceSec) * 1000);
      }, silenceTimeoutMs);
    };

    if (onSpawn && typeof child.pid === "number" && child.pid > 0) {
      Promise.resolve(
        onSpawn({ pid: child.pid, processGroupId, startedAt }),
      ).catch(() => {});
    }

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      resetSilenceTimer();
      if (onLog) {
        logChain = logChain.then(() => onLog("stdout", text)).catch(() => {});
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (onLog) {
        logChain = logChain.then(() => onLog("stderr", text)).catch(() => {});
      }
    });

    child.on("error", (err) => {
      finish({
        exitCode: -1,
        signal: null,
        timedOut: false,
        silenceKilled: false,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        pid: child.pid ?? null,
        startedAt,
      });
    });

    child.on("close", (code, signal) => {
      void logChain.finally(() => {
        finish({
          exitCode: code,
          signal,
          timedOut,
          silenceKilled,
          stdout,
          stderr,
          pid: child.pid ?? null,
          startedAt,
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
export async function execute(ctx) {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx?.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    throw new Error("antigravity_local adapter supports local execution only.");
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  const model = asString(config.model, DEFAULT_MODEL).trim();
  const skipPermissions = asString(config.skipPermissions, "true") === "true";
  const useSandbox = asString(config.sandbox, "false") === "true";

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ---- Environment ----
  const envConfig = parseObject(config.env);
  const env = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason = typeof context.wakeReason === "string" && context.wakeReason.trim() ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const approvalId = typeof context.approvalId === "string" && context.approvalId.trim() ? context.approvalId.trim() : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim() ? context.approvalStatus.trim() : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v) => typeof v === "string" && v.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([, v]) => typeof v === "string"),
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(([, v]) => typeof v === "string"),
  );

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC)) || DEFAULT_TIMEOUT_SEC;
  const graceSec = asNumber(config.graceSec, 20);
  const silenceTimeoutSec = asNumber(config.silenceTimeoutSec, DEFAULT_SILENCE_TIMEOUT_SEC);
  const printTimeoutSec = Math.max(60, Math.floor(timeoutSec * 0.8));

  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: null,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtra = asStringArray(config.extraArgs);
    if (fromExtra.length > 0) return fromExtra;
    return asStringArray(config.args);
  })();

  // ---- Session resume ----
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeConversationId =
    asString(runtimeSessionParams.conversationId, "") ||
    asString(runtimeSessionParams.conversation_id, "") ||
    asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeConversationId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const conversationId = canResumeSession ? runtimeConversationId : null;
  if (runtimeConversationId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Antigravity conversation "${runtimeConversationId}" was for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // ---- Instructions file ----
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
    }
  }

  // ---- Prompt ----
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(conversationId) });
  const shouldUseResumeDeltaPrompt = Boolean(conversationId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // ---- Build args ----
  // agy --print "<prompt>" runs non-interactively, printing the response to stdout.
  const buildArgs = (resumeConversationId) => {
    const args = [];
    if (resumeConversationId) {
      args.push("--conversation", resumeConversationId);
    }
    if (model && model !== DEFAULT_MODEL) {
      args.push("--model", model);
    }
    if (skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (useSandbox) {
      args.push("--sandbox");
    }
    // Set the working directory via --add-dir
    args.push("--add-dir", cwd);
    // agy's --print-timeout must fire before the process timeout so agy
    // has a chance to self-exit before SIGTERM; silence detection fires first.
    args.push("--print-timeout", `${printTimeoutSec}s`);
    if (extraArgs.length > 0) {
      args.push(...extraArgs);
    }
    // Prompt must be last, via --print
    args.push("--print", prompt);
    return args;
  };

  const commandNotes = [
    "Prompt passed to agy via --print (non-interactive mode).",
    "Plain text output captured from stdout.",
    skipPermissions ? "Tool permissions auto-approved (--dangerously-skip-permissions)." : "Tool permissions prompted.",
    useSandbox ? "Running in sandbox mode." : "",
  ].filter(Boolean);
  if (instructionsFilePath && instructionsPrefix.length > 0) {
    commandNotes.push(`Prepended agent instructions from ${instructionsFilePath}.`);
  }

  const args = buildArgs(conversationId);
  if (onMeta) {
    await onMeta({
      adapterType: TYPE,
      command: resolvedCommand,
      cwd,
      commandNotes,
      commandArgs: args.map((v, i) => {
        // Mask the prompt value (last arg after --print)
        if (i > 0 && args[i - 1] === "--print") return `<prompt ${prompt.length} chars>`;
        return v;
      }),
      env: loggedEnv,
      prompt,
      promptMetrics,
      context,
    });
  }

  const proc = await runAgyWithSilenceKill(command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    silenceTimeoutMs: silenceTimeoutSec * 1000,
    onSpawn,
    onLog,
  });

  // ---- Build result ----
  const authRequired = detectAuthRequired(proc.stdout, proc.stderr);
  const hasOutput = (proc.stdout || "").trim().length > 0;

  const detectedConversationId = parseConversationId(proc.stdout, proc.stderr);
  const resolvedConversationId = detectedConversationId || conversationId || null;
  const resolvedSessionParams = resolvedConversationId
    ? { conversationId: resolvedConversationId, cwd }
    : null;

  const summary = (proc.stdout || "").trim() || null;
  const sessionFields = {
    sessionId: resolvedConversationId,
    sessionParams: resolvedSessionParams,
    sessionDisplayId: resolvedConversationId,
    provider: "google",
    biller: "google",
    model: model || DEFAULT_MODEL,
    billingType: "subscription",
  };

  // Silence kill with output → success (agy printed the response but hung on exit)
  if (proc.silenceKilled && hasOutput) {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      ...sessionFields,
      summary,
      resultJson: { stdout: proc.stdout, stderr: proc.stderr },
    };
  }

  // Process timeout
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: hasOutput
        ? `Timed out after ${timeoutSec}s (response captured)`
        : `Timed out after ${timeoutSec}s`,
      errorCode: authRequired ? "antigravity_auth_required" : null,
      ...sessionFields,
      ...(hasOutput ? { summary, resultJson: { stdout: proc.stdout, stderr: proc.stderr } } : {}),
    };
  }

  // Normal exit
  const failed = (proc.exitCode ?? 0) !== 0;
  const stderrLine = (proc.stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  const fallbackErrorMessage = stderrLine || `agy exited with code ${proc.exitCode ?? -1}`;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: failed ? fallbackErrorMessage : null,
    errorCode: failed && authRequired ? "antigravity_auth_required" : null,
    ...sessionFields,
    summary,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------
export function createServerAdapter() {
  return {
    type: TYPE,
    label: "Antigravity CLI (local)",
    execute,
    testEnvironment,
    sessionCodec,
    getConfigSchema,
    getRuntimeCommandSpec,
    models: MODELS,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    agentConfigurationDoc: AGENT_CONFIGURATION_DOC,
  };
}

export const AGENT_CONFIGURATION_DOC = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run the Antigravity CLI (agy) locally on the host machine.
- You want conversations resumed across heartbeats with --conversation <id>.

Don't use when:
- You need remote/sandbox execution (not supported by this adapter).
- agy is not installed on the machine that runs Paperclip.
- OAuth authentication has not been completed (agy requires browser-based sign-in).

Core fields:
- model (string, optional): Antigravity model id. Defaults to "auto".
- cwd (string, optional): default absolute working directory fallback.
- skipPermissions (boolean, optional): auto-approve tool permissions (--dangerously-skip-permissions). Defaults to true.
- sandbox (boolean, optional): run with terminal restrictions (--sandbox). Defaults to false.
- instructionsFilePath (string, optional): absolute markdown file prepended to the prompt.
- promptTemplate (string, optional): run prompt template.
- command (string, optional): defaults to "agy".
- extraArgs (string[], optional): additional CLI args.
- env (object, optional): KEY=VALUE environment overrides.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds. Defaults to 600 (10 min).
- graceSec (number, optional): SIGTERM grace period in seconds. Defaults to 20.
- silenceTimeoutSec (number, optional): seconds of stdout silence after which agy is terminated and output returned as success. Defaults to 30. Increase if tool-calling prompts have long silent pauses.

Notes:
- Prompt is passed via --print (non-interactive mode); plain text response captured from stdout.
- Silence detection: agy's --print mode can hang after printing its response (WaitForConversationFullyIdle bug). The adapter streams stdout and proactively terminates agy after silenceTimeoutSec of silence, returning captured output as a successful result.
- Sessions resume with --conversation <id> when the stored cwd matches.
- Authentication: requires prior interactive OAuth sign-in (run \`agy\` once without arguments).
  Until auth is in place, --print will fail with an auth-required error.
- The adapter sets --dangerously-skip-permissions by default for headless execution.
- Working directory is provided via --add-dir <cwd>.
`;
