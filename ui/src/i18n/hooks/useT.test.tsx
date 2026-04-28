// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import i18next, { type InitOptions, type ResourceLanguage, type i18n as I18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { NAMESPACES, bundledResources } from "../resources";
import { useT } from "./useT";

const DEBUG_KEY = "paperclip.i18n.debug";
const TRANSLATED_KEY = "executionWorkspaceDetail.advancedRuntimeJson";
const TRANSLATED_FR = "JSON runtime avancé";
const MISSING_KEY = "_useTtest.totallyMissingKeyXyz";

let testI18n: I18n;
let EN_ONLY_KEY = "";
let EN_ONLY_VALUE = "";

function Harness({ keyName }: { keyName: string }) {
  const { t } = useT();
  return <div data-testid="value">{t(keyName)}</div>;
}

beforeAll(async () => {
  testI18n = i18next.createInstance();
  const options: InitOptions = {
    lng: "fr-FR",
    fallbackLng: "en",
    supportedLngs: ["en", "fr-FR"],
    ns: [...NAMESPACES],
    defaultNS: "core",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: {
      en: bundledResources.en as ResourceLanguage,
      "fr-FR": bundledResources["fr-FR"] as ResourceLanguage,
    },
  };
  await testI18n.use(initReactI18next).init(options);

  const enCore = bundledResources.en.core as Record<string, string>;
  const frCore = bundledResources["fr-FR"].core as Record<string, string>;
  const fallbackCandidate = Object.keys(enCore).find((k) => !(k in frCore));
  if (!fallbackCandidate) {
    throw new Error("Expected at least one EN-only key in core namespace for fallback test.");
  }
  EN_ONLY_KEY = fallbackCandidate;
  EN_ONLY_VALUE = enCore[fallbackCandidate];
}, 30000);

afterEach(() => {
  window.localStorage.removeItem(DEBUG_KEY);
  cleanup();
});

function renderHarness(keyName: string) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <Harness keyName={keyName} />
    </I18nextProvider>
  );
}

describe("useT", () => {
  it("returns plain string when debug is disabled", () => {
    const { container } = renderHarness(TRANSLATED_KEY);
    expect(container.querySelector("[data-testid=value]")?.textContent).toBe(TRANSLATED_FR);
    expect(container.querySelector("[data-i18n-key]")).toBeNull();
  });

  describe("debug mode", () => {
    beforeEach(() => {
      window.localStorage.setItem(DEBUG_KEY, "1");
    });

    it("marks translated state", () => {
      const { container } = renderHarness(TRANSLATED_KEY);
      const el = container.querySelector(`[data-i18n-key="${TRANSLATED_KEY}"]`);
      expect(el).not.toBeNull();
      expect(el?.getAttribute("data-i18n-state")).toBe("translated");
      expect(el?.getAttribute("data-i18n-lng")).toBe("fr-FR");
    });

    it("marks fallback-en state", () => {
      const { container } = renderHarness(EN_ONLY_KEY);
      const el = container.querySelector(`[data-i18n-key="${EN_ONLY_KEY}"]`);
      expect(el).not.toBeNull();
      expect(el?.getAttribute("data-i18n-state")).toBe("fallback-en");
      expect(el?.textContent).toBe(EN_ONLY_VALUE);
    });

    it("marks missing state", () => {
      const { container } = renderHarness(MISSING_KEY);
      const el = container.querySelector(`[data-i18n-key="${MISSING_KEY}"]`);
      expect(el).not.toBeNull();
      expect(el?.getAttribute("data-i18n-state")).toBe("missing");
    });
  });
});
