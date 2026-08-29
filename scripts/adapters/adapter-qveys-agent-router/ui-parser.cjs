"use strict";

/**
 * High-performance UI parser for qveys_agent_router (Paperclip adapter).
 * Parses stdout lines from Claude Code stream-json, Codex JSONL, Hermes,
 * and router metadata into Paperclip transcript entries.
 */

// Global line memoization cache (max 20,000 entries)
const LINE_CACHE = new Map();
const MAX_CACHE_SIZE = 20000;

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringifyUnknown(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorText(error) {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    if (typeof error.message === "string") return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "";
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    if (str.includes("***REDACTED***")) {
      try {
        const repaired = str.replace(/\*\*\*REDACTED\*\*\*"([A-Za-z0-9_])/g, '***REDACTED***", "$1');
        return JSON.parse(repaired);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── 1. Claude Stream-JSON Parsing ───────────────────────────────────────────

function parseClaudeContentBlock(block, ts) {
  if (!block || typeof block !== "object") return [];
  const type = asString(block.type);

  if (type === "text") {
    const text = asString(block.text);
    if (text) return [{ kind: "assistant", ts, text }];
    return [];
  }

  if (type === "thinking") {
    const thinking = asString(block.thinking);
    if (thinking && thinking.trim().length > 0) {
      return [{ kind: "thinking", ts, text: thinking }];
    }
    return [];
  }

  if (type === "tool_use") {
    const toolName = asString(block.name, "tool_use");
    const toolId = asString(block.id, toolName);
    const input = asRecord(block.input) ?? {};
    return [
      {
        kind: "tool_call",
        ts,
        name: toolName,
        toolUseId: toolId,
        input,
      },
    ];
  }

  if (type === "tool_result") {
    const toolId = asString(block.tool_use_id, "tool_result");
    const isError = block.is_error === true;
    let content = "";
    if (typeof block.content === "string") {
      content = block.content;
    } else if (Array.isArray(block.content)) {
      content = block.content
        .map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
        .join("\n");
    } else if (block.content !== undefined) {
      content = stringifyUnknown(block.content);
    }
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: toolId,
        content: content || (isError ? "tool failed" : "completed"),
        isError,
      },
    ];
  }

  return [];
}

function parseClaudeLine(parsed, line, ts) {
  const type = asString(parsed.type);
  if (!type) return null;

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (
      subtype === "thinking_tokens" ||
      subtype === "ping" ||
      subtype === "rate_limit" ||
      subtype === "signature"
    ) {
      return [];
    }
    if (subtype === "init") {
      return [
        {
          kind: "init",
          ts,
          model: asString(parsed.model, "unknown"),
          sessionId: asString(parsed.session_id),
        },
      ];
    }
    return [];
  }

  if (type === "assistant") {
    const msg = asRecord(parsed.message);
    if (!msg) return [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    const results = [];
    for (const b of content) {
      results.push(...parseClaudeContentBlock(b, ts));
    }
    return results;
  }

  if (type === "user") {
    const msg = asRecord(parsed.message);
    if (!msg) return [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    const results = [];
    for (const b of content) {
      results.push(...parseClaudeContentBlock(b, ts));
    }
    return results;
  }

  if (type === "result") {
    const isError = parsed.is_error === true;
    const usage = asRecord(parsed.usage);
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.map(errorText).filter(Boolean)
      : [];
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.result),
        inputTokens: asNumber(usage?.input_tokens),
        outputTokens: asNumber(usage?.output_tokens),
        cachedTokens: asNumber(
          usage?.cached_input_tokens,
          asNumber(usage?.cache_read_input_tokens)
        ),
        costUsd: asNumber(parsed.total_cost_usd),
        subtype: asString(parsed.subtype, "result"),
        isError,
        errors,
      },
    ];
  }

  return null;
}

// ─── 2. Codex JSONL Parsing ──────────────────────────────────────────────────

function parseCodexCommandExecution(item, ts, phase) {
  const id = asString(item.id || item.call_id, "command_execution");
  const command = asString(item.command || item.cmd, "command");

  if (phase === "started") {
    return [
      {
        kind: "tool_call",
        ts,
        name: "Bash",
        toolUseId: id,
        input: { command },
      },
    ];
  }

  const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
  const isError = exitCode !== 0 || item.status === "failed";
  const output = asString(
    item.aggregated_output ?? item.output ?? item.stdout ?? item.stderr ?? ""
  );

  return [
    {
      kind: "tool_call",
      ts,
      name: "Bash",
      toolUseId: id,
      input: { command },
    },
    {
      kind: "tool_result",
      ts,
      toolUseId: id,
      content: output || (isError ? `exited with code ${exitCode}` : "completed"),
      isError,
    },
  ];
}

function parseCodexToolUse(item, ts, phase) {
  const toolName = asString(item.name || item.tool, "tool");
  const server = asString(item.server);
  const fullName = server ? `${server}__${toolName}` : toolName;
  const id = asString(item.id || item.call_id, fullName || "tool_use");
  const input = item.arguments ?? item.input ?? item.args ?? {};

  if (phase === "started") {
    return [
      {
        kind: "tool_call",
        ts,
        name: fullName,
        toolUseId: id,
        input,
      },
    ];
  }

  const status = asString(item.status);
  const isError =
    item.is_error === true ||
    status === "failed" ||
    status === "errored" ||
    status === "error" ||
    status === "cancelled";
  const rawContent =
    item.content ?? item.output ?? item.result ?? item.error ?? item.message;
  const content =
    asString(rawContent) ||
    errorText(rawContent) ||
    stringifyUnknown(rawContent) ||
    `${fullName} ${isError ? "failed" : "completed"}`;

  return [
    {
      kind: "tool_call",
      ts,
      name: fullName,
      toolUseId: id,
      input,
    },
    {
      kind: "tool_result",
      ts,
      toolUseId: id,
      content,
      isError,
    },
  ];
}

function parseCodexItem(item, ts, phase) {
  const itemType = asString(item.type);
  if (itemType === "agent_message") {
    const text = asString(item.text);
    if (text) return [{ kind: "assistant", ts, text }];
    return [];
  }
  if (itemType === "reasoning") {
    const text = asString(item.text);
    if (text && text.trim().length > 0) return [{ kind: "thinking", ts, text }];
    return [];
  }
  if (itemType === "command_execution") {
    return parseCodexCommandExecution(item, ts, phase);
  }
  if (
    itemType === "tool_use" ||
    itemType === "mcp_tool_call" ||
    itemType === "function_call"
  ) {
    return parseCodexToolUse(item, ts, phase);
  }
  if (itemType === "file_change" || itemType === "file_changes") {
    return [{ kind: "system", ts, text: "file changes applied" }];
  }
  return [];
}

function parseCodexLine(parsed, line, ts) {
  const type = asString(parsed.type);
  if (!type) return null;

  const isCodex =
    type.includes(".") ||
    type === "error" ||
    type === "thread.started" ||
    type === "turn.started" ||
    type === "item.started" ||
    type === "item.completed";

  if (!isCodex && type !== "error") return null;

  if (type === "thread.started" || type === "session.created") {
    return [
      {
        kind: "init",
        ts,
        model: asString(parsed.model, "unknown"),
        sessionId: asString(parsed.thread_id || parsed.session_id || parsed.id),
      },
    ];
  }
  if (type === "turn.started") {
    return [];
  }
  if (type === "item.started" || type === "item.completed") {
    const item = asRecord(parsed.item);
    if (!item) return [];
    return parseCodexItem(item, ts, type === "item.started" ? "started" : "completed");
  }
  if (type === "turn.completed") {
    const usage = asRecord(parsed.usage);
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.result),
        inputTokens: asNumber(usage?.input_tokens),
        outputTokens: asNumber(usage?.output_tokens),
        cachedTokens: asNumber(
          usage?.cached_input_tokens,
          asNumber(usage?.cache_read_input_tokens)
        ),
        costUsd: asNumber(parsed.total_cost_usd),
        subtype: asString(parsed.subtype, "turn.completed"),
        isError: parsed.is_error === true,
        errors: Array.isArray(parsed.errors)
          ? parsed.errors.map(errorText).filter(Boolean)
          : [],
      },
    ];
  }
  if (type === "turn.failed") {
    const usage = asRecord(parsed.usage);
    const message = errorText(parsed.error ?? parsed.message);
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.result),
        inputTokens: asNumber(usage?.input_tokens),
        outputTokens: asNumber(usage?.output_tokens),
        cachedTokens: asNumber(
          usage?.cached_input_tokens,
          asNumber(usage?.cache_read_input_tokens)
        ),
        costUsd: asNumber(parsed.total_cost_usd),
        subtype: asString(parsed.subtype, "turn.failed"),
        isError: true,
        errors: message ? [message] : [],
      },
    ];
  }
  if (type === "error") {
    const message = errorText(parsed.error ?? parsed.message ?? parsed);
    return [{ kind: "stderr", ts, text: message || line }];
  }
  return null;
}

// ─── 3. Main parseStdoutLine entrypoint with Memoization ──────────────────────

function parseStdoutLineInner(text, ts) {
  if (!text) return [];

  // Fast path for router metadata
  if (text.startsWith("[qveys-router]")) {
    return [{ kind: "system", ts, text: text.replace(/\n$/, "") }];
  }

  // Fast path for internal noise lines
  if (text.includes('"subtype":"thinking_tokens"') || text.includes('"subtype":"ping"')) {
    return [];
  }

  if (text.startsWith("[hermes-gateway:event]")) {
    const payload = text.slice("[hermes-gateway:event]".length).trim();
    const parsedH = safeJsonParse(payload);
    if (parsedH) {
      const hType = asString(parsedH.type);
      if (hType === "assistant" && parsedH.text) {
        return [{ kind: "assistant", ts, text: parsedH.text }];
      }
    }
    return [{ kind: "system", ts, text: text.replace(/\n$/, "") }];
  }

  const parsed = asRecord(safeJsonParse(text));
  if (!parsed) {
    return [{ kind: "stdout", ts, text }];
  }

  const claude = parseClaudeLine(parsed, text, ts);
  if (claude !== null) return claude;

  const codex = parseCodexLine(parsed, text, ts);
  if (codex !== null) return codex;

  return [{ kind: "stdout", ts, text }];
}

function parseStdoutLine(line, ts) {
  const text = String(line ?? "");
  if (!text) return [];

  const key = `${ts}\0${text}`;
  const cached = LINE_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const result = parseStdoutLineInner(text, ts);
  if (LINE_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = LINE_CACHE.keys().next().value;
    LINE_CACHE.delete(firstKey);
  }
  LINE_CACHE.set(key, result);
  return result;
}

module.exports = { parseStdoutLine };
exports.parseStdoutLine = parseStdoutLine;
