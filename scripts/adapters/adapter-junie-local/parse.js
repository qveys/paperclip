// Tolerant parser for Junie's `--output-format json-stream` output.
//
// Junie has not published a stable JSON event schema, so this parser is
// deliberately permissive: it scans every JSON line, harvests assistant text
// from any plausible shape, and accumulates session id / usage / cost / error
// across many key spellings. Unrecognized event types are ignored (not fatal).
// Once a real sample is captured this can be tightened.

import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function readSessionId(event) {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event["session-id"], "").trim() ||
    asString(event.sessionID, "").trim() ||
    asString(event.thread_id, "").trim() ||
    asString(event.threadId, "").trim() ||
    null
  );
}

function asErrorText(value) {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

// Extract human-readable text from many possible message shapes.
function collectText(node) {
  if (node == null) return [];
  if (typeof node === "string") {
    const t = node.trim();
    return t ? [t] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectText);
  }
  const rec = parseObject(node);
  const out = [];
  // Direct text-bearing fields.
  for (const key of ["text", "content", "message", "value", "delta"]) {
    const v = rec[key];
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out.push(t);
    } else if (Array.isArray(v)) {
      // content blocks: [{type:"text", text:"..."}]
      for (const partRaw of v) {
        const part = parseObject(partRaw);
        const type = asString(part.type, "").trim();
        if (!type || type === "text" || type === "output_text" || type === "content") {
          const t = asString(part.text, "").trim() || asString(part.content, "").trim();
          if (t) out.push(t);
        }
      }
    }
  }
  return out;
}

function accumulateUsage(target, usageRaw) {
  const usage = parseObject(usageRaw);
  const meta = parseObject(usage.usageMetadata);
  const src = Object.keys(meta).length > 0 ? meta : usage;
  target.inputTokens += asNumber(
    src.input_tokens,
    asNumber(src.inputTokens, asNumber(src.promptTokens, asNumber(src.promptTokenCount, 0))),
  );
  target.cachedInputTokens += asNumber(
    src.cached_input_tokens,
    asNumber(src.cachedInputTokens, asNumber(src.cacheInputTokens, asNumber(src.cached, 0))),
  );
  target.outputTokens += asNumber(
    src.output_tokens,
    asNumber(src.outputTokens, asNumber(src.completionTokens, asNumber(src.candidatesTokenCount, 0))),
  );
}

// Junie's `result` event reports usage/cost as a per-model breakdown array.
// In observed samples that array lives under the (misleadingly named) key
// `errorCode`; accept the saner spellings too. Each entry looks like:
//   {model, calls, cost, inputTokens, cacheInputTokens, cacheCreateTokens, outputTokens}
// Returns the summed cost (or null if no usable entries) and folds token
// counts into `target`.
function accumulateModelBreakdown(target, arrayRaw) {
  if (!Array.isArray(arrayRaw)) return null;
  let cost = 0;
  let sawCost = false;
  for (const entryRaw of arrayRaw) {
    const entry = parseObject(entryRaw);
    // A genuine error array (objects without token/cost fields) is ignored.
    const hasUsage =
      "cost" in entry || "inputTokens" in entry || "outputTokens" in entry || "calls" in entry;
    if (!hasUsage) continue;
    const c = asNumber(entry.cost, NaN);
    if (!Number.isNaN(c)) {
      cost += c;
      sawCost = true;
    }
    target.inputTokens += asNumber(entry.inputTokens, asNumber(entry.input_tokens, 0));
    target.cachedInputTokens += asNumber(
      entry.cacheInputTokens,
      asNumber(entry.cached_input_tokens, 0),
    );
    target.outputTokens += asNumber(entry.outputTokens, asNumber(entry.output_tokens, 0));
  }
  return sawCost ? cost : null;
}

export function parseJunieJsonStream(stdout) {
  let sessionId = null;
  const messages = [];
  let lastFinalText = null;
  let errorMessage = null;
  let costUsd = null;
  let resultEvent = null;
  let question = null;
  let sawJson = false;
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  for (const rawLine of (stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || (line[0] !== "{" && line[0] !== "[")) continue;
    const event = parseJson(line);
    if (!event || typeof event !== "object") continue;
    sawJson = true;

    const found = readSessionId(event);
    if (found) sessionId = found;

    if (event.usage || event.usageMetadata || event.stats) {
      accumulateUsage(usage, event.usage ?? event.usageMetadata ?? event.stats);
    }
    const c = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, NaN)));
    if (!Number.isNaN(c)) costUsd = c;

    // Per-model usage/cost breakdown array (Junie ships it under `errorCode`;
    // accept saner spellings too). Summed cost wins over any scalar `cost`.
    for (const key of ["errorCode", "costs", "models", "usageBreakdown"]) {
      const summed = accumulateModelBreakdown(usage, event[key]);
      if (summed != null) costUsd = (costUsd ?? 0) + summed;
    }

    const type = asString(event.type, "").trim().toLowerCase();
    const role = asString(event.role, "").trim().toLowerCase();

    // Errors.
    if (type === "error" || event.is_error === true || asString(event.status, "").toLowerCase() === "error") {
      const t = asErrorText(event.error ?? event.message ?? event.detail ?? event.result).trim();
      if (t) errorMessage = t;
      continue;
    }

    // Final/result events carry the canonical answer.
    if (type === "result" || type === "final" || type === "agent_finish" || type === "done") {
      resultEvent = event;
      const finalText = collectText(event.result ?? event.response ?? event.message ?? event.text);
      if (finalText.length) lastFinalText = finalText.join("\n");
      continue;
    }

    // Assistant / agent messages.
    if (
      type === "assistant" ||
      type === "assistant_message" ||
      type === "agent_message" ||
      type === "message" ||
      type === "text" ||
      role === "assistant" ||
      role === "agent"
    ) {
      // Skip pure user/system echoes.
      if (role === "user" || role === "system") continue;
      // Detect a structured question (HITL).
      const msgObj = parseObject(event.message ?? event);
      const content = Array.isArray(msgObj.content) ? msgObj.content : [];
      for (const partRaw of content) {
        const part = parseObject(partRaw);
        if (asString(part.type, "").trim() === "question") {
          question = {
            prompt: asString(part.prompt, "").trim(),
            choices: (Array.isArray(part.choices) ? part.choices : []).map((cr) => {
              const ch = parseObject(cr);
              return {
                key: asString(ch.key, "").trim(),
                label: asString(ch.label, "").trim(),
                description: asString(ch.description, "").trim() || undefined,
              };
            }),
          };
        }
      }
      messages.push(...collectText(event.message ?? event.content ?? event.text ?? event));
      continue;
    }
    // Unknown event type: ignore (tool_call, reasoning, content_block_*, etc.).
  }

  const summary = (lastFinalText && lastFinalText.trim()) || messages.join("\n\n").trim();

  return {
    sessionId,
    summary,
    usage,
    costUsd,
    errorMessage,
    resultEvent,
    question,
    sawJson,
  };
}

const JUNIE_AUTH_REQUIRED_RE =
  /(?:cannot\s+find\s+authorization|please\s+authenticate|not\s+authenticated|authentication\s+required|unauthorized|invalid\s+(?:credentials|token|api[_ ]?key)|api[_ ]?key\s+(?:required|missing|invalid)|login\s+required|not\s+logged\s+in)/i;

export function detectJunieAuthRequired(input) {
  const parsed = parseObject(input?.parsed);
  const haystack = [asErrorText(parsed.error ?? parsed.message), input?.stdout, input?.stderr]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { requiresAuth: haystack.some((l) => JUNIE_AUTH_REQUIRED_RE.test(l)) };
}
