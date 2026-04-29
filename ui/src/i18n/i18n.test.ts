// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "./index";
import { NAMESPACES } from "./resources";

describe("i18n bootstrap", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await new Promise<void>((resolve) => i18n.on("initialized", () => resolve()));
    }
  });

  it("declares all namespaces", () => {
    expect(i18n.options.ns).toEqual([...NAMESPACES]);
  });

  it("has english fallback", () => {
    expect(i18n.options.fallbackLng).toEqual(expect.arrayContaining(["en"]));
  });

  it("loads known english key", async () => {
    await i18n.loadNamespaces("common");
    expect(i18n.exists("common:loading", { lng: "en" })).toBe(true);
  });
});
