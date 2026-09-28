import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("injects an external_directory allow rule by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig.theme).toBe("system");
    expect(runtimeConfig.permission).toBeUndefined();
    expect(runtimeConfig.permissions).toContainEqual({ action: "read", resource: "*", effect: "allow" });
    // The external_directory rule must be LAST: permissions are evaluated
    // last-match-wins, so it always overrides any earlier rule for the same action.
    expect((runtimeConfig.permissions as unknown[]).at(-1)).toEqual({
      action: "external_directory",
      resource: "*",
      effect: "allow",
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("converts a nested-object-form permission (per-pattern) into one rule per pattern", async () => {
    const configHome = await makeConfigHome({
      permission: {
        bash: { "git push*": "deny", "*": "allow" },
      },
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { permissions: unknown[] };
    // `bash` renames to `shell` in OpenCode V2.
    expect(runtimeConfig.permissions).toContainEqual({ action: "shell", resource: "git push*", effect: "deny" });
    expect(runtimeConfig.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" });
    expect(runtimeConfig.permissions.at(-1)).toEqual({
      action: "external_directory",
      resource: "*",
      effect: "allow",
    });
    await prepared.cleanup();
  });

  it("merges into an already V2-native permissions/providers config instead of reconverting", async () => {
    const configHome = await makeConfigHome({
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
      providers: {
        openrouter: { package: "@ai-sdk/openai-compatible", models: { "x/y": {} } },
      },
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { permission?: unknown; provider?: unknown; permissions: unknown[]; providers: Record<string, unknown> };
    expect(runtimeConfig.permission).toBeUndefined();
    expect(runtimeConfig.provider).toBeUndefined();
    expect(runtimeConfig.permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(runtimeConfig.permissions.at(-1)).toEqual({
      action: "external_directory",
      resource: "*",
      effect: "allow",
    });
    expect(runtimeConfig.providers.openrouter).toEqual({
      package: "@ai-sdk/openai-compatible",
      models: { "x/y": {} },
    });
    await prepared.cleanup();
  });

  it("merges custom providers from PAPERCLIP_OPENCODE_PROVIDERS into the config", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bifrost EU",
        options: {
          baseURL: "http://gateway.example.svc.cluster.local:8080/v1",
          apiKey: "{env:ANTHROPIC_API_KEY}",
        },
        models: { "example/model-a": { name: "Model A" } },
      },
    };

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    // OpenCode V2 renames provider `npm` -> `package` and `options` -> `settings`.
    expect(runtimeConfig).toMatchObject({
      providers: {
        bifrost: {
          package: "@ai-sdk/openai-compatible",
          name: "Bifrost EU",
          settings: {
            baseURL: "http://gateway.example.svc.cluster.local:8080/v1",
            apiKey: "{env:ANTHROPIC_API_KEY}",
          },
          models: { "example/model-a": { name: "Model A" } },
        },
      },
    });
    expect(prepared.notes.some((n) => n.includes("bifrost"))).toBe(true);
    await prepared.cleanup();
  });

  it("reads PAPERCLIP_OPENCODE_PROVIDERS from process.env when absent from the run env", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { npm: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } };
    process.env.PAPERCLIP_OPENCODE_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await prepareOpenCodeRuntimeConfig({
        env: { XDG_CONFIG_HOME: configHome },
        config: {},
      });
      cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({
        providers: { bifrost: { package: "@ai-sdk/openai-compatible", models: { "example/model-a": {} } } },
      });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_OPENCODE_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders in custom providers using the run/process env (bakes the literal vk)", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      bifrost: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://bifrost/v1", apiKey: "{env:ANTHROPIC_API_KEY}" },
        models: { "example/model-a": {} },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers), ANTHROPIC_API_KEY: "sk-bf-REALVK" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { providers: { bifrost: { settings: { apiKey: string } } } };
    // The {env:...} placeholder must be replaced with the literal value, so OpenCode
    // does not depend on its sandboxed process env carrying the key.
    expect(runtimeConfig.providers.bifrost.settings.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = { bifrost: { options: { apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}" }, models: { "x/y": {} } } };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers) },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { providers: { bifrost: { settings: { apiKey: string } } } };
    expect(runtimeConfig.providers.bifrost.settings.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("pins small_model from PAPERCLIP_OPENCODE_SMALL_MODEL", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_SMALL_MODEL: "example/model-a" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { small_model?: string };
    expect(runtimeConfig.small_model).toBe("example/model-a");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_OPENCODE_PROVIDERS without writing a providers block and surfaces a note", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "not json" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.providers).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_OPENCODE_PROVIDERS is valid JSON but not an object", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome, PAPERCLIP_OPENCODE_PROVIDERS: "[1,2,3]" },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.providers).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries with non-object values and keeps the usable ones", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
          bifrost: "http://gateway.example/v1",
          usable: { options: { baseURL: "http://gateway.example/v1" } },
        }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { providers?: Record<string, unknown> };
    expect(runtimeConfig.providers?.usable).toBeDefined();
    expect(runtimeConfig.providers?.bifrost).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("surfaces skipped provider entries when no usable entries remain", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({ bifrost: "http://gateway.example/v1" }),
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.providers).toBeUndefined();
    expect(prepared.notes).toContain(
      "PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: bifrost.",
    );
    await prepared.cleanup();
  });

  it("registers a configured model missing from the catalog on its provider", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { providers?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.providers?.openrouter?.models).toEqual({
      "openai/gpt-oss-120b:nitro": {},
    });
    expect(prepared.notes).toContain(
      "Registered configured model openrouter/openai/gpt-oss-120b:nitro in the runtime OpenCode config.",
    );
    await prepared.cleanup();
  });

  it("does not clobber an explicit model definition when registering the configured model", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const providers = {
      openrouter: {
        models: {
          "openai/gpt-oss-120b:nitro": { name: "GPT-OSS 120B (nitro)" },
          "example/other": {},
        },
      },
    };
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify(providers),
      },
      config: { model: "openrouter/openai/gpt-oss-120b:nitro" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as { providers?: Record<string, { models?: Record<string, unknown> }> };
    expect(runtimeConfig.providers?.openrouter?.models).toEqual(providers.openrouter.models);
    expect(
      prepared.notes.some((note) => note.startsWith("Registered configured model")),
    ).toBe(false);
    await prepared.cleanup();
  });

  it("skips model registration when the configured model is not provider/model shaped", async () => {
    const configHome = await makeConfigHome({ permission: { read: "allow" } });
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { model: "not-a-provider-model" },
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtimeConfig.providers).toBeUndefined();
    await prepared.cleanup();
  });

  it("copies the config when the opencode config dir is a symlink", async () => {
    const realHome = await makeConfigHome({ theme: "system" });
    const linkHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
    cleanupPaths.add(linkHome);
    await fs.symlink(path.join(realHome, "opencode"), path.join(linkHome, "opencode"));

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: linkHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({ theme: "system" });
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });
});
