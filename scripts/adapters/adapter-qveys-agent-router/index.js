import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TYPE = "qveys_agent_router";
const DEFAULT_ROUTER_URL = "http://127.0.0.1:3188";
const PAPERCLIP_HOME = process.env.PAPERCLIP_HOME || "/paperclip";

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function loadAgentInstructions(agent) {
  if (!agent?.id || !agent?.companyId) return "";
  try {
    return readFileSync(
      join(PAPERCLIP_HOME, "instances", "default", "companies", agent.companyId, "agents", agent.id, "instructions", "AGENTS.md"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

function buildPrompt(ctx) {
  const c = ctx?.context || {};
  const taskId = text(c.taskId || c.issueId);
  const commentId = text(c.commentId || c.wakeCommentId);
  const agent = ctx?.agent || {};
  const instructions = loadAgentInstructions(agent);

  const lines = [
    `You are ${text(agent.name) || "Paperclip agent"} (ID: ${text(agent.id) || "agent"}, Company: ${text(agent.companyId) || "default"}).`,
  ];

  if (instructions) {
    lines.push("", instructions);
  }

  if (taskId) {
    lines.push(
      "",
      `Assigned Issue: ${taskId}`,
      text(c.taskTitle),
      text(c.taskBody)
    );
  } else if (commentId) {
    lines.push(
      "",
      `New comment on issue ${text(c.taskId || c.issueId)}:`,
      "Review the comment and take appropriate action or reply."
    );
  } else {
    lines.push(
      "",
      "Heartbeat check: Check for open assigned work. If none assigned, summarize status briefly and finish."
    );
  }

  if (c.paperclipWake?.prompt) lines.push("", text(c.paperclipWake.prompt));
  if (c.paperclipSessionHandoffMarkdown) lines.push("", text(c.paperclipSessionHandoffMarkdown));

  return lines.filter(Boolean).join("\n");
}

export async function execute(ctx) {
  const routerUrl = text(ctx?.config?.routerUrl) || DEFAULT_ROUTER_URL;
  const showDecisionLog = ctx?.config?.showDecisionLog !== false && ctx?.config?.showDecisionLog !== "false";
  const streamLogs = ctx?.config?.streamLogs !== false && ctx?.config?.streamLogs !== "false";
  const body = {
    runId: ctx?.runId,
    taskId: ctx?.context?.taskId || ctx?.context?.issueId,
    commentId: ctx?.context?.commentId || ctx?.context?.wakeCommentId,
    hasTask: Boolean(ctx?.context?.taskId || ctx?.context?.issueId),
    paperclipAuthToken: text(ctx?.authToken),
    sessionId: ctx?.runtime?.sessionId,
    agent: ctx?.agent,
    cwd: ctx?.context?.paperclipWorkspace?.cwd || ctx?.config?.cwd,
    prompt: buildPrompt(ctx),
    context: ctx?.context || {},
  };
  if (streamLogs && typeof ctx?.onLog === "function") {
    return executeStreaming(ctx, routerUrl, body, showDecisionLog);
  }
  const res = await fetch(`${routerUrl.replace(/\/$/, "")}/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.errorMessage || json.error || `router HTTP ${res.status}`);
  const d = json?.resultJson?.decision;
  if (showDecisionLog && d && typeof ctx?.onLog === "function") {
    await ctx.onLog(
      "stdout",
      `[qveys-router] category=${d.category} complexity=${d.complexity} runtime=${d.runtime} profile=${d.profile} effort=${d.effort || "low"} model=${d.omniModel} sticky=${d.sticky} reason=${d.reason}\n`,
    );
  }
  if (typeof ctx?.onLog === "function") {
    const full = text(json?.resultJson?.stdout) || text(json?.summary);
    if (full) await ctx.onLog("stdout", full.endsWith("\n") ? full : `${full}\n`);
    const err = text(json?.resultJson?.stderr);
    if (err) await ctx.onLog("stderr", err.endsWith("\n") ? err : `${err}\n`);
  }
  return json;
}

async function executeStreaming(ctx, routerUrl, body, showDecisionLog) {
  const res = await fetch(`${routerUrl.replace(/\/$/, "")}/route/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.errorMessage || json.error || `router HTTP ${res.status}`);
  }

  let buffer = "";
  let result = null;
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "decision" && showDecisionLog) {
        const d = event.decision;
        await ctx.onLog(
          "stdout",
          `[qveys-router] category=${d.category} complexity=${d.complexity} runtime=${d.runtime} profile=${d.profile} effort=${d.effort || "low"} model=${d.omniModel} sticky=${d.sticky} reason=${d.reason}\n`,
        );
      } else if (event.type === "log") {
        await ctx.onLog(event.stream === "stderr" ? "stderr" : "stdout", event.chunk || "");
      } else if (event.type === "result") {
        result = event.result;
      } else if (event.type === "error") {
        throw new Error(event.errorMessage || "router stream error");
      }
    }
  }
  if (!result) throw new Error("router stream ended without result");
  return result;
}

export async function testEnvironment(ctx) {
  const routerUrl = text(ctx?.config?.routerUrl) || DEFAULT_ROUTER_URL;
  try {
    const res = await fetch(`${routerUrl.replace(/\/$/, "")}/healthz`);
    return { ok: res.ok, checks: [{ label: "qveys-agent-router /healthz", ok: res.ok }] };
  } catch (e) {
    return { ok: false, checks: [{ label: "qveys-agent-router /healthz", ok: false, detail: e.message }] };
  }
}

export function getConfigSchema() {
  return {
    fields: [
      { key: "routerUrl", label: "Router URL", type: "text", default: DEFAULT_ROUTER_URL },
      { key: "showDecisionLog", label: "Show routing decision in run log", type: "select", default: "true", options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ] },
      { key: "streamLogs", label: "Stream runtime transcript", type: "select", default: "true", options: [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ] },
      { key: "cwd", label: "Working directory", type: "text" },
    ],
  };
}

export function createServerAdapter() {
  return {
    type: TYPE,
    label: "Qveys Agent Router",
    execute,
    testEnvironment,
    getConfigSchema,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
  };
}
