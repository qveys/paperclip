import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QVEYS_AGENT_ROUTER_STICKY = join(tmpdir(), "qveys-agent-router-test-sticky-" + process.pid + ".json");
process.env.QVEYS_AGENT_ROUTER_STREAM_KEEPALIVE_MS = "50";
const { parseScalar, parseYaml, classify, decide, isNonTerminalPreamble, makeServer } = await import("../router.mjs");

const config = parseYaml(`
server:
  stickyTtlMs: 1000
omniroute:
  profiles:
    fast: auto/fast
    coding: auto/coding
    reasoning: auto/reasoning
routing:
  default:
    runtime: hermes
    profile: fast
    fallback: [claude]
  categories:
    coding:
      runtime: codex
      profile: coding
      fallback: [claude, hermes]
    analysis:
      runtime: claude
      profile: reasoning
      fallback: [codex]
`);

test("classifies into the fixed category set", () => {
  assert.equal(classify({ prompt: "Fix the Docker build and add tests" }).category, "coding");
  assert.equal(classify({ prompt: "Summarize this long thread" }).category, "summarization");
});

test("decides runtime, profile and fallback from YAML policy", () => {
  const d = decide({ taskId: "T1", prompt: "Fix the API test" }, config, 1);
  assert.equal(d.category, "coding");
  assert.equal(d.runtime, "codex");
  assert.equal(d.profile, "coding");
  assert.deepEqual(d.fallback, ["codex", "claude", "hermes"]);
});

test("keeps sticky runtime for the same task", () => {
  const d = decide({ taskId: "T1", prompt: "Analyse the result" }, config, 2);
  assert.equal(d.runtime, "codex");
  assert.equal(d.sticky, true);
});

test("classifies empty Paperclip heartbeat as background", () => {
  const d = decide({ hasTask: false, prompt: "Heartbeat wake — check for work" }, config, 10000);
  assert.equal(d.category, "background");
});

test("keeps sticky runtime for a session heartbeat", () => {
  const initial = decide({ taskId: "ISSUE1", prompt: "Fix the API test" }, config, 20000);
  assert.equal(initial.runtime, "codex");

  const heartbeat = decide({ hasTask: false, runId: "RUN2", sessionId: "ISSUE1", prompt: "Heartbeat wake — check for work" }, config, 20001);
  assert.equal(heartbeat.category, "background");
  assert.equal(heartbeat.runtime, "codex");
  assert.equal(heartbeat.profile, "coding");
  assert.equal(heartbeat.sticky, true);
});

test("rejects a blocked Codex response even when the process exits zero", () => {
  assert.equal(isNonTerminalPreamble(
    "OK",
    "bwrap: No permissions to create new namespace",
  ), true);
  assert.equal(isNonTerminalPreamble("Impossible de traiter le ticket: les outils MCP ne sont pas exposés."), true);
});

test("route stream emits keepalive while runtime is silent", async (t) => {
  const server = makeServer({
    omniroute: { profiles: { fast: "auto/fast" } },
    routing: { default: { runtime: "node", profile: "fast", fallback: ["node"] } },
    runtimes: { node: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 250)"], timeoutMs: 1000 } },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/route/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "silent" }),
  });
  assert.equal(res.status, 200);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  let buffer = "";
  while (!seen.includes("keepalive")) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) seen.push(JSON.parse(line).type);
  }
  await reader.cancel();

  assert.ok(seen.includes("decision"));
  assert.ok(seen.includes("keepalive"));
});

test("parses commas inside a quoted runtime argument", () => {
  assert.deepEqual(parseScalar('["-c", "mcp.env_vars=[\\\"A\\\",\\\"B\\\"]"]'), ["-c", 'mcp.env_vars=["A","B"]']);
});
