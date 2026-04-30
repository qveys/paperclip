// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import i18next, { type i18n as I18n, type ResourceLanguage } from "i18next";
import { initReactI18next } from "react-i18next";
import { NAMESPACES, SUPPORTED_LANGUAGES, bundledResources } from "./resources";

// Build a hermetic instance with bundled EN resources rather than importing
// the production singleton — that one wires up HttpBackend, ChainedBackend
// and LanguageDetector, which fail or behave non-deterministically in jsdom.
let testI18n: I18n;

beforeAll(async () => {
  testI18n = i18next.createInstance();
  await testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: [...NAMESPACES],
    defaultNS: "core",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: { en: bundledResources.en as ResourceLanguage },
  });
});

describe("i18n bootstrap", () => {
  it("declares all namespaces", () => {
    expect(testI18n.options.ns).toEqual([...NAMESPACES]);
  });

  it("has english fallback", () => {
    expect(testI18n.options.fallbackLng).toEqual(expect.arrayContaining(["en"]));
  });

  it("loads known english key", async () => {
    await testI18n.loadNamespaces("common");
    expect(testI18n.exists("common:loading", { lng: "en" })).toBe(true);
  });
});
