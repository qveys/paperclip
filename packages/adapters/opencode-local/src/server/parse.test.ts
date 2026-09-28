import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });

  // Captured from a real OpenCode V2 run (`opencode run --standalone --format
  // json`, resumed session); local filesystem paths trimmed to "/workspace".
  // V2's JSONL event shape is unchanged from V1, so this pins that assumption.
  it("parses a real OpenCode V2 run capture: session id, summary, and usage from step_finish", () => {
    const stdout = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1790568877851,
        sessionID: "ses_f19c93a8affesVykODrJx21cOL",
        part: { type: "step-start" },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1790568889890,
        sessionID: "ses_f19c93a8affesVykODrJx21cOL",
        part: {
          type: "text",
          text: "I'll list the contents of the current directory to complete the pending file listing.",
        },
      }),
      JSON.stringify({
        type: "tool_use",
        timestamp: 1790568890188,
        sessionID: "ses_f19c93a8affesVykODrJx21cOL",
        part: {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/workspace" },
            output: "Read directory /workspace, entries 1-2\n.git/\nfile.txt",
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1790568890226,
        sessionID: "ses_f19c93a8affesVykODrJx21cOL",
        part: {
          type: "step-finish",
          reason: "tool-calls",
          cost: 0,
          tokens: {
            input: 1286,
            output: 116,
            reasoning: 830,
            cache: { read: 7665, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "step_start",
        timestamp: 1790568891206,
        sessionID: "ses_f19c93a8affesVykODrJx21cOL",
        part: { type: "step-start" },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1790568895552,
        sessionID: "ses_f19c93a8affesVykODrJx21cOL",
        part: { type: "text", text: "PONG2" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("ses_f19c93a8affesVykODrJx21cOL");
    expect(parsed.summary).toBe(
      "I'll list the contents of the current directory to complete the pending file listing.\n\nPONG2",
    );
    expect(parsed.usage).toEqual({
      inputTokens: 1286,
      cachedInputTokens: 7665,
      outputTokens: 946,
    });
    expect(parsed.costUsd).toBe(0);
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual([]);
  });

  // Captured from a real OpenCode V2 resume against an unknown/expired session.
  it("parses a real OpenCode V2 unknown-session-resume capture", () => {
    const stdout = JSON.stringify({
      type: "error",
      timestamp: 1790568906026,
      sessionID: "",
      error: { type: "unknown", message: "Session not found" },
    });

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBeNull();
    expect(parsed.errorMessage).toBe("Session not found");
    expect(isOpenCodeUnknownSessionError(stdout, "")).toBe(true);
  });
});
