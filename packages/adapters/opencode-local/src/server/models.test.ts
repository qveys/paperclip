import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// `opencode serve` prints "server password <PASS>" to stdout once ready.
function printsPassword(password: string) {
  return () => {
    const child = fakeChild();
    setTimeout(() => child.stdout.emit("data", Buffer.from(`server password ${password}\n`)), 0);
    return child;
  };
}

function failsToStart(reason: "error" | "exit") {
  return () => {
    const child = fakeChild();
    setTimeout(() => {
      if (reason === "error") child.emit("error", new Error("spawn ENOENT"));
      else child.emit("exit", 1);
    }, 0);
    return child;
  };
}

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe(
      "openai/gpt-5.2-codex",
    );
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
      },
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/gateway/some-model",
      }),
    ).resolves.toEqual([
      { id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" },
    ]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("discovers models via a transient `opencode serve` instance", async () => {
    spawnMock.mockImplementationOnce(printsPassword("secret-pw"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: { headers: Record<string, string> }) => {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/model$/);
        expect(opts.headers.Authorization).toBe(
          `Basic ${Buffer.from("opencode:secret-pw").toString("base64")}`,
        );
        return {
          ok: true,
          json: async () => ({
            data: [
              { providerID: "google", modelID: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { providerID: "google", modelID: "gemini-3.8-flash" }, // duplicate id -> deduped
            ],
          }),
        };
      }),
    );

    await expect(discoverOpenCodeModels()).resolves.toEqual([
      { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ]);
    const child = spawnMock.mock.results[0]!.value as FakeChild;
    expect(child.kill).toHaveBeenCalled();
  });

  it("polls until the catalog populates, then stops", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementationOnce(printsPassword("pw"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ providerID: "openai", modelID: "gpt-5" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const promise = discoverOpenCodeModels();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns an empty list when the catalog never populates before the poll deadline (not an error, no retry)", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementationOnce(printsPassword("pw"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );

    const promise = discoverOpenCodeModels();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient `opencode serve` startup failure with backoff before succeeding", async () => {
    vi.useFakeTimers();
    spawnMock
      .mockImplementationOnce(failsToStart("error"))
      .mockImplementationOnce(failsToStart("exit"))
      .mockImplementationOnce(printsPassword("pw"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ providerID: "ollama", modelID: "qwen2.5-coder:7b" }] }),
      }),
    );

    const promise = discoverOpenCodeModels();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([
      { id: "ollama/qwen2.5-coder:7b", label: "ollama/qwen2.5-coder:7b" },
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces the last error once retries are exhausted", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(failsToStart("exit"));

    const promise = discoverOpenCodeModels();
    const assertion = expect(promise).rejects.toThrow("before printing its password");
    await vi.runAllTimersAsync();
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(failsToStart("error"));

    const promise = listOpenCodeModels();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
  });

  it("proceeds with the configured model when discovery cannot run (probe is best-effort, never fatal)", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(failsToStart("error"));

    const promise = ensureOpenCodeModelConfiguredAndAvailable({ model: "openai/gpt-5" });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
  });

  it("refreshes a stale non-empty catalog before accepting the configured model", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(printsPassword("pw"));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // initial discoverOpenCodeModelsCached call
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ providerID: "openrouter", modelID: "example/stale-model" }] }),
        })
        // refreshOpenCodeModelsCached's first (discarded, refresh:true) call
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ providerID: "openrouter", modelID: "example/stale-model" }] }),
        })
        // refreshOpenCodeModelsCached's second (authoritative) call
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [
              { providerID: "openrouter", modelID: "example/current-model" },
              { providerID: "openrouter", modelID: "deepseek/deepseek-v4-flash-0731" },
            ],
          }),
        }),
    );

    const promise = ensureOpenCodeModelConfiguredAndAvailable({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("still rejects when a refreshed catalog omits the configured model", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(printsPassword("pw"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ providerID: "openrouter", modelID: "example/stale-model" }] }),
      }),
    );

    const promise = ensureOpenCodeModelConfiguredAndAvailable({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    // Attach the rejection assertion before advancing fake timers, so the
    // rejection is never briefly unhandled (matches the pattern below).
    const assertion = expect(promise).rejects.toThrow(
      "Configured OpenCode model is unavailable: openrouter/deepseek/deepseek-v4-flash-0731",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("still rejects from the original catalog when refresh fails", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    // First spawn (the initial cached discovery) succeeds; every spawn after
    // that (the refresh's own retried attempts) fails, exhausting
    // discoverOpenCodeModels's retry loop and making the refresh itself throw.
    spawnMock.mockImplementationOnce(printsPassword("pw"));
    spawnMock.mockImplementation(failsToStart("error"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ providerID: "openrouter", modelID: "example/stale-model" }] }),
      }),
    );

    const promise = ensureOpenCodeModelConfiguredAndAvailable({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    const assertion = expect(promise).rejects.toThrow(
      "Available models: openrouter/example/stale-model",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'refresh failed for "openrouter/deepseek/deepseek-v4-flash-0731"',
      ),
    );
  });
});
