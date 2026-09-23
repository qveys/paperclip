import { describe, expect, it } from "vitest";
import { validateInstanceConfig } from "../services/plugin-config-validator.ts";

describe("validateInstanceConfig", () => {
  const schema = {
    type: "object",
    properties: { apiKey: { type: "string", format: "secret-ref" } },
  };
  const secretId = "11111111-1111-1111-1111-111111111111";

  it("accepts a secret_ref binding object for a string secret-ref field", () => {
    const config = { apiKey: { type: "secret_ref", secretId, version: "latest" } };
    expect(validateInstanceConfig(config, schema)).toEqual({ valid: true });
    // The caller's config is not rewritten.
    expect(config.apiKey).toEqual({ type: "secret_ref", secretId, version: "latest" });
  });

  it("still rejects a non-binding object", () => {
    expect(validateInstanceConfig({ apiKey: { foo: 1 } }, schema).valid).toBe(false);
  });
});
