#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let codexRuntimeConfigHelper = null;
try {
  codexRuntimeConfigHelper = await import("/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/adapter-codex-local/dist/server/runtime-config.js");
} catch {
  codexRuntimeConfigHelper = null;
}

const CATEGORIES = new Set(["coding", "creative", "analysis", "vision", "summarization", "background", "chat"]);
const CONFIG_PATH = process.env.QVEYS_AGENT_ROUTER_CONFIG || new URL("./config.yaml", import.meta.url).pathname;
const STICKY_PATH = process.env.QVEYS_AGENT_ROUTER_STICKY || "/paperclip/qveys-agent-router/sticky.json";
const LOG_PATH = process.env.QVEYS_AGENT_ROUTER_LOG || "/paperclip/qveys-agent-router/runs.jsonl";
const STREAM_KEEPALIVE_MS = Number(process.env.QVEYS_AGENT_ROUTER_STREAM_KEEPALIVE_MS || 25000);

export function parseScalar(raw) {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    try { return JSON.parse(v); } catch {}
    return v.slice(1, -1).split(",").map((s) => parseScalar(s)).filter((s) => s !== "");
  }
  return v.replace(/^["']|["']$/g, "");
}

export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    const m = line.trim().match(/^([^:]+):(.*)$/);
    if (!m) continue;
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    const key = m[1].trim();
    const rest = m[2].trim();
    parent[key] = rest ? parseScalar(rest) : {};
    if (!rest) stack.push({ indent, value: parent[key] });
  }
  return root;
}

export function classify(input) {
  if (input.hasTask === false) return { category: "background", confidence: 0.9, reason: "paperclip:heartbeat" };
  const text = `${input.title || ""}\n${input.prompt || ""}\n${input.taskBody || ""}`.toLowerCase();
  const rules = [
    ["vision", /\b(image|screenshot|capture|vision|photo|ocr|diagram|ui)\b/],
    ["coding", /\b(code|repo|bug|fix|test|build|typescript|javascript|python|api|pr|commit|deploy|docker|cli)\b/],
    ["summarization", /\b(summarize|summary|résume|resume|synthèse|tl;dr|recap)\b/],
    ["analysis", /\b(analyse|analyze|audit|compare|diagnose|root cause|investigate|reasoning|explain)\b/],
    ["creative", /\b(write|draft|copy|story|creative|name|brand|marketing|email|article)\b/],
    ["background", /\b(background|cron|scheduled|heartbeat|monitor|watch|veille|periodic)\b/],
  ];
  for (const [category, re] of rules) if (re.test(text)) return { category, confidence: 0.9, reason: `rule:${category}` };
  return { category: "chat", confidence: 0.6, reason: "default:chat" };
}

export function complexity(input) {
  const text = `${input.prompt || ""}\n${input.taskBody || ""}`;
  if (text.length > 4000 || /\b(architecture|migration|security|incident|multi-step|refactor)\b/i.test(text)) return "high";
  if (text.length > 1000 || /\b(debug|implement|review|analyse|compare)\b/i.test(text)) return "medium";
  return "low";
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function renderArgs(args, vars) {
  return (args || []).map((arg) => String(arg).replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] ?? ""));
}

function joinUrl(base, path) {
  if (!base) return "";
  return `${String(base).replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function taskKey(input) {
  return input.taskId || input.issueId || input.context?.taskId || input.context?.issueId || input.sessionId || input.context?.sessionId || input.runId || null;
}

export function decide(input, config, now = Date.now()) {
  const cls = classify(input);
  if (!CATEGORIES.has(cls.category)) throw new Error(`invalid category: ${cls.category}`);
  const cx = complexity(input);
  const effort = cx === "high" ? "high" : "low";
  const sticky = loadJson(STICKY_PATH, {});
  const key = taskKey(input);
  const ttl = Number(config.server?.stickyTtlMs || 21600000);
  const stuck = key && sticky[key] && sticky[key].expiresAt > now ? sticky[key] : null;
  const categoryPolicy = config.routing?.categories?.[cls.category] || config.routing?.default || {};
  let runtime = stuck?.runtime || categoryPolicy.runtime || config.routing?.default?.runtime || "hermes";
  let profile = stuck?.profile || categoryPolicy.profile || config.routing?.default?.profile || "fast";
  if (cx === "high" && ["cheap", "free", "fast"].includes(profile)) profile = cls.category === "coding" ? "coding" : "reasoning";
  const profiles = config.omniroute?.profiles || {};
  const fallback = [runtime, ...(categoryPolicy.fallback || config.routing?.default?.fallback || [])].filter((v, i, a) => v && a.indexOf(v) === i);
  const decision = {
    category: cls.category,
    confidence: cls.confidence,
    complexity: cx,
    runtime,
    profile,
    effort,
    omniModel: profiles[profile] || profile,
    fallback,
    sticky: Boolean(stuck),
    reason: stuck ? `sticky:${key}` : `${cls.reason};complexity:${cx}`,
  };
  if (key && !stuck) {
    sticky[key] = { runtime, profile, sessionId: input.sessionId || null, createdAt: now, expiresAt: now + ttl };
    saveJson(STICKY_PATH, sticky);
  }
  return decision;
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-lc", `command -v "$1" >/dev/null 2>&1`, "sh", command]);
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

async function runRuntime(input, config, decision, emit = () => {}) {
  const prompt = input.prompt || input.taskBody || JSON.stringify(input.context || input);
  const started = Date.now();
  let lastError = null;
  for (const name of decision.fallback) {
    const rt = config.runtimes?.[name];
    if (!rt || !(await commandExists(rt.command))) {
      lastError = `${name}: unavailable`;
      emit({ type: "log", stream: "stdout", chunk: `[qveys-router] skip runtime=${name} reason=unavailable\n` });
      continue;
    }
    emit({ type: "log", stream: "stdout", chunk: `[qveys-router] start runtime=${name} profile=${decision.profile} model=${decision.omniModel}\n` });
    const args = renderArgs(rt.args, { prompt, omni_model: decision.omniModel, profile: decision.profile, effort: decision.effort || "low" });
    const omniBaseUrl = config.omniroute?.baseUrl || "";
    const env = {
      ...process.env,
      OMNIROUTE_BASE_URL: omniBaseUrl,
      OMNIROUTE_CHAT_COMPLETIONS_URL: joinUrl(omniBaseUrl, config.omniroute?.endpoints?.chatCompletions || "/chat/completions"),
      OMNIROUTE_RESPONSES_URL: joinUrl(omniBaseUrl, config.omniroute?.endpoints?.responses || "/responses"),
      OMNIROUTE_MODEL: decision.omniModel,
      OMNIROUTE_PROFILE: decision.profile,
      PAPERCLIP_API_KEY: input.paperclipAuthToken || process.env.PAPERCLIP_API_KEY || "",
      PAPERCLIP_COMPANY_ID: input.agent?.companyId || process.env.PAPERCLIP_COMPANY_ID || "",
    };
    let codexCleanup = null;
    if (name === "codex" && codexRuntimeConfigHelper) {
      try {
        const codexHome = env.CODEX_HOME || (process.env.HOME || "/paperclip") + "/.codex";
        const prepared = await codexRuntimeConfigHelper.prepareCodexRuntimeConfig({ env, codexHome });
        codexCleanup = prepared.cleanup;
        for (const note of prepared.notes || []) {
          emit({ type: "log", stream: "stderr", chunk: `[qveys-router] codex-config: ${note}\n` });
        }
      } catch (e) {
        emit({ type: "log", stream: "stderr", chunk: `[qveys-router] codex-config prepare failed: ${e instanceof Error ? e.message : String(e)}\n` });
      }
    }
    const result = await new Promise((resolve) => {
      const child = spawn(rt.command, args, { env, cwd: input.cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), Number(rt.timeoutMs || 900000));
      child.stdout.on("data", (d) => {
        const text = String(d);
        stdout += text;
        emit({ type: "log", stream: "stdout", chunk: text });
        try { process.stdout.write(text); } catch {}
      });
      child.stderr.on("data", (d) => {
        const text = String(d);
        stderr += text;
        emit({ type: "log", stream: "stderr", chunk: text });
        try { process.stderr.write(text); } catch {}
      });
      child.on("error", (e) => resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${e.message}` }));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, signal, stdout, stderr });
      });
      if (rt.stdin !== false) child.stdin.end(prompt);
      else child.stdin.end();
    });
    if (codexCleanup) { try { await codexCleanup(); } catch {} codexCleanup = null; }
    const ok = result.exitCode === 0;
    const nonTerminal = ok && isNonTerminalPreamble(result.stdout, result.stderr);
    logRun({ ...decision, runtime: name, durationMs: Date.now() - started, success: ok && !nonTerminal, error: ok && !nonTerminal ? null : (nonTerminal ? "non-terminal preamble without useful action" : result.stderr.trim().slice(0, 500)), cost: null });
    if (ok && !nonTerminal) return { ...result, runtime: name, durationMs: Date.now() - started };
    if (nonTerminal) emit({ type: "log", stream: "stderr", chunk: `[qveys-router] rejected runtime=${name} reason=non-terminal-preamble; trying fallback\n` });
    emit({ type: "log", stream: "stderr", chunk: `[qveys-router] failed runtime=${name} exit=${result.exitCode}; trying fallback\n` });
    lastError = nonTerminal ? `${name}: non-terminal preamble without useful action` : `${name}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`.trim();
  }
  throw new Error(lastError || "no runtime available");
}

export function isNonTerminalPreamble(stdout, stderr = "") {
  const s = String(stdout || "").trim();
  if (/(?:bwrap: No permissions to create new namespace|user cancelled MCP tool call)/i.test(stderr) || /^(?:impossible de traiter|unable to (?:check|process|complete)|cannot (?:process|complete)|could not (?:process|complete))[\s\S]*(?:bwrap|sandbox|mcp|not exposed|pas exposés)/i.test(s)) return true;
  if (s.length === 0 || s.length > 500) return false;
  return /^(i need to|i'll need to|let me (read|check|inspect|look)|i should (read|check|inspect|look)|first,? i need)/i.test(s);
}

function logRun(entry) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  writeFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

export function makeServer(config) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") return json(res, { ok: true });
      if (req.method === "POST" && req.url === "/route/preview") return json(res, decide(await readBody(req), config));
      if (req.method === "POST" && req.url === "/route/stream") {
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
        let closed = false;
        const send = (event) => {
          if (closed || res.destroyed) return;
          res.write(`${JSON.stringify(event)}\n`);
        };
        const keepalive = setInterval(() => send({ type: "keepalive", ts: new Date().toISOString() }), STREAM_KEEPALIVE_MS);
        keepalive.unref?.();
        res.on("close", () => {
          closed = true;
          clearInterval(keepalive);
        });
        try {
          const input = await readBody(req);
          const decision = decide(input, config);
          send({ type: "decision", decision });
          const result = await runRuntime(input, config, decision, send);
          send({
            type: "result",
            result: {
              exitCode: result.exitCode,
              timedOut: false,
              errorMessage: null,
              sessionId: input.sessionId || taskKey(input) || null,
              sessionParams: { runtime: result.runtime, stickyKey: taskKey(input) },
              provider: "omniroute",
              model: decision.omniModel,
              summary: result.stdout.trim() || result.stderr.trim() || null,
              resultJson: { decision, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs },
            },
          });
        } catch (e) {
          send({ type: "error", errorMessage: e instanceof Error ? e.message : String(e) });
        } finally {
          closed = true;
          clearInterval(keepalive);
        }
        if (!res.writableEnded) res.end();
        return;
      }
      if (req.method === "POST" && req.url === "/route") {
        const input = await readBody(req);
        const decision = decide(input, config);
        const result = await runRuntime(input, config, decision);
        return json(res, {
          exitCode: result.exitCode,
          timedOut: false,
          errorMessage: null,
          sessionId: input.sessionId || taskKey(input) || null,
          sessionParams: { runtime: result.runtime, stickyKey: taskKey(input) },
          provider: "omniroute",
          model: decision.omniModel,
          summary: result.stdout.trim() || result.stderr.trim() || null,
          resultJson: { decision, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs },
        });
      }
      json(res, { error: "not found" }, 404);
    } catch (e) {
      json(res, { exitCode: 1, errorMessage: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = parseYaml(readFileSync(CONFIG_PATH, "utf8"));
  const host = config.server?.host || "127.0.0.1";
  const port = Number(config.server?.port || 3188);
  makeServer(config).listen(port, host, () => console.log(`qveys-agent-router listening on http://${host}:${port}`));
}
