// @paperclip-custom/adapter-junie-local
//
// External Paperclip adapter that runs the JetBrains Junie CLI locally.
// Modeled on @paperclipai/adapter-gemini-local (CLI + JSON stream output),
// stripped to local execution only. Reuses @paperclipai/adapter-utils for
// prompt rendering / env building / process spawning so its behavior matches
// the built-in adapters. Resolution of those bare imports relies on the
// node_modules symlink created next to this package (see install script).

import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
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

import { parseJunieJsonStream, detectJunieAuthRequired } from "./parse.js";

export const TYPE = "junie_local";
export const DEFAULT_JUNIE_LOCAL_MODEL = "auto";
const DEFAULT_COMMAND = "junie";

const MODELS = [
  { id: "auto", label: "Auto (Junie default)" },
  { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (BYOK Anthropic)" },
  { id: "openai/gpt-5", label: "GPT-5 (BYOK OpenAI)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (BYOK Google)" },
];

// JetBrains-token vs BYOK-key based billing classification.
const BYOK_KEY_ENV = [
  "JUNIE_ANTHROPIC_API_KEY",
  "JUNIE_OPENAI_API_KEY",
  "JUNIE_GOOGLE_API_KEY",
  "JUNIE_GROK_API_KEY",
  "JUNIE_OPENROUTER_API_KEY",
  "JUNIE_LITELLM_API_KEY",
];

function hasNonEmpty(env, key) {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveBillingType(env) {
  return BYOK_KEY_ENV.some((k) => hasNonEmpty(env, k)) ? "api" : "subscription";
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Junie is a JVM app whose HTTP client does NOT honor HTTP(S)_PROXY env vars —
// it needs JVM system properties (-Dhttps.proxyHost ...). When the host runs
// behind an egress proxy (proxy-only networks), derive those props from the
// proxy env and feed them through JAVA_TOOL_OPTIONS so the junie child routes
// auth/update/runtime traffic through the proxy. No-op when no proxy is set or
// JAVA_TOOL_OPTIONS already configures a proxy.
function deriveJvmProxyOptions(sourceEnv) {
  const existing = readNonEmptyString(sourceEnv.JAVA_TOOL_OPTIONS) ?? "";
  if (/-D(?:https?)\.proxyHost=/.test(existing)) return existing || null;
  const proxyUrl =
    readNonEmptyString(sourceEnv.HTTPS_PROXY) ??
    readNonEmptyString(sourceEnv.https_proxy) ??
    readNonEmptyString(sourceEnv.HTTP_PROXY) ??
    readNonEmptyString(sourceEnv.http_proxy);
  if (!proxyUrl) return existing || null;
  let host;
  let port;
  try {
    const u = new URL(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`);
    host = u.hostname;
    port = u.port || "3128";
  } catch {
    return existing || null;
  }
  if (!host) return existing || null;
  const noProxy =
    readNonEmptyString(sourceEnv.NO_PROXY) ?? readNonEmptyString(sourceEnv.no_proxy) ?? "";
  const nonProxyHosts = noProxy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("|");
  const opts = [
    `-Dhttps.proxyHost=${host}`,
    `-Dhttps.proxyPort=${port}`,
    `-Dhttp.proxyHost=${host}`,
    `-Dhttp.proxyPort=${port}`,
    ...(nonProxyHosts ? [`-Dhttp.nonProxyHosts=${nonProxyHosts}`] : []),
  ].join(" ");
  return existing ? `${existing} ${opts}` : opts;
}

// ---------------------------------------------------------------------------
// Session codec (mirrors gemini-local: sessionId + cwd + workspace identity)
// ---------------------------------------------------------------------------
export const sessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const r = raw;
    const sessionId =
      readNonEmptyString(r.sessionId) ??
      readNonEmptyString(r.session_id) ??
      readNonEmptyString(r.sessionID);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(r.cwd) ?? readNonEmptyString(r.workdir);
    const workspaceId = readNonEmptyString(r.workspaceId) ?? readNonEmptyString(r.workspace_id);
    const repoUrl = readNonEmptyString(r.repoUrl) ?? readNonEmptyString(r.repo_url);
    const repoRef = readNonEmptyString(r.repoRef) ?? readNonEmptyString(r.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd) ?? readNonEmptyString(params.workdir);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      readNonEmptyString(params.sessionID)
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
        key: "auth",
        label: "Junie auth token",
        type: "text",
        hint: "JetBrains Junie CLI token from https://junie.jetbrains.com/cli (passed as JUNIE_API_KEY). Prefer a secret binding via the env field.",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_JUNIE_LOCAL_MODEL,
        hint: "Junie model id. 'auto' uses the Junie default. BYOK ids use <provider>/<model>.",
      },
      {
        key: "effort",
        label: "Effort",
        type: "select",
        options: [
          { value: "", label: "Default" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        hint: "Reasoning effort level.",
      },
      {
        key: "provider",
        label: "BYOK provider",
        type: "text",
        hint: "Optional: openai | anthropic | google | xai | openrouter | copilot | litellm. Leave empty for the Junie provider.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute fallback working directory. Paperclip workspaces override this at runtime.",
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
        hint: "Defaults to 'junie'.",
      },
      {
        key: "extraArgs",
        label: "Extra CLI args",
        type: "textarea",
        hint: "Additional Junie CLI args (JSON array of strings).",
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Optional JSON object of environment values or secret bindings (e.g. JUNIE_API_KEY).",
      },
      { key: "timeoutSec", label: "Timeout seconds", type: "number", default: 0 },
      { key: "graceSec", label: "SIGTERM grace seconds", type: "number", default: 20 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Runtime command spec (junie is preinstalled; no self-install)
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
  const envConfig = parseObject(config.env);
  const token =
    readNonEmptyString(config.auth) ??
    readNonEmptyString(envConfig.JUNIE_API_KEY) ??
    readNonEmptyString(process.env.JUNIE_API_KEY);
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
  // Auth: either an explicit token (JUNIE_API_KEY / auth field) OR a persisted
  // interactive login. Junie stores CLI credentials at ~/.junie/secure_credentials.json
  // (HOME-relative; same HOME the adapter runs under). Don't hard-fail on a
  // missing token — a terminal login (`junie` interactive) is equally valid.
  const hasToken = Boolean(token);
  const junieHome = readNonEmptyString(process.env.JUNIE_HOME);
  const credentialPaths = [
    junieHome ? path.join(junieHome, "secure_credentials.json") : null,
    path.join(os.homedir(), ".junie", "secure_credentials.json"),
  ].filter(Boolean);
  const credentialFile = credentialPaths.find((p) => {
    try {
      return fssync.statSync(p).size > 0;
    } catch {
      return false;
    }
  });
  const hasAuth = hasToken || Boolean(credentialFile);
  if (!hasAuth) ok = false;
  checks.push({
    label: "Junie authentication available",
    ok: hasAuth,
    detail: hasToken
      ? "Using configured token (JUNIE_API_KEY / auth field)."
      : credentialFile
        ? `Using persisted login (${credentialFile}).`
        : "No token and no persisted login. Run `junie` once interactively to authenticate, or set the 'auth' field / JUNIE_API_KEY.",
  });
  return {
    ok,
    checks,
    summary: ok ? "Junie CLI is ready." : "Junie CLI environment is not fully configured.",
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
export async function execute(ctx) {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    throw new Error("junie_local adapter supports local execution only (remote execution target is not supported).");
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
  const model = asString(config.model, DEFAULT_JUNIE_LOCAL_MODEL).trim();
  const effort = asString(config.effort, "").trim();
  const provider = asString(config.provider, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ---- Environment ----
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;

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

  // Junie-specific env passthrough from the adapter config `env` JSON.
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  // Junie auth token: config.auth -> JUNIE_API_KEY (env wins if already set).
  const junieToken =
    readNonEmptyString(config.auth) ??
    readNonEmptyString(envConfig.JUNIE_API_KEY) ??
    readNonEmptyString(process.env.JUNIE_API_KEY);
  if (junieToken && !hasNonEmpty(env, "JUNIE_API_KEY")) {
    env.JUNIE_API_KEY = junieToken;
  }
  // Junie wants a writable, non-interactive home for caches/sessions.
  if (!hasNonEmpty(env, "JUNIE_SKIP_UPDATE_CHECK")) env.JUNIE_SKIP_UPDATE_CHECK = "true";

  // Route the junie JVM through the egress proxy if one is configured (its HTTP
  // client ignores HTTP(S)_PROXY env — needs JVM system properties).
  const jvmProxyOpts = deriveJvmProxyOptions({ ...process.env, ...env });
  if (jvmProxyOpts) env.JAVA_TOOL_OPTIONS = jvmProxyOpts;

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([, v]) => typeof v === "string"),
  );
  const billingType = resolveBillingType(effectiveEnv);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(effectiveEnv)).filter(([, v]) => typeof v === "string"),
  );

  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(executionTarget, asNumber(config.timeoutSec, 0));
  const graceSec = asNumber(config.graceSec, 20);

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
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Junie session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
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

  // Standalone custom-model profiles (entrypoint.d/56-junie-omniroute-models.sh
  // writes them under $JUNIE_HOME/models/*.json) are only auto-discovered when
  // JUNIE_HOME is set explicitly OR --model-location is passed — relying on the
  // bare ~/.junie fallback silently finds nothing. Always pass it: harmless
  // when the directory has no profiles, and makes `--model custom:omniroute-*`
  // available to every agent without per-agent config.
  const junieHomeForModels = readNonEmptyString(process.env.JUNIE_HOME) ?? path.join(os.homedir(), ".junie");
  const modelLocation = path.join(junieHomeForModels, "models");

  // ---- Build args ----
  const buildArgs = (resumeSessionId) => {
    const args = ["--output-format", "json-stream", "--input-format", "text", "--project", cwd];
    if (resumeSessionId) args.push("--session-id", resumeSessionId, "--resume");
    if (model && model !== DEFAULT_JUNIE_LOCAL_MODEL) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (provider) args.push("--provider", provider);
    args.push("--model-location", modelLocation);
    // Junie does not read env vars for auth — must pass as CLI flags.
    if (junieToken) {
      args.push("--auth", junieToken);
    } else {
      const anthropicKey = readNonEmptyString(env.JUNIE_ANTHROPIC_API_KEY);
      if (anthropicKey) args.push("--anthropic-api-key", anthropicKey);
      const openaiKey = readNonEmptyString(env.JUNIE_OPENAI_API_KEY);
      if (openaiKey) args.push("--openai-api-key", openaiKey);
      const googleKey = readNonEmptyString(env.JUNIE_GOOGLE_API_KEY);
      if (googleKey) args.push("--google-api-key", googleKey);
      const grokKey = readNonEmptyString(env.JUNIE_GROK_API_KEY);
      if (grokKey) args.push("--grok-api-key", grokKey);
      const openrouterKey = readNonEmptyString(env.JUNIE_OPENROUTER_API_KEY);
      if (openrouterKey) args.push("--openrouter-api-key", openrouterKey);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--task", prompt);
    return args;
  };

  const commandNotes = [
    "Prompt is passed to Junie via --task with --input-format text.",
    "Output parsed from --output-format json-stream.",
    junieToken ? "Auth via --auth CLI flag (JUNIE_API_KEY)." : "WARNING: no Junie auth token configured.",
  ];
  if (instructionsFilePath && instructionsPrefix.length > 0) {
    commandNotes.push(`Prepended agent instructions from ${instructionsFilePath}.`);
  }

  const runAttempt = async (resumeSessionId) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: TYPE,
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: args.map((v, i) => (i === args.length - 1 ? `<prompt ${prompt.length} chars>` : v)),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }
    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });
    return { proc, parsed: parseJunieJsonStream(proc.stdout) };
  };

  const toResult = (attempt) => {
    const authMeta = detectJunieAuthRequired({
      parsed: attempt.parsed.resultEvent,
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "junie_auth_required" : null,
      };
    }
    const failed = (attempt.proc.exitCode ?? 0) !== 0;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = (attempt.proc.stderr || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    const fallbackErrorMessage =
      parsedError || stderrLine || `Junie exited with code ${attempt.proc.exitCode ?? -1}`;

    const resolvedSessionId = attempt.parsed.sessionId ?? (runtimeSessionId || runtime.sessionId || null);
    const resolvedSessionParams = resolvedSessionId
      ? {
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        }
      : null;

    const resultJson = attempt.parsed.resultEvent ?? {
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    };

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode: failed && authMeta.requiresAuth ? "junie_auth_required" : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: provider || "jetbrains",
      biller: provider || "jetbrains",
      model: model || DEFAULT_JUNIE_LOCAL_MODEL,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson,
      summary: attempt.parsed.summary,
      question: attempt.parsed.question,
    };
  };

  const initial = await runAttempt(sessionId);
  return toResult(initial);
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------
export function createServerAdapter() {
  return {
    type: TYPE,
    label: "Junie CLI (local)",
    execute,
    testEnvironment,
    sessionCodec,
    getConfigSchema,
    getRuntimeCommandSpec,
    models: MODELS,
    supportsLocalAgentJwt: true,
    agentConfigurationDoc: AGENT_CONFIGURATION_DOC,
  };
}

export const AGENT_CONFIGURATION_DOC = `# junie_local agent configuration

Adapter: junie_local

Use when:
- You want Paperclip to run the JetBrains Junie CLI locally on the host machine.
- You want Junie sessions resumed across heartbeats with --resume / --session-id.

Don't use when:
- You need remote/sandbox execution (not supported by this adapter).
- Junie CLI is not installed on the machine that runs Paperclip.

Core fields:
- auth (string): JetBrains Junie CLI token (https://junie.jetbrains.com/cli). Exported as JUNIE_API_KEY. Prefer a secret binding via the env field.
- model (string, optional): Junie model id. Defaults to "auto".
- effort (string, optional): low | medium | high.
- provider (string, optional): BYOK provider (openai|anthropic|google|xai|openrouter|copilot|litellm).
- cwd (string, optional): default absolute working directory fallback.
- instructionsFilePath (string, optional): absolute markdown file prepended to the prompt.
- promptTemplate (string, optional): run prompt template.
- command (string, optional): defaults to "junie".
- extraArgs (string[], optional): additional CLI args.
- env (object, optional): KEY=VALUE environment (e.g. JUNIE_API_KEY or BYOK keys).

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout).
- graceSec (number, optional): SIGTERM grace period in seconds.

Notes:
- Prompt is passed via --task with --input-format text; output parsed from --output-format json-stream.
- Sessions resume with --resume + --session-id when the stored cwd matches.
- Authentication: a persisted interactive login (run \`junie\` once in the same HOME, stored at ~/.junie/secure_credentials.json), or JUNIE_API_KEY (JetBrains token), or BYOK keys (JUNIE_ANTHROPIC_API_KEY, etc.).
`;
